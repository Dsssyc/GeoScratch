import { UUID } from '../core/utils/uuid.js'
import { isBindLayout } from './binding.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { isLayoutArtifact } from './layout-codec.js'
import { createScratchNativeLabel } from './native-allocation.js'
import {
    createShaderModuleCompilationReport,
    snapshotShaderModuleSource,
} from './pipeline-compilation.js'
import { createPipelineNativeErrorSerializer } from './pipeline-native-error.js'
import {
    assertScratchRuntimeActive,
    assertScratchRuntimeAuthority,
    captureScratchRuntimeAuthority,
} from './runtime-authority.js'
import {
    registerShaderModuleOwnership,
    unregisterShaderModuleOwnership,
} from './shader-module-ownership.js'
import { throwSupportingObjectCreationFailure } from './supporting-object-failure.js'
import {
    beginSupportingObjectCreation,
    recheckSupportingObjectLifecycle,
} from './supporting-object-creation.js'
import { describeValue, isRecord } from './type-utils.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { BindLayout } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact } from './layout-codec.js'
import type {
    ShaderModuleCompilationReport,
    ShaderModuleSourceSnapshot,
} from './pipeline-compilation.js'
import type { ScratchRuntime } from './runtime.js'

const shaderModuleToken = Symbol('ShaderModule')
const SHADER_MODULE_CREATION_CODES = Object.freeze({
    validation: 'SCRATCH_SHADER_MODULE_CREATION_VALIDATION_FAILED',
    internal: 'SCRATCH_SHADER_MODULE_CREATION_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_SHADER_MODULE_CREATION_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_SHADER_MODULE_CREATION_NATIVE_FAILED',
})
const SHADER_MODULE_COMPILATION_INFO_CODES = Object.freeze({
    validation: 'SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED',
    internal: 'SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED',
    outOfMemory: 'SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED',
    nativeException: 'SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED',
})
const SHADER_MODULE_COMPILATION_CODES = Object.freeze({
    validation: 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED',
    internal: 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED',
    outOfMemory: 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED',
    nativeException: 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED',
})
const shaderModuleStates = new WeakMap<ShaderModule, {
    isDisposed: boolean
    sourceSnapshot: ShaderModuleSourceSnapshot
}>()

export type ShaderModuleSourcePart = Readonly<{
    label?: string
    code: string
    layoutDependencies?: readonly LayoutArtifact[]
}>

export type ShaderModuleCompilationHintLayout = Readonly<{
    bindLayouts?: readonly BindLayout[]
    immediateSize?: number
}>

export type ShaderModuleCompilationHint = Readonly<{
    entryPoint: string
    layout?: 'auto' | ShaderModuleCompilationHintLayout
}>

export type ShaderModuleDescriptor = Readonly<{
    label?: string
    sourceParts: readonly ShaderModuleSourcePart[]
    compilationHints?: readonly ShaderModuleCompilationHint[]
}>

export type NormalizedShaderModuleSourcePart = Readonly<{
    label?: string
    code: string
    hash: string
    layoutDependencies: readonly LayoutArtifact[]
}>

export type ShaderModuleCompilationHintFact = Readonly<{
    entryPoint: string
    layout?: 'auto' | Readonly<{
        bindLayoutIds: readonly string[]
        immediateSize: number
    }>
}>

export interface ShaderModule {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly sourceParts: readonly NormalizedShaderModuleSourcePart[]
    readonly compilationHints: readonly ShaderModuleCompilationHintFact[]
    readonly compilationReport: ShaderModuleCompilationReport
    readonly gpuShaderModule: GPUShaderModule
}

export class ShaderModule {

