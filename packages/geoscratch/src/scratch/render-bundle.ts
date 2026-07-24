import { UUID } from '../core/utils/uuid.js'
import {
    assertCommandBufferGpuUseAvailable,
    assertCommandTemporalDependencies,
    DrawCommand,
    encodeDrawCommandInRenderBundle,
    snapshotCommandImmediateData,
} from './command.js'
import { throwScratchDiagnostic, isScratchDiagnosticError } from './diagnostics.js'
import {
    DebugCommand,
    isDebugCommand,
    validateBalancedDebugCommands,
} from './debug-command.js'
import { createScratchNativeLabel } from './native-allocation.js'
import { isRenderPassSpec, RenderPassSpec } from './pass.js'
import { renderPipelineLayoutFor } from './pipeline.js'
import {
    registerRenderBundleOwnership,
    unregisterRenderBundleOwnership,
} from './render-bundle-ownership.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { throwSupportingObjectCreationFailure } from './supporting-object-failure.js'
import {
    issueSupportingObjectCreation,
    recheckSupportingObjectLifecycle,
} from './supporting-object-creation.js'
import { isTextureViewSpec } from './texture.js'
import { describeValue, isRecord } from './type-utils.js'
import type {
    CommandBindSetInvocation,
    CommandImmediateData,
    CommandResourceAccessDescriptor,
    DrawCommandDescriptor,
    DrawCount,
    DrawIndexBufferBinding,
    DrawVertexBufferBinding,
    ResolvedCommandImmediateData,
} from './command.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { SurfaceTextureLeaseOwner, AttemptTextureAuthority } from './temporal-texture.js'
import type { BufferResource } from './buffer.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { TextureResource } from './texture.js'

const bundleDrawCommandToken = Symbol('BundleDrawCommand')
const bundleDrawCommandStates = new WeakMap<BundleDrawCommand, BundleDrawCommandState>()
const renderBundleToken = Symbol('RenderBundle')
const renderBundleStates = new WeakMap<RenderBundle, RenderBundleState>()
const executeRenderBundlesCommandToken = Symbol('ExecuteRenderBundlesCommand')
const executeRenderBundlesCommandStates = new WeakMap<
    ExecuteRenderBundlesCommand,
    { isDisposed: boolean }
>()

const DEPTH_FORMATS = new Set<GPUTextureFormat>([
    'depth16unorm',
    'depth24plus',
    'depth24plus-stencil8',
    'depth32float',
    'depth32float-stencil8',
])
const STENCIL_FORMATS = new Set<GPUTextureFormat>([
    'stencil8',
    'depth24plus-stencil8',
    'depth32float-stencil8',
])
const RENDER_BUNDLE_CREATION_CODES = Object.freeze({
    validation: 'SCRATCH_RENDER_BUNDLE_NATIVE_VALIDATION_FAILED',
    internal: 'SCRATCH_RENDER_BUNDLE_NATIVE_INTERNAL_FAILED',
    outOfMemory: 'SCRATCH_RENDER_BUNDLE_NATIVE_OUT_OF_MEMORY',
    nativeException: 'SCRATCH_RENDER_BUNDLE_NATIVE_CREATION_FAILED',
})

export type RenderBundleRealization = 'persistent' | 'attempt-local'
export type RenderBundleRealizationState = 'ready' | 'stale' | 'attempt-local' | 'disposed'

export type BundleDrawCommandDescriptor = DrawCommandDescriptor & Readonly<{
    renderState?: never
    fallback?: never
    whenMissing: 'throw'
}>

type BundleDrawCommandState = Readonly<{
    draw: DrawCommand
}>

export interface BundleDrawCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'bundle-draw'
    readonly pipeline: DrawCommand['pipeline']
    readonly immediateData?: CommandImmediateData
    readonly bindSets: readonly CommandBindSetInvocation[]
    readonly vertexBuffers: readonly Readonly<DrawVertexBufferBinding>[]
    readonly indexBuffer?: Readonly<DrawIndexBufferBinding>
    readonly count: Readonly<DrawCount>
    readonly resources: CommandResourceAccessDescriptor
    readonly whenMissing: 'throw'
    readonly isDisposed: boolean
}

export class BundleDrawCommand {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: BundleDrawCommandDescriptor
    ) {

        if (token !== bundleDrawCommandToken || new.target !== BundleDrawCommand) {
            throw new TypeError(
                'BundleDrawCommand must be created by ScratchRuntime.createBundleDrawCommand().'
            )
        }
        assertScratchRuntimeActive(runtime)
        normalizeBundleDrawDescriptor(runtime, descriptor)
        const draw = new DrawCommand(runtime, descriptor)
        bundleDrawCommandStates.set(this, Object.freeze({ draw }))
        Object.defineProperties(this, {
            runtime: immutableEnumerable(draw.runtime),
            id: immutableEnumerable(draw.id),
            ...(draw.label !== undefined ? { label: immutableEnumerable(draw.label) } : {}),
            commandKind: immutableEnumerable('bundle-draw'),
            pipeline: immutableEnumerable(draw.pipeline),
            ...(draw.immediateData !== undefined
                ? { immediateData: immutableEnumerable(draw.immediateData) }
                : {}),
            bindSets: immutableEnumerable(draw.bindSets),
            vertexBuffers: immutableEnumerable(draw.vertexBuffers),
            ...(draw.indexBuffer !== undefined
                ? { indexBuffer: immutableEnumerable(draw.indexBuffer) }
                : {}),
            count: immutableEnumerable(draw.count),
            resources: immutableEnumerable(draw.resources),
            whenMissing: immutableEnumerable('throw'),
            isDisposed: {
                get: () => renderBundleDrawSource(this).isDisposed,
                enumerable: true,
                configurable: false,
            },
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        return {
            kind: 'Command',
            id: this.id,
            commandKind: 'bundle-draw',
            ...(this.label !== undefined ? { label: this.label } : {}),
        }
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            related: [ this.runtime.subject, runtime.subject ],
            message: 'BundleDrawCommand belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime.id },
        })
    }

    assertUsable(): void {

        renderBundleDrawSource(this).assertUsable()
    }

    dispose(): void {

        renderBundleDrawSource(this).dispose()
    }
}

Object.freeze(BundleDrawCommand.prototype)

export function createBundleDrawCommand(
    runtime: ScratchRuntime,
    descriptor: BundleDrawCommandDescriptor
): BundleDrawCommand {

    const Constructor = BundleDrawCommand as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: BundleDrawCommandDescriptor
    ) => BundleDrawCommand
    return new Constructor(bundleDrawCommandToken, runtime, descriptor)
}

export function isBundleDrawCommand(value: unknown): value is BundleDrawCommand {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === BundleDrawCommand.prototype &&
        bundleDrawCommandStates.has(value as BundleDrawCommand)
}

export type RenderBundleCommand = BundleDrawCommand | DebugCommand

export type RenderBundleDescriptor = Readonly<{
    label?: string
    realization: RenderBundleRealization
    colorFormats: Iterable<GPUTextureFormat | null>
    depthStencilFormat?: GPUTextureFormat
    sampleCount?: number
    depthReadOnly?: boolean
    stencilReadOnly?: boolean
    commands: Iterable<RenderBundleCommand>
}>

export type RenderBundleLayout = Readonly<{
    colorFormats: readonly (GPUTextureFormat | null)[]
    depthStencilFormat?: GPUTextureFormat
    sampleCount: number
    depthReadOnly: boolean
    stencilReadOnly: boolean
}>

type ResourceAllocationDependency = Readonly<{
    resource: BufferResource | TextureResource
    allocationVersion: number
}>

type BindSetPreparationDependency = Readonly<{
    set: CommandBindSetInvocation['set']
    prepareGeneration: number
    preparedSnapshotHash?: string
}>

type RenderBundleDependencySnapshot = Readonly<{
    resources: readonly ResourceAllocationDependency[]
    bindSets: readonly BindSetPreparationDependency[]
}>

type RenderBundleState = {
    isDisposed: boolean
    gpuRenderBundle: GPURenderBundle | undefined
    dependencySnapshot: RenderBundleDependencySnapshot | undefined
}

type RenderBundleConstruction = Readonly<{
    runtime: ScratchRuntime
    id: string
    label?: string
    realization: RenderBundleRealization
    layout: RenderBundleLayout
    commands: readonly RenderBundleCommand[]
    gpuRenderBundle?: GPURenderBundle
    dependencySnapshot?: RenderBundleDependencySnapshot
}>

export interface RenderBundle {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly realization: RenderBundleRealization
    readonly layout: RenderBundleLayout
    readonly commands: readonly RenderBundleCommand[]
    readonly realizationState: RenderBundleRealizationState
    readonly isDisposed: boolean
}

export class RenderBundle {

    private constructor(
        token: symbol,
        input: RenderBundleConstruction
    ) {

        if (token !== renderBundleToken || new.target !== RenderBundle) {
            throw new TypeError('RenderBundle must be created by ScratchRuntime.createRenderBundle().')
        }
        renderBundleStates.set(this, {
            isDisposed: false,
            gpuRenderBundle: input.gpuRenderBundle,
            dependencySnapshot: input.dependencySnapshot,
        })
        Object.defineProperties(this, {
            runtime: immutableEnumerable(input.runtime),
            id: immutableEnumerable(input.id),
            ...(input.label !== undefined ? { label: immutableEnumerable(input.label) } : {}),
            realization: immutableEnumerable(input.realization),
            layout: immutableEnumerable(input.layout),
            commands: immutableEnumerable(input.commands),
            realizationState: {
                get: () => renderBundleRealizationState(this),
                enumerable: true,
                configurable: false,
            },
            isDisposed: {
                get: () => renderBundleStateFor(this).isDisposed,
                enumerable: true,
                configurable: false,
            },
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        return {
            kind: 'RenderBundle',
            id: this.id,
            realization: this.realization,
            ...(this.label !== undefined ? { label: this.label } : {}),
        }
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            related: [ this.runtime.subject, runtime.subject ],
            message: 'RenderBundle belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime.id },
        })
    }

    assertUsable(): void {

        const state = renderBundleStateFor(this)
        if (state.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RENDER_BUNDLE_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'RenderBundle has been disposed.',
            })
        }
        assertScratchRuntimeActive(this.runtime)
        if (this.realization === 'persistent') {
            assertPersistentRenderBundleSnapshotCurrent(this, state)
            return
        }
        for (const command of this.commands) command.assertUsable()
    }

    dispose(): void {

        const state = renderBundleStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        state.gpuRenderBundle = undefined
        state.dependencySnapshot = undefined
        unregisterRenderBundleOwnership(this)
    }
}

Object.freeze(RenderBundle.prototype)