    private constructor(token: symbol, state?: Readonly<{
        runtime: ScratchRuntime
        id: string
        label?: string
        sourceParts: readonly NormalizedShaderModuleSourcePart[]
        sourceSnapshot: ShaderModuleSourceSnapshot
        compilationHints: readonly ShaderModuleCompilationHintFact[]
        compilationReport: ShaderModuleCompilationReport
        gpuShaderModule: GPUShaderModule
    }>) {

        if (token !== shaderModuleToken || state === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SHADER_MODULE_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'program',
                subject: { kind: 'ShaderModule' },
                message: 'ShaderModule is created only by ScratchRuntime.',
                hints: [ 'Use await runtime.createShaderModule(descriptor).' ],
            })
        }

        shaderModuleStates.set(this, {
            isDisposed: false,
            sourceSnapshot: state.sourceSnapshot,
        })
        Object.defineProperties(this, {
            runtime: immutableEnumerableProperty(state.runtime),
            id: immutableEnumerableProperty(state.id),
            sourceParts: immutableEnumerableProperty(state.sourceParts),
            compilationHints: immutableEnumerableProperty(state.compilationHints),
            compilationReport: immutableEnumerableProperty(state.compilationReport),
            gpuShaderModule: immutableEnumerableProperty(state.gpuShaderModule),
            ...(state.label !== undefined
                ? { label: immutableEnumerableProperty(state.label) }
                : {}),
        })
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return shaderModuleStateFor(this).isDisposed
    }

    get subject(): DiagnosticSubject {

        return shaderModuleSubject(this)
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return

        throwScratchDiagnostic({
            code: 'SCRATCH_SHADER_MODULE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'program',
            subject: this.subject,
            related: [ this.runtime.subject, runtime?.subject ].filter(Boolean),
            message: 'ShaderModule belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime?.id },
        })
    }

    assertUsable(): void {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SHADER_MODULE_DISPOSED',
                severity: 'error',
                phase: 'program',
                subject: this.subject,
                message: 'ShaderModule has been disposed.',
            })
        }
        assertScratchRuntimeActive(this.runtime)
    }

    dispose(): void {

        const state = shaderModuleStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        unregisterShaderModuleOwnership(this)
    }
}

export function isShaderModule(value: unknown): value is ShaderModule {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === ShaderModule.prototype &&
        shaderModuleStates.has(value as ShaderModule)
}

export function shaderModuleSourceSnapshot(
    shaderModule: ShaderModule
): ShaderModuleSourceSnapshot {

    shaderModule.assertUsable()
    return shaderModuleStateFor(shaderModule).sourceSnapshot
}