export async function createRenderBundle(
    runtime: ScratchRuntime,
    descriptor: RenderBundleDescriptor
): Promise<RenderBundle> {

    assertScratchRuntimeActive(runtime)
    const normalized = normalizeRenderBundleDescriptor(runtime, descriptor)
    const id = `scratch-render-bundle-${UUID()}`
    let gpuRenderBundle: GPURenderBundle | undefined
    let dependencySnapshot: RenderBundleDependencySnapshot | undefined
    let creationOperation: ScratchPendingGpuOperation | undefined

    if (normalized.realization === 'persistent') {
        assertPersistentBundleHasNoTemporalDependencies(runtime, normalized.commands)
        dependencySnapshot = captureRenderBundleDependencySnapshot(normalized.commands)
        const immediateSnapshots = snapshotRenderBundleImmediates(normalized.commands)
        const nativeLabel = createScratchNativeLabel(normalized.label, id)
        const controller = diagnosticsControllerFor(runtime)
        const descriptorEvidence = renderBundleDescriptorEvidence(normalized)
        creationOperation = controller.beginOperation({
            kind: 'render-bundle-creation',
            target: {
                kind: 'render-bundle',
                renderBundleId: id,
                realization: 'persistent',
                colorFormats: normalized.layout.colorFormats,
                ...(normalized.layout.depthStencilFormat !== undefined
                    ? { depthStencilFormat: normalized.layout.depthStencilFormat }
                    : {}),
                sampleCount: normalized.layout.sampleCount,
                depthReadOnly: normalized.layout.depthReadOnly,
                stencilReadOnly: normalized.layout.stencilReadOnly,
                commandCount: normalized.commands.length,
            },
            descriptorSummary: descriptorEvidence,
            fullDescriptor: descriptorEvidence,
            nativeLabel,
        })
        const outcome = recheckSupportingObjectLifecycle(
            runtime,
            await issueSupportingObjectCreation(runtime, () =>
                encodeNativeRenderBundle(
                    runtime,
                    id,
                    normalized.label,
                    normalized.layout,
                    normalized.commands,
                    immediateSnapshots
                )
            )
        )
        if (outcome.failures.length > 0 || outcome.candidate === undefined) {
            return throwSupportingObjectCreationFailure(
                runtime,
                creationOperation,
                outcome,
                RENDER_BUNDLE_CREATION_CODES,
                {
                    operationName: 'RenderBundle creation',
                    phase: 'command',
                    subject: renderBundleSubject(
                        id,
                        normalized.label,
                        normalized.realization
                    ),
                    related: normalized.commands.map(command => command.subject),
                }
            )
        }
        try {
            assertDependencySnapshotCurrent(
                renderBundleSubject(id, normalized.label, normalized.realization),
                dependencySnapshot
            )
        } catch (cause) {
            controller.completeOperation(creationOperation, { status: 'cancelled' })
            throw cause
        }
        gpuRenderBundle = outcome.candidate
    }

    let bundle: RenderBundle
    try {
        bundle = constructRenderBundle({
            runtime,
            id,
            ...(normalized.label !== undefined ? { label: normalized.label } : {}),
            realization: normalized.realization,
            layout: normalized.layout,
            commands: normalized.commands,
            ...(gpuRenderBundle !== undefined ? { gpuRenderBundle } : {}),
            ...(dependencySnapshot !== undefined ? { dependencySnapshot } : {}),
        })
        registerRenderBundleOwnership(bundle)
    } catch (cause) {
        if (creationOperation === undefined) throw cause
        return throwSupportingObjectCreationFailure(
            runtime,
            creationOperation,
            {
                ...(gpuRenderBundle !== undefined ? { candidate: gpuRenderBundle } : {}),
                failures: [ { kind: 'native-exception', cause } ],
            },
            RENDER_BUNDLE_CREATION_CODES,
            {
                operationName: 'RenderBundle creation',
                phase: 'command',
                subject: renderBundleSubject(
                    id,
                    normalized.label,
                    normalized.realization
                ),
                related: normalized.commands.map(command => command.subject),
            }
        )
    }
    if (creationOperation !== undefined) {
        diagnosticsControllerFor(runtime).completeOperation(
            creationOperation,
            { status: 'succeeded' }
        )
    }
    return bundle
}

export type ExecuteRenderBundlesCommandDescriptor = Readonly<{
    label?: string
    bundles: Iterable<RenderBundle>
}>

export interface ExecuteRenderBundlesCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'execute-render-bundles'
    readonly bundles: readonly RenderBundle[]
    readonly isDisposed: boolean
}

export class ExecuteRenderBundlesCommand {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ExecuteRenderBundlesCommandDescriptor
    ) {

        if (
            token !== executeRenderBundlesCommandToken ||
            new.target !== ExecuteRenderBundlesCommand
        ) {
            throw new TypeError(
                'ExecuteRenderBundlesCommand must be created by ScratchRuntime.createExecuteRenderBundlesCommand().'
            )
        }
        assertScratchRuntimeActive(runtime)
        const normalized = normalizeExecuteRenderBundlesDescriptor(runtime, descriptor)
        executeRenderBundlesCommandStates.set(this, { isDisposed: false })
        Object.defineProperties(this, {
            runtime: immutableEnumerable(runtime),
            id: immutableEnumerable(`scratch-command-${UUID()}`),
            ...(normalized.label !== undefined
                ? { label: immutableEnumerable(normalized.label) }
                : {}),
            commandKind: immutableEnumerable('execute-render-bundles'),
            bundles: immutableEnumerable(normalized.bundles),
            isDisposed: {
                get: () => executeRenderBundlesCommandStateFor(this).isDisposed,
                enumerable: true,
                configurable: false,
            },
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        return {
            kind: 'Command',
            id: this.id,
            commandKind: 'execute-render-bundles',
            ...(this.label !== undefined ? { label: this.label } : {}),
        }
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            related: [ this.runtime.subject, runtime.subject ],
            message: 'ExecuteRenderBundlesCommand belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime.id },
        })
    }

    assertUsable(): void {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'ExecuteRenderBundlesCommand has been disposed.',
            })
        }
        assertScratchRuntimeActive(this.runtime)
        for (const bundle of this.bundles) bundle.assertRuntime(this.runtime)
    }

    validateForPass(pass: unknown): void {

        this.assertUsable()
        if (!isRenderPassSpec(pass)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [],
                message: 'ExecuteRenderBundlesCommand can only be recorded into a render pass.',
                expected: { passKind: 'render' },
                actual: { pass: describeValue(pass) },
            })
        }
        for (const bundle of this.bundles) {
            assertRenderBundleCompatibleWithPass(bundle, pass, this)
        }
    }

    encode(
        encoder: GPURenderPassEncoder,
        nativeBundles: readonly GPURenderBundle[]
    ): void {

        this.assertUsable()
        if (nativeBundles.length !== this.bundles.length) {
            throw new TypeError('ExecuteRenderBundlesCommand native bundle count is inconsistent.')
        }
        if (typeof encoder.executeBundles !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_RENDER_BUNDLE_EXECUTION_UNSUPPORTED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Native render pass encoder does not expose executeBundles().',
            })
        }
        try {
            encoder.executeBundles(nativeBundles)
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RENDER_BUNDLE_EXECUTION_FAILED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: this.bundles.map(bundle => bundle.subject),
                message: 'Native render bundle execution failed synchronously.',
            }, { cause })
        }
    }

    dispose(): void {

        executeRenderBundlesCommandStateFor(this).isDisposed = true
    }
}

Object.freeze(ExecuteRenderBundlesCommand.prototype)

export function createExecuteRenderBundlesCommand(
    runtime: ScratchRuntime,
    descriptor: ExecuteRenderBundlesCommandDescriptor
): ExecuteRenderBundlesCommand {

    const Constructor = ExecuteRenderBundlesCommand as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ExecuteRenderBundlesCommandDescriptor
    ) => ExecuteRenderBundlesCommand
    return new Constructor(executeRenderBundlesCommandToken, runtime, descriptor)
}

export function isExecuteRenderBundlesCommand(
    value: unknown
): value is ExecuteRenderBundlesCommand {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === ExecuteRenderBundlesCommand.prototype &&
        executeRenderBundlesCommandStates.has(value as ExecuteRenderBundlesCommand)
}

export function renderBundleDrawCommands(
    bundle: RenderBundle
): readonly BundleDrawCommand[] {

    return bundle.commands.filter(isBundleDrawCommand)
}

export function snapshotAttemptRenderBundleImmediates(
    bundle: RenderBundle
): ReadonlyMap<BundleDrawCommand, ResolvedCommandImmediateData> {

    bundle.assertUsable()
    return snapshotRenderBundleImmediates(bundle.commands)
}

export function realizeRenderBundleForAttempt(
    bundle: RenderBundle,
    authority: AttemptTextureAuthority,
    immediateSnapshots?: ReadonlyMap<BundleDrawCommand, ResolvedCommandImmediateData>
): GPURenderBundle {

    bundle.assertUsable()
    const state = renderBundleStateFor(bundle)
    if (bundle.realization === 'persistent') {
        if (state.gpuRenderBundle === undefined) {
            throw new TypeError('Persistent RenderBundle native realization is unavailable.')
        }
        return state.gpuRenderBundle
    }
    const snapshots = immediateSnapshots ?? snapshotAttemptRenderBundleImmediates(bundle)
    try {
        return encodeNativeRenderBundle(
            bundle.runtime,
            bundle.id,
            bundle.label,
            bundle.layout,
            bundle.commands,
            snapshots,
            authority
        )
    } catch (cause) {
        if (isScratchDiagnosticError(cause)) throw cause
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_ATTEMPT_REALIZATION_FAILED',
            severity: 'error',
            phase: 'submission',
            subject: bundle.subject,
            message: 'Attempt-local native RenderBundle realization failed synchronously.',
        }, { cause })
    }
}

export function assertRenderBundleTemporalDependencies(
    bundle: RenderBundle,
    owner: SurfaceTextureLeaseOwner
): void {

    bundle.assertRuntime(owner.runtime)
    for (const command of renderBundleDrawCommands(bundle)) {
        assertCommandTemporalDependencies(renderBundleDrawSource(command), owner)
    }
}

export function assertRenderBundleBufferGpuUseAvailable(bundle: RenderBundle): void {

    bundle.assertUsable()
    for (const command of renderBundleDrawCommands(bundle)) {
        assertCommandBufferGpuUseAvailable(renderBundleDrawSource(command))
    }
}

export function renderBundleDrawSource(command: BundleDrawCommand): DrawCommand {

    const state = bundleDrawCommandStates.get(command)
    if (state === undefined) throw new TypeError('BundleDrawCommand state is unavailable.')
    return state.draw
}

export function renderBundleDrawProducesDeclaredWrites(
    command: BundleDrawCommand
): boolean {

    return renderBundleDrawSource(command)._producesDeclaredWrites
}