export async function createShaderModule(
    runtime: ScratchRuntime,
    descriptor: ShaderModuleDescriptor
): Promise<ShaderModule> {

    const runtimeAuthority = captureScratchRuntimeAuthority(runtime)
    const id = `scratch-shader-module-${UUID()}`
    const normalized = normalizeShaderModuleDescriptor(runtime, id, descriptor)
    assertScratchRuntimeAuthority(runtimeAuthority)
    const sourceSnapshot = snapshotShaderModuleSource({
        id,
        sourceParts: normalized.sourceParts,
    })
    const nativeLabel = createScratchNativeLabel(normalized.label, id)
    const controller = diagnosticsControllerFor(runtime)
    const operation = controller.beginOperation({
        kind: 'shader-module-creation',
        target: {
            kind: 'shader-module',
            shaderModuleId: id,
            sourceHash: sourceSnapshot.sourceHash,
            sourcePartCount: sourceSnapshot.sourcePartFacts.length,
            compilationHintCount: normalized.compilationHints.length,
        },
        descriptorSummary: {
            sourceHash: sourceSnapshot.sourceHash,
            sourcePartCount: sourceSnapshot.sourcePartFacts.length,
            compilationHintCount: normalized.compilationHints.length,
        },
        fullDescriptor: {
            sourceHash: sourceSnapshot.sourceHash,
            sourceParts: sourceSnapshot.sourcePartFacts,
            compilationHints: normalized.compilationHints.map(hint => ({
                entryPoint: hint.entryPoint,
                ...(hint.layout === 'auto' ? { layout: 'auto' } : {}),
                ...(hint.layout !== undefined && hint.layout !== 'auto' ? {
                    layout: {
                        bindLayoutIds: hint.layout.bindLayouts.map(layout => layout.id),
                        immediateSize: hint.layout.immediateSize,
                    },
                } : {}),
            })),
        },
        nativeLabel,
    })
    const serializeNativeError = createPipelineNativeErrorSerializer(sourceSnapshot)
    const creation = beginSupportingObjectCreation(
        runtime,
        () => {
            const nativeHints = normalized.compilationHints.map((hint, index) => {
                if (hint.layout === undefined || hint.layout === 'auto') {
                    return {
                        entryPoint: hint.entryPoint,
                        ...(hint.layout !== undefined ? { layout: hint.layout } : {}),
                    }
                }
                const nativeLayout = runtime.device.createPipelineLayout({
                    label: `scratch:${id}:compilation-hint:${index}`,
                    bindGroupLayouts: nativeBindGroupLayouts(hint.layout.bindLayouts),
                    immediateSize: hint.layout.immediateSize,
                } as GPUPipelineLayoutDescriptor & { immediateSize: number })
                return {
                    entryPoint: hint.entryPoint,
                    layout: nativeLayout,
                }
            })
            const nativeDescriptor: GPUShaderModuleDescriptor = {
                label: nativeLabel,
                code: sourceSnapshot.combinedSource,
                ...(nativeHints.length > 0 ? { compilationHints: nativeHints } : {}),
            }
            return runtime.device.createShaderModule(nativeDescriptor)
        }
    )
    const compilation = creation.candidate === undefined
        ? Promise.resolve(undefined)
        : observeCompilationInfo(creation.candidate)
    const [ settledCreation, compilationInfo ] = await Promise.all([
        creation.settlement,
        compilation,
    ])
    const outcome = recheckSupportingObjectLifecycle(runtime, settledCreation)

    if (outcome.failures.length > 0 || outcome.candidate === undefined) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            outcome,
            SHADER_MODULE_CREATION_CODES,
            {
                operationName: 'ShaderModule creation',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                serializeNativeError,
            }
        )
    }
    if (compilationInfo === undefined) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ {
                    kind: 'native-exception',
                    cause: new TypeError(
                        'GPUShaderModule compilation information is unavailable.'
                    ),
                } ],
            },
            SHADER_MODULE_COMPILATION_INFO_CODES,
            {
                operationName: 'ShaderModule compilation information acknowledgement',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                failureStage: 'compilation-info',
                serializeNativeError,
            }
        )
    }
    if ('failure' in compilationInfo) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ {
                    kind: 'native-exception',
                    cause: compilationInfo.failure,
                } ],
            },
            SHADER_MODULE_COMPILATION_INFO_CODES,
            {
                operationName: 'ShaderModule compilation information acknowledgement',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                failureStage: 'compilation-info',
                serializeNativeError,
            }
        )
    }

    let compilationReport: ShaderModuleCompilationReport
    try {
        compilationReport = createShaderModuleCompilationReport({
            shaderModuleId: id,
            sourceSnapshot,
            compilationInfo: compilationInfo.value,
        })
    } catch (cause) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ { kind: 'native-exception', cause } ],
            },
            SHADER_MODULE_COMPILATION_INFO_CODES,
            {
                operationName: 'ShaderModule compilation report creation',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                failureStage: 'compilation-info',
                serializeNativeError,
            }
        )
    }
    if (compilationReport.errorCount > 0) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ { kind: 'validation' } ],
            },
            SHADER_MODULE_COMPILATION_CODES,
            {
                operationName: 'ShaderModule compilation',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                failureStage: 'shader-compilation',
                serializeNativeError,
                shaderModuleCompilationReport: compilationReport,
            }
        )
    }

    const sourceParts = Object.freeze(normalized.sourceParts.map((part, index) => Object.freeze({
        ...(part.label !== undefined ? { label: part.label } : {}),
        code: part.code,
        hash: sourceSnapshot.sourcePartFacts[index].hash,
        layoutDependencies: part.layoutDependencies,
    })))
    const Constructor = ShaderModule as unknown as new (
        token: symbol,
        state: Readonly<{
            runtime: ScratchRuntime
            id: string
            label?: string
            sourceParts: readonly NormalizedShaderModuleSourcePart[]
        sourceSnapshot: ShaderModuleSourceSnapshot
        compilationHints: readonly ShaderModuleCompilationHintFact[]
        compilationReport: ShaderModuleCompilationReport
            gpuShaderModule: GPUShaderModule
        }>
    ) => ShaderModule
    let shaderModule: ShaderModule
    try {
        shaderModule = new Constructor(shaderModuleToken, {
            runtime,
            id,
            ...(normalized.label !== undefined ? { label: normalized.label } : {}),
            sourceParts,
            sourceSnapshot,
            compilationHints: Object.freeze(normalized.compilationHints.map(hint =>
                Object.freeze({
                    entryPoint: hint.entryPoint,
                    ...(hint.layout === 'auto' ? { layout: 'auto' as const } : {}),
                    ...(hint.layout !== undefined && hint.layout !== 'auto' ? {
                        layout: Object.freeze({
                            bindLayoutIds: Object.freeze(
                                hint.layout.bindLayouts.map(layout => layout.id)
                            ),
                            immediateSize: hint.layout.immediateSize,
                        }),
                    } : {}),
                })
            )),
            compilationReport,
            gpuShaderModule: outcome.candidate,
        })
        registerShaderModuleOwnership(shaderModule)
    } catch (cause) {
        return throwSupportingObjectCreationFailure(
            runtime,
            operation,
            {
                candidate: outcome.candidate,
                failures: [ { kind: 'native-exception', cause } ],
            },
            SHADER_MODULE_CREATION_CODES,
            {
                operationName: 'ShaderModule publication',
                phase: 'program',
                subject: shaderModuleSubjectFrom(id, normalized.label),
                serializeNativeError,
            }
        )
    }
    controller.completeOperation(operation, { status: 'succeeded' })
    return shaderModule
}