function constructRenderBundle(
    input: RenderBundleConstruction
): RenderBundle {

    const Constructor = RenderBundle as unknown as new (
        token: symbol,
        input: RenderBundleConstruction
    ) => RenderBundle
    return new Constructor(renderBundleToken, input)
}

function normalizeBundleDrawDescriptor(
    runtime: ScratchRuntime,
    descriptor: BundleDrawCommandDescriptor
): void {

    if (
        !isRecord(descriptor) ||
        descriptor.whenMissing !== 'throw' ||
        descriptor.fallback !== undefined ||
        descriptor.renderState !== undefined
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_COMMAND_INVALID',
            severity: 'error',
            phase: 'command',
            subject: { kind: 'Command', commandKind: 'bundle-draw' },
            related: [ runtime.subject ],
            message: 'BundleDrawCommand permits only native render-bundle draw state.',
            expected: {
                whenMissing: 'throw',
                fallback: undefined,
                renderState: undefined,
            },
            actual: {
                descriptor: describeValue(descriptor),
                whenMissing: isRecord(descriptor) ? descriptor.whenMissing : undefined,
                fallback: isRecord(descriptor) ? describeValue(descriptor.fallback) : undefined,
                renderState: isRecord(descriptor) ? describeValue(descriptor.renderState) : undefined,
            },
        })
    }
}

function normalizeRenderBundleDescriptor(
    runtime: ScratchRuntime,
    descriptor: RenderBundleDescriptor
): Readonly<{
    label?: string
    realization: RenderBundleRealization
    layout: RenderBundleLayout
    commands: readonly RenderBundleCommand[]
}> {

    if (!isRecord(descriptor)) {
        return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'descriptor')
    }
    const label = descriptor.label
    const realization = descriptor.realization
    if (
        (label !== undefined && typeof label !== 'string') ||
        (realization !== 'persistent' && realization !== 'attempt-local')
    ) {
        return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'identity')
    }
    const colorFormats = snapshotIterable(
        runtime,
        descriptor.colorFormats,
        'colorFormats'
    )
    if (colorFormats.some(format => format !== null && typeof format !== 'string')) {
        return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'colorFormats')
    }
    const maxColorAttachments = runtime.device.limits.maxColorAttachments
    if (
        Number.isInteger(maxColorAttachments) &&
        colorFormats.length > maxColorAttachments
    ) {
        return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'colorFormats')
    }
    const depthStencilFormat = descriptor.depthStencilFormat
    const sampleCount = descriptor.sampleCount ?? 1
    const depthReadOnly = descriptor.depthReadOnly ?? false
    const stencilReadOnly = descriptor.stencilReadOnly ?? false
    if (
        (depthStencilFormat !== undefined && typeof depthStencilFormat !== 'string') ||
        (sampleCount !== 1 && sampleCount !== 4) ||
        typeof depthReadOnly !== 'boolean' ||
        typeof stencilReadOnly !== 'boolean' ||
        (
            depthStencilFormat === undefined &&
            colorFormats.every(format => format === null)
        ) ||
        (depthReadOnly && (
            depthStencilFormat === undefined ||
            !DEPTH_FORMATS.has(depthStencilFormat)
        )) ||
        (stencilReadOnly && (
            depthStencilFormat === undefined ||
            !STENCIL_FORMATS.has(depthStencilFormat)
        ))
    ) {
        return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'layout')
    }
    const commands = snapshotIterable(runtime, descriptor.commands, 'commands')
    for (const command of commands) {
        if (!isBundleDrawCommand(command) && !isDebugCommand(command)) {
            return throwRenderBundleDescriptorInvalid(runtime, descriptor, 'commands')
        }
        command.assertRuntime(runtime)
    }
    const layout = Object.freeze({
        colorFormats: Object.freeze(colorFormats as (GPUTextureFormat | null)[]),
        ...(depthStencilFormat !== undefined ? { depthStencilFormat } : {}),
        sampleCount,
        depthReadOnly,
        stencilReadOnly,
    })
    for (const command of commands) {
        if (isBundleDrawCommand(command)) {
            assertBundleDrawPipelineCompatibility(command, layout)
        }
    }
    validateBalancedDebugCommands(
        commands,
        renderBundleSubject(undefined, label, realization),
        'render-bundle'
    )
    return Object.freeze({
        ...(label !== undefined ? { label } : {}),
        realization,
        layout,
        commands: Object.freeze(commands as RenderBundleCommand[]),
    })
}

function normalizeExecuteRenderBundlesDescriptor(
    runtime: ScratchRuntime,
    descriptor: ExecuteRenderBundlesCommandDescriptor
): Readonly<{ label?: string, bundles: readonly RenderBundle[] }> {

    if (!isRecord(descriptor)) {
        return throwExecuteRenderBundlesDescriptorInvalid(runtime, descriptor)
    }
    const label = descriptor.label
    if (label !== undefined && typeof label !== 'string') {
        return throwExecuteRenderBundlesDescriptorInvalid(runtime, descriptor)
    }
    const bundles = snapshotIterable(runtime, descriptor.bundles, 'bundles')
    for (const bundle of bundles) {
        if (!isRenderBundle(bundle)) {
            return throwExecuteRenderBundlesDescriptorInvalid(runtime, descriptor)
        }
        if (bundle.runtime !== runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_RENDER_BUNDLE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: bundle.subject,
                related: [ bundle.runtime.subject, runtime.subject ],
                message: 'RenderBundle belongs to a different ScratchRuntime.',
                expected: { runtimeId: runtime.id },
                actual: { runtimeId: bundle.runtime.id },
            })
        }
        if (bundle.isDisposed) bundle.assertUsable()
    }
    return Object.freeze({
        ...(label !== undefined ? { label } : {}),
        bundles: Object.freeze(bundles as RenderBundle[]),
    })
}

function renderBundleDescriptorEvidence(
    descriptor: Readonly<{
        realization: RenderBundleRealization
        layout: RenderBundleLayout
        commands: readonly RenderBundleCommand[]
        label?: string
    }>
): Record<string, unknown> {

    const bundleDrawCount = descriptor.commands.filter(isBundleDrawCommand).length
    const debugCommandCount = descriptor.commands.length - bundleDrawCount
    return {
        realization: descriptor.realization,
        colorFormats: [ ...descriptor.layout.colorFormats ],
        ...(descriptor.layout.depthStencilFormat !== undefined
            ? { depthStencilFormat: descriptor.layout.depthStencilFormat }
            : {}),
        sampleCount: descriptor.layout.sampleCount,
        depthReadOnly: descriptor.layout.depthReadOnly,
        stencilReadOnly: descriptor.layout.stencilReadOnly,
        commandCount: descriptor.commands.length,
        bundleDrawCount,
        debugCommandCount,
        immediateCommandCount: descriptor.commands.filter(command =>
            isBundleDrawCommand(command) && command.immediateData !== undefined
        ).length,
        hasLabel: descriptor.label !== undefined,
    }
}

function encodeNativeRenderBundle(
    runtime: ScratchRuntime,
    id: string,
    label: string | undefined,
    layout: RenderBundleLayout,
    commands: readonly RenderBundleCommand[],
    immediateSnapshots: ReadonlyMap<BundleDrawCommand, ResolvedCommandImmediateData>,
    authority?: AttemptTextureAuthority
): GPURenderBundle {

    const nativeLabel = createScratchNativeLabel(label, id)
    const bundleEncoder = runtime.device.createRenderBundleEncoder({
        label: nativeLabel,
        colorFormats: [ ...layout.colorFormats ],
        ...(layout.depthStencilFormat !== undefined
            ? { depthStencilFormat: layout.depthStencilFormat }
            : {}),
        sampleCount: layout.sampleCount,
        depthReadOnly: layout.depthReadOnly,
        stencilReadOnly: layout.stencilReadOnly,
    })
    for (const command of commands) {
        if (isDebugCommand(command)) {
            command.encode(bundleEncoder)
            continue
        }
        encodeDrawCommandInRenderBundle(
            renderBundleDrawSource(command),
            bundleEncoder,
            immediateSnapshots.get(command),
            authority
        )
    }
    return bundleEncoder.finish({ label: nativeLabel })
}

function snapshotRenderBundleImmediates(
    commands: readonly RenderBundleCommand[]
): ReadonlyMap<BundleDrawCommand, ResolvedCommandImmediateData> {

    const snapshots = new Map<BundleDrawCommand, ResolvedCommandImmediateData>()
    for (const command of commands) {
        if (!isBundleDrawCommand(command)) continue
        snapshots.set(command, snapshotCommandImmediateData(renderBundleDrawSource(command)))
    }
    return snapshots
}

function captureRenderBundleDependencySnapshot(
    commands: readonly RenderBundleCommand[]
): RenderBundleDependencySnapshot {

    const resources = new Map<BufferResource | TextureResource, number>()
    const bindSets = new Map<
        CommandBindSetInvocation['set'],
        BindSetPreparationDependency
    >()
    for (const command of commands) {
        if (!isBundleDrawCommand(command)) continue
        command.assertUsable()
        for (const resource of bundleDrawAllocationDependencies(command)) {
            resources.set(resource, resource.allocationVersion)
        }
        for (const invocation of command.bindSets) {
            const set = invocation.set
            bindSets.set(set, Object.freeze({
                set,
                prepareGeneration: set.prepareGeneration,
                ...(set.preparedSnapshotHash !== undefined
                    ? { preparedSnapshotHash: set.preparedSnapshotHash }
                    : {}),
            }))
        }
    }
    return Object.freeze({
        resources: Object.freeze([ ...resources ].map(([ resource, allocationVersion ]) =>
            Object.freeze({ resource, allocationVersion })
        )),
        bindSets: Object.freeze([ ...bindSets.values() ]),
    })
}

function bundleDrawAllocationDependencies(
    command: BundleDrawCommand
): readonly (BufferResource | TextureResource)[] {

    const resources = new Set<BufferResource | TextureResource>()
    for (const read of command.resources.read) resources.add(read.resource)
    for (const write of command.resources.write) resources.add(write)
    for (const binding of command.vertexBuffers) resources.add(binding.region.buffer)
    if (command.indexBuffer !== undefined) resources.add(command.indexBuffer.region.buffer)
    if ('indirect' in command.count) resources.add(command.count.indirect.buffer)
    return [ ...resources ]
}

function assertPersistentBundleHasNoTemporalDependencies(
    runtime: ScratchRuntime,
    commands: readonly RenderBundleCommand[]
): void {

    for (const command of commands) {
        if (!isBundleDrawCommand(command)) continue
        const temporalSets = command.bindSets
            .map(invocation => invocation.set)
            .filter(set => set.isAttemptLocal)
        if (temporalSets.length === 0) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_TEMPORAL_REALIZATION_REQUIRED',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            related: [ runtime.subject, ...temporalSets.map(set => set.subject) ],
            message: 'Persistent RenderBundle cannot capture attempt-local texture bindings.',
            expected: { realization: 'attempt-local' },
            actual: {
                realization: 'persistent',
                bindSetIds: temporalSets.map(set => set.id),
            },
        })
    }
}