function normalizeShaderModuleDescriptor(
    runtime: ScratchRuntime,
    id: string,
    descriptor: unknown
): Readonly<{
    label?: string
    sourceParts: readonly Readonly<{
        label?: string
        code: string
        layoutDependencies: readonly LayoutArtifact[]
    }>[]
    compilationHints: readonly Readonly<{
        entryPoint: string
        layout?: 'auto' | Readonly<{
            bindLayouts: readonly BindLayout[]
            immediateSize: number
        }>
    }>[]
}> {

    const subject = shaderModuleSubjectFrom(id)
    if (!isRecord(descriptor)) {
        throwShaderModuleDescriptorInvalid(subject, 'descriptor', descriptor)
    }
    if (descriptor.label !== undefined && typeof descriptor.label !== 'string') {
        throwShaderModuleDescriptorInvalid(subject, 'label', descriptor.label)
    }
    if (!Array.isArray(descriptor.sourceParts) || descriptor.sourceParts.length === 0) {
        throwShaderModuleDescriptorInvalid(subject, 'sourceParts', descriptor.sourceParts)
    }
    const sourceParts = descriptor.sourceParts.map((sourcePart, index) => {
        if (!isRecord(sourcePart)) {
            throwShaderModuleDescriptorInvalid(subject, `sourceParts[${index}]`, sourcePart)
        }
        if (sourcePart.label !== undefined && typeof sourcePart.label !== 'string') {
            throwShaderModuleDescriptorInvalid(
                subject,
                `sourceParts[${index}].label`,
                sourcePart.label
            )
        }
        if (typeof sourcePart.code !== 'string' || sourcePart.code.length === 0) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `sourceParts[${index}].code`,
                sourcePart.code
            )
        }
        const dependencies = sourcePart.layoutDependencies
        if (
            dependencies !== undefined &&
            (
                !Array.isArray(dependencies) ||
                !dependencies.every(isLayoutArtifact)
            )
        ) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `sourceParts[${index}].layoutDependencies`,
                dependencies
            )
        }
        return Object.freeze({
            ...(sourcePart.label !== undefined ? { label: sourcePart.label } : {}),
            code: sourcePart.code,
            layoutDependencies: Object.freeze([ ...(dependencies ?? []) ]),
        })
    })
    const compilationHints = normalizeCompilationHints(
        runtime,
        subject,
        descriptor.compilationHints
    )

    return Object.freeze({
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        sourceParts: Object.freeze(sourceParts),
        compilationHints,
    })
}