function assertPersistentRenderBundleSnapshotCurrent(
    bundle: RenderBundle,
    state: RenderBundleState
): void {

    if (
        state.gpuRenderBundle === undefined ||
        state.dependencySnapshot === undefined
    ) {
        throw new TypeError('Persistent RenderBundle realization state is incomplete.')
    }
    try {
        for (const command of bundle.commands) command.assertUsable()
        assertDependencySnapshotCurrent(bundle.subject, state.dependencySnapshot)
    } catch (cause) {
        if (
            isScratchDiagnosticError(cause) &&
            cause.diagnostic.code === 'SCRATCH_RENDER_BUNDLE_STALE'
        ) {
            throw cause
        }
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_STALE',
            severity: 'error',
            phase: 'command',
            subject: bundle.subject,
            related: bundle.commands.map(command => command.subject),
            message: 'Persistent RenderBundle dependency snapshot is stale and requires explicit reconstruction.',
            actual: {
                causeCode: isScratchDiagnosticError(cause)
                    ? cause.diagnostic.code
                    : undefined,
            },
        }, { cause })
    }
}

function assertDependencySnapshotCurrent(
    subject: DiagnosticSubject,
    snapshot: RenderBundleDependencySnapshot
): void {

    for (const dependency of snapshot.resources) {
        dependency.resource.assertUsable()
        if (dependency.resource.allocationVersion === dependency.allocationVersion) continue
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_STALE',
            severity: 'error',
            phase: 'command',
            subject,
            related: [ dependency.resource.subject ],
            message: 'Persistent RenderBundle captured an obsolete resource allocation.',
            expected: { allocationVersion: dependency.allocationVersion },
            actual: { allocationVersion: dependency.resource.allocationVersion },
        })
    }
    for (const dependency of snapshot.bindSets) {
        dependency.set.assertUsable()
        if (
            dependency.set.prepareGeneration === dependency.prepareGeneration &&
            dependency.set.preparedSnapshotHash === dependency.preparedSnapshotHash
        ) {
            continue
        }
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_STALE',
            severity: 'error',
            phase: 'command',
            subject,
            related: [ dependency.set.subject ],
            message: 'Persistent RenderBundle captured an obsolete BindSet preparation.',
            expected: {
                prepareGeneration: dependency.prepareGeneration,
                preparedSnapshotHash: dependency.preparedSnapshotHash,
            },
            actual: {
                prepareGeneration: dependency.set.prepareGeneration,
                preparedSnapshotHash: dependency.set.preparedSnapshotHash,
            },
        })
    }
}

function assertBundleDrawPipelineCompatibility(
    command: BundleDrawCommand,
    layout: RenderBundleLayout
): void {

    const pipelineLayout = renderPipelineLayoutFor(command.pipeline)
    if (
        !formatsEqual(pipelineLayout.colorFormats, layout.colorFormats) ||
        pipelineLayout.depthStencilFormat !== layout.depthStencilFormat ||
        pipelineLayout.sampleCount !== layout.sampleCount
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_PIPELINE_LAYOUT_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'BundleDrawCommand pipeline layout does not match its RenderBundle layout.',
            expected: {
                colorFormats: layout.colorFormats,
                depthStencilFormat: layout.depthStencilFormat,
                sampleCount: layout.sampleCount,
            },
            actual: {
                colorFormats: pipelineLayout.colorFormats,
                depthStencilFormat: pipelineLayout.depthStencilFormat,
                sampleCount: pipelineLayout.sampleCount,
            },
        })
    }
    if (
        layout.depthReadOnly &&
        command.pipeline.depthStencil?.depthWriteEnabled === true
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_READ_ONLY_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'Depth-writing pipeline cannot be encoded into a depth-read-only RenderBundle.',
            expected: { depthWriteEnabled: false },
            actual: { depthWriteEnabled: true },
        })
    }
    if (
        layout.stencilReadOnly &&
        renderPipelineMayWriteStencil(
            command.pipeline.depthStencil,
            command.pipeline.primitive
        )
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_READ_ONLY_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [ command.subject ],
            message: 'Stencil-writing pipeline cannot be encoded into a stencil-read-only RenderBundle.',
            expected: { stencilWrites: false },
            actual: { stencilWrites: true },
        })
    }
}

function assertRenderBundleCompatibleWithPass(
    bundle: RenderBundle,
    pass: RenderPassSpec,
    command: ExecuteRenderBundlesCommand
): void {

    const passLayout = renderPassLayout(pass)
    const compatible = formatsEqual(bundle.layout.colorFormats, passLayout.colorFormats) &&
        bundle.layout.depthStencilFormat === passLayout.depthStencilFormat &&
        bundle.layout.sampleCount === passLayout.sampleCount &&
        (!passLayout.depthReadOnly || bundle.layout.depthReadOnly) &&
        (!passLayout.stencilReadOnly || bundle.layout.stencilReadOnly)
    if (compatible) return
    throwScratchDiagnostic({
        code: 'SCRATCH_RENDER_BUNDLE_PASS_INCOMPATIBLE',
        severity: 'error',
        phase: 'command',
        subject: bundle.subject,
        related: [ command.subject, pass.subject ],
        message: 'RenderBundle layout is incompatible with the selected RenderPassSpec.',
        expected: passLayout,
        actual: bundle.layout,
    })
}

function renderPassLayout(pass: RenderPassSpec): RenderBundleLayout {

    const firstColor = pass.color.find(attachment => attachment !== null)
    const sampleCount = firstColor === undefined
        ? pass.depth?.target.texture.sampleCount ?? 1
        : isTextureViewSpec(firstColor.target)
            ? firstColor.target.texture.sampleCount
            : 1
    return Object.freeze({
        colorFormats: Object.freeze(pass.color.map(attachment => attachment?.format ?? null)),
        ...(pass.depth !== undefined
            ? { depthStencilFormat: pass.depth.target.descriptor.format }
            : {}),
        sampleCount,
        depthReadOnly: pass.depth?.depthReadOnly ?? false,
        stencilReadOnly: pass.depth?.stencilReadOnly ?? false,
    })
}

function renderPipelineMayWriteStencil(
    depthStencil: Readonly<GPUDepthStencilState> | undefined,
    primitive: Readonly<GPUPrimitiveState>
): boolean {

    if (depthStencil === undefined || (depthStencil.stencilWriteMask ?? 0xffffffff) === 0) {
        return false
    }
    const cullMode = primitive.cullMode ?? 'none'
    return (
        cullMode !== 'front' &&
        stencilFaceMayWrite(depthStencil.stencilFront)
    ) || (
        cullMode !== 'back' &&
        stencilFaceMayWrite(depthStencil.stencilBack)
    )
}

function stencilFaceMayWrite(
    face: Readonly<GPUStencilFaceState> | undefined
): boolean {

    return face !== undefined && (
        (face.failOp ?? 'keep') !== 'keep' ||
        (face.depthFailOp ?? 'keep') !== 'keep' ||
        (face.passOp ?? 'keep') !== 'keep'
    )
}

function formatsEqual(
    left: readonly (GPUTextureFormat | null)[],
    right: readonly (GPUTextureFormat | null)[]
): boolean {

    const leftTrimmed = withoutTrailingNulls(left)
    const rightTrimmed = withoutTrailingNulls(right)
    return leftTrimmed.length === rightTrimmed.length &&
        leftTrimmed.every((value, index) => value === rightTrimmed[index])
}

function withoutTrailingNulls(
    formats: readonly (GPUTextureFormat | null)[]
): readonly (GPUTextureFormat | null)[] {

    let length = formats.length
    while (length > 0 && formats[length - 1] === null) length--
    return formats.slice(0, length)
}

function renderBundleRealizationState(bundle: RenderBundle): RenderBundleRealizationState {

    const state = renderBundleStateFor(bundle)
    if (state.isDisposed) return 'disposed'
    if (bundle.realization === 'attempt-local') return 'attempt-local'
    try {
        assertPersistentRenderBundleSnapshotCurrent(bundle, state)
        return 'ready'
    } catch {
        return 'stale'
    }
}

function renderBundleStateFor(bundle: RenderBundle): RenderBundleState {

    const state = renderBundleStates.get(bundle)
    if (state === undefined) throw new TypeError('RenderBundle state is unavailable.')
    return state
}

function executeRenderBundlesCommandStateFor(
    command: ExecuteRenderBundlesCommand
): { isDisposed: boolean } {

    const state = executeRenderBundlesCommandStates.get(command)
    if (state === undefined) {
        throw new TypeError('ExecuteRenderBundlesCommand state is unavailable.')
    }
    return state
}

function isRenderBundle(value: unknown): value is RenderBundle {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === RenderBundle.prototype &&
        renderBundleStates.has(value as RenderBundle)
}

function throwRenderBundleDescriptorInvalid(
    runtime: ScratchRuntime,
    descriptor: unknown,
    field: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RENDER_BUNDLE_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'RenderBundle' },
        related: [ runtime.subject ],
        message: 'RenderBundle descriptor is invalid.',
        expected: {
            realization: [ 'persistent', 'attempt-local' ],
            colorFormats: 'iterable of GPUTextureFormat or null',
            sampleCount: [ 1, 4 ],
            commands: 'iterable of BundleDrawCommand or DebugCommand',
        },
        actual: {
            field,
            descriptor: describeValue(descriptor),
        },
    })
}

function throwExecuteRenderBundlesDescriptorInvalid(
    runtime: ScratchRuntime,
    descriptor: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_RENDER_BUNDLE_EXECUTION_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'execute-render-bundles' },
        related: [ runtime.subject ],
        message: 'ExecuteRenderBundlesCommand requires an iterable of genuine RenderBundles.',
        expected: { bundles: 'Iterable<RenderBundle>', label: 'optional string' },
        actual: { descriptor: describeValue(descriptor) },
    })
}

function snapshotIterable<T>(
    runtime: ScratchRuntime,
    value: Iterable<T>,
    field: string
): T[] {

    try {
        return Array.from(value)
    } catch (cause) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RENDER_BUNDLE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'command',
            subject: { kind: 'RenderBundle' },
            related: [ runtime.subject ],
            message: 'RenderBundle iterable could not be snapshotted.',
            actual: { field, value: describeValue(value) },
        }, { cause })
    }
}

function renderBundleSubject(
    id: string | undefined,
    label: string | undefined,
    realization: RenderBundleRealization
): DiagnosticSubject {

    return {
        kind: 'RenderBundle',
        ...(id !== undefined ? { id } : {}),
        realization,
        ...(label !== undefined ? { label } : {}),
    }
}

function immutableEnumerable(value: unknown): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}