function normalizeCompilationHints(
    runtime: ScratchRuntime,
    subject: DiagnosticSubject,
    value: unknown
): readonly Readonly<{
    entryPoint: string
    layout?: 'auto' | Readonly<{
        bindLayouts: readonly BindLayout[]
        immediateSize: number
    }>
}>[] {

    if (value === undefined) return Object.freeze([])
    if (!Array.isArray(value)) {
        throwShaderModuleDescriptorInvalid(subject, 'compilationHints', value)
    }

    return Object.freeze(value.map((hint, index) => {
        if (!isRecord(hint)) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `compilationHints[${index}]`,
                hint
            )
        }
        if (typeof hint.entryPoint !== 'string' || hint.entryPoint.length === 0) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `compilationHints[${index}].entryPoint`,
                hint.entryPoint
            )
        }
        if (hint.layout === undefined || hint.layout === 'auto') {
            return Object.freeze({
                entryPoint: hint.entryPoint,
                ...(hint.layout !== undefined ? { layout: hint.layout } : {}),
            })
        }
        if (!isRecord(hint.layout)) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `compilationHints[${index}].layout`,
                hint.layout
            )
        }
        const bindLayouts = hint.layout.bindLayouts ?? []
        if (!Array.isArray(bindLayouts)) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `compilationHints[${index}].layout.bindLayouts`,
                bindLayouts
            )
        }
        const normalizedLayouts = bindLayouts.map((layout, layoutIndex) => {
            if (!isBindLayout(layout)) {
                throwShaderModuleDescriptorInvalid(
                    subject,
                    `compilationHints[${index}].layout.bindLayouts[${layoutIndex}]`,
                    layout
                )
            }
            layout.assertRuntime(runtime)
            return layout
        })
        assertUniqueLayoutGroups(
            subject,
            normalizedLayouts,
            `compilationHints[${index}].layout.bindLayouts`
        )
        const immediateSize = hint.layout.immediateSize ?? 0
        const maxImmediateSize = (
            runtime.deviceLimits as GPUSupportedLimits & {
                readonly maxImmediateSize?: number
            }
        ).maxImmediateSize ?? 0
        if (
            typeof immediateSize !== 'number' ||
            !Number.isSafeInteger(immediateSize) ||
            immediateSize < 0 ||
            immediateSize % 4 !== 0 ||
            immediateSize > maxImmediateSize
        ) {
            throwShaderModuleDescriptorInvalid(
                subject,
                `compilationHints[${index}].layout.immediateSize`,
                immediateSize
            )
        }
        return Object.freeze({
            entryPoint: hint.entryPoint,
            layout: Object.freeze({
                bindLayouts: Object.freeze(normalizedLayouts),
                immediateSize,
            }),
        })
    }))
}

function assertUniqueLayoutGroups(
    subject: DiagnosticSubject,
    layouts: readonly BindLayout[],
    field: string
): void {

    const groups = new Set<number>()
    for (const layout of layouts) {
        if (groups.has(layout.group)) {
            throwShaderModuleDescriptorInvalid(subject, field, layouts, 'duplicate group')
        }
        groups.add(layout.group)
    }
}

function nativeBindGroupLayouts(
    bindLayouts: readonly BindLayout[]
): readonly (GPUBindGroupLayout | null)[] {

    if (bindLayouts.length === 0) return []
    const nativeLayouts = Array<GPUBindGroupLayout | null>(
        Math.max(...bindLayouts.map(layout => layout.group)) + 1
    ).fill(null)
    for (const layout of bindLayouts) {
        nativeLayouts[layout.group] = layout.gpuBindGroupLayout
    }
    return nativeLayouts
}

async function observeCompilationInfo(shaderModule: GPUShaderModule): Promise<
    | Readonly<{ value: GPUCompilationInfo }>
    | Readonly<{ failure: unknown }>
> {

    try {
        if (typeof shaderModule.getCompilationInfo !== 'function') {
            throw new TypeError('GPUShaderModule.getCompilationInfo() is unavailable.')
        }
        const pending = shaderModule.getCompilationInfo()
        if (
            pending === null ||
            (
                typeof pending !== 'object' &&
                typeof pending !== 'function'
            ) ||
            typeof (pending as { then?: unknown }).then !== 'function'
        ) {
            throw new TypeError('GPUShaderModule.getCompilationInfo() did not return a Promise.')
        }
        return Object.freeze({ value: await pending })
    } catch (failure) {
        return Object.freeze({ failure })
    }
}

function throwShaderModuleDescriptorInvalid(
    subject: DiagnosticSubject,
    field: string,
    actual: unknown,
    reason?: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_SHADER_MODULE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'program',
        subject,
        message: 'ShaderModule descriptor is invalid.',
        expected: { field: 'valid ShaderModule descriptor value' },
        actual: {
            field,
            value: describeValue(actual),
            ...(reason !== undefined ? { reason } : {}),
        },
    })
}

function shaderModuleSubject(shaderModule: ShaderModule): DiagnosticSubject {

    return shaderModuleSubjectFrom(shaderModule.id, shaderModule.label)
}

function shaderModuleSubjectFrom(id: string, label?: string): DiagnosticSubject {

    return {
        kind: 'ShaderModule',
        id,
        ...(label !== undefined ? { label } : {}),
    }
}

function shaderModuleStateFor(shaderModule: ShaderModule): {
    isDisposed: boolean
    sourceSnapshot: ShaderModuleSourceSnapshot
} {

    const state = shaderModuleStates.get(shaderModule)
    if (state === undefined) throw new TypeError('ShaderModule private state is unavailable.')
    return state
}

function immutableEnumerableProperty<T>(value: T): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}

Object.freeze(ShaderModule.prototype)
