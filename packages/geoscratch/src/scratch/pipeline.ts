import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import {
    issuePipelineCreation,
} from './pipeline-creation.js'
import { snapshotPipelineSource } from './pipeline-compilation.js'
import { describeValue } from './type-utils.js'
import { programLayoutRequirementExpected, programLayoutRequirementSubject } from './program.js'
import { readonlyMapSnapshot } from './readonly-map.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { BindLayout } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type {
    GpuAttributionConfidence,
    GpuNativeErrorCategory,
    ScratchGpuIncidentOutcome,
    ScratchPipelineNativeLabelEvidence,
} from './gpu-operation.js'
import type {
    PipelineCreationIssueResult,
    PipelineCreationObservedFailure,
    PipelineNativeLabels,
} from './pipeline-creation.js'
import type { PipelineCompilationReport, PipelineSourceSnapshot } from './pipeline-compilation.js'
import type { Program, ProgramBufferLayoutRequirement } from './program.js'
import type { ScratchGpuOperationCompletion, ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const renderPipelineToken = Symbol('RenderPipeline')
const renderPipelineStates = new WeakMap<RenderPipeline, { isDisposed: boolean }>()

export type RenderPipelineDescriptor = {
    label?: string
    program: Program
    vertex?: string
    fragment?: string
    bindLayouts?: BindLayout[]
    vertexBuffers?: GPUVertexBufferLayout[]
    targets: GPUColorTargetState[]
    primitive?: GPUPrimitiveState
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
}

export type ComputePipelineDescriptor = {
    label?: string
    program: Program
    compute?: string
    bindLayouts?: BindLayout[]
    constants?: Record<string, GPUPipelineConstantValue>
}

export interface RenderPipeline {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly pipelineKind: 'render'
    readonly program: Program
    readonly vertexEntryPoint: string
    readonly fragmentEntryPoint: string
    readonly bindLayouts: readonly BindLayout[]
    readonly bindLayoutsByGroup: ReadonlyMap<number, BindLayout>
    readonly vertexBuffers: readonly GPUVertexBufferLayout[]
    readonly targets: readonly GPUColorTargetState[]
    readonly targetFormats: readonly GPUTextureFormat[]
    readonly primitive: Readonly<GPUPrimitiveState>
    readonly depthStencil?: Readonly<GPUDepthStencilState>
    readonly depthStencilFormat?: GPUTextureFormat
    readonly shaderModule: GPUShaderModule
    readonly pipelineLayout: GPUPipelineLayout
    readonly gpuPipeline: GPURenderPipeline
    readonly compilationReport: PipelineCompilationReport
}

export class RenderPipeline {

    private constructor(token: symbol, state?: RenderPipelineState) {

        if (token !== renderPipelineToken || state === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'pipeline',
                subject: { kind: 'Pipeline', pipelineKind: 'render' },
                message: 'RenderPipeline is created only by ScratchRuntime.',
                hints: [ 'Use await runtime.createRenderPipeline(descriptor).' ],
            })
        }
        renderPipelineStates.set(this, { isDisposed: false })
        defineImmutableProperties(this, state)
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return renderPipelineStateFor(this).isDisposed
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'render',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Pipeline belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_DISPOSED',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                message: 'Pipeline has been disposed.',
            })
        }

        this.runtime.assertActive()
        this.program.assertUsable()
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    dispose(): void {

        const state = renderPipelineStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        this.runtime._unregisterPipeline(this)
    }
}

type PipelineValidationContext = {
    runtime: ScratchRuntime
    id: string
    label?: string
    pipelineKind: 'render' | 'compute'
    program: Program
    subject: DiagnosticSubject
    bindLayouts: readonly BindLayout[]
    bindLayoutsByGroup: ReadonlyMap<number, BindLayout>
}

type RenderPipelinePlan = PipelineValidationContext & Readonly<{
    pipelineKind: 'render'
    vertexEntryPoint: string
    fragmentEntryPoint: string
    vertexBuffers: readonly GPUVertexBufferLayout[]
    targets: readonly GPUColorTargetState[]
    targetFormats: readonly GPUTextureFormat[]
    primitive: Readonly<GPUPrimitiveState>
    depthStencil?: Readonly<GPUDepthStencilState>
    depthStencilFormat?: GPUTextureFormat
    multisample?: Readonly<GPUMultisampleState>
    sourceSnapshot: PipelineSourceSnapshot
}>

type RenderPipelineState = RenderPipelinePlan & Readonly<{
    shaderModule: GPUShaderModule
    pipelineLayout: GPUPipelineLayout
    gpuPipeline: GPURenderPipeline
    compilationReport: PipelineCompilationReport
}>

export async function createRenderPipeline(
    runtime: ScratchRuntime,
    descriptor: RenderPipelineDescriptor
): Promise<RenderPipeline> {

    const plan = prepareRenderPipeline(runtime, descriptor)
    const nativeLabels = pipelineNativeLabels(plan.label, plan.id)
    const controller = diagnosticsControllerFor(runtime)
    const target = {
        kind: 'pipeline' as const,
        pipelineId: plan.id,
        pipelineKind: 'render' as const,
        programId: plan.program.id,
        programSourceHash: plan.sourceSnapshot.combinedSourceHash,
    }
    const descriptorEvidence = renderPipelineDescriptorEvidence(plan)
    const operation = controller.beginOperation({
        kind: 'render-pipeline-creation',
        target,
        descriptorSummary: descriptorEvidence.summary,
        fullDescriptor: descriptorEvidence.full,
        nativeLabel: nativeLabels.pipeline,
    })
    const issue = await issuePipelineCreation({
        runtime,
        pipelineId: plan.id,
        pipelineKind: 'render',
        sourceSnapshot: plan.sourceSnapshot,
        nativeLabels,
        bindGroupLayouts: plan.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        lowerPipelineDescriptor: (shaderModule, pipelineLayout) => {
            const nativeDescriptor: GPURenderPipelineDescriptor = {
                label: nativeLabels.pipeline,
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: plan.vertexEntryPoint,
                    buffers: [ ...plan.vertexBuffers ],
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: plan.fragmentEntryPoint,
                    targets: [ ...plan.targets ],
                },
                primitive: plan.primitive,
            }
            if (plan.depthStencil !== undefined) nativeDescriptor.depthStencil = plan.depthStencil
            if (plan.multisample !== undefined) nativeDescriptor.multisample = plan.multisample
            return nativeDescriptor
        },
    })
    const failures = [ ...issue.failures, ...pipelineLifecycleFailures(plan) ]
    if (
        failures.length > 0 ||
        issue.shaderModule === undefined ||
        issue.pipelineLayout === undefined ||
        issue.nativePipeline === undefined ||
        issue.compilationReport === undefined
    ) {
        throwRenderPipelineCreationFailure(
            plan,
            operation,
            issue,
            failures,
            nativeLabels
        )
    }

    const completion = {
        status: 'succeeded' as const,
        nativeLabels: nativeLabelEvidence(nativeLabels),
        compilationReport: issue.compilationReport,
    }
    const creationRecord = controller.completeOperation(operation, completion)
    if (
        creationRecord.kind !== 'render-pipeline-creation' ||
        creationRecord.target.kind !== 'pipeline'
    ) {
        throw new TypeError('Render pipeline creation produced an incompatible operation record.')
    }
    const Constructor = RenderPipeline as unknown as new (
        token: symbol,
        state: RenderPipelineState
    ) => RenderPipeline
    const pipeline = new Constructor(renderPipelineToken, {
        ...plan,
        shaderModule: issue.shaderModule,
        pipelineLayout: issue.pipelineLayout,
        gpuPipeline: issue.nativePipeline as GPURenderPipeline,
        compilationReport: creationRecord.compilationReport!,
    })
    runtime._registerPipeline(pipeline, creationRecord)
    return pipeline
}

function prepareRenderPipeline(
    runtime: ScratchRuntime,
    descriptor: RenderPipelineDescriptor
): RenderPipelinePlan {

    runtime.assertActive()
    const input = descriptor ?? {} as RenderPipelineDescriptor
    const program = input.program
    if (!program || typeof program.assertRuntime !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_PROGRAM_INVALID',
            severity: 'error',
            phase: 'pipeline',
            subject: { kind: 'Pipeline', pipelineKind: 'render' },
            message: 'RenderPipeline requires a Program.',
            expected: { program: 'Program' },
            actual: { program: program === undefined || program === null ? String(program) : typeof program },
        })
    }
    program.assertRuntime(runtime)

    const id = `scratch-pipeline-${UUID()}`
    const subject = Object.freeze({
        kind: 'Pipeline',
        id,
        pipelineKind: 'render',
        ...(input.label !== undefined ? { label: input.label } : {}),
    })
    const context: PipelineValidationContext & { pipelineKind: 'render' } = {
        runtime,
        id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        pipelineKind: 'render',
        program,
        subject,
        bindLayouts: Object.freeze([]),
        bindLayoutsByGroup: readonlyMapSnapshot(new Map()),
    }
    const bindLayouts = Object.freeze(normalizeBindLayouts(context, input.bindLayouts))
    const bindLayoutsByGroup = readonlyMapSnapshot(
        new Map(bindLayouts.map(layout => [ layout.group, layout ]))
    )
    const vertexBuffers = freezeVertexBuffers(normalizeVertexBuffers(context, input.vertexBuffers))
    const targets = freezeColorTargets(normalizeTargets(context, input.targets))
    const primitive = Object.freeze({
        topology: 'triangle-list' as GPUPrimitiveTopology,
        ...input.primitive,
    })
    const depthStencil = input.depthStencil === undefined
        ? undefined
        : freezeDepthStencil(input.depthStencil)
    const multisample = input.multisample === undefined
        ? undefined
        : Object.freeze({ ...input.multisample })
    const draft: Omit<RenderPipelinePlan, 'sourceSnapshot'> = {
        ...context,
        bindLayouts,
        bindLayoutsByGroup,
        vertexEntryPoint: (input.vertex ?? program.entryPoints.vertex) as string,
        fragmentEntryPoint: (input.fragment ?? program.entryPoints.fragment) as string,
        vertexBuffers,
        targets,
        targetFormats: Object.freeze(targets.map(target => target.format)),
        primitive,
        ...(depthStencil !== undefined ? {
            depthStencil,
            depthStencilFormat: depthStencil.format,
        } : {}),
        ...(multisample !== undefined ? { multisample } : {}),
    }
    validateEntryPoints(draft)
    validateProgramLayoutRequirements(draft)

    let sourceSnapshot: PipelineSourceSnapshot
    try {
        sourceSnapshot = snapshotPipelineSource(program)
    } catch {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_MODULES_INVALID',
            severity: 'error',
            phase: 'program',
            subject: program.subject,
            related: [ subject ],
            message: 'Program modules are invalid at the pipeline snapshot boundary.',
            expected: { modules: 'non-empty string[]' },
            actual: {
                modules: Array.isArray(program.modules)
                    ? program.modules.map(module => typeof module)
                    : typeof program.modules,
            },
        })
    }
    return Object.freeze({ ...draft, sourceSnapshot })
}

function renderPipelineDescriptorEvidence(plan: RenderPipelinePlan): {
    summary: Record<string, unknown>
    full: Record<string, unknown>
} {

    const identity = {
        pipelineKind: plan.pipelineKind,
        programId: plan.program.id,
        programSourceHash: plan.sourceSnapshot.combinedSourceHash,
        entryPoints: {
            vertex: plan.vertexEntryPoint,
            fragment: plan.fragmentEntryPoint,
        },
        bindLayouts: plan.bindLayouts.map(layout => ({ id: layout.id, group: layout.group })),
    }
    return {
        summary: {
            ...identity,
            targetFormats: plan.targetFormats,
            primitiveTopology: plan.primitive.topology ?? 'triangle-list',
            ...(plan.depthStencilFormat !== undefined
                ? { depthStencilFormat: plan.depthStencilFormat }
                : {}),
            sampleCount: plan.multisample?.count ?? 1,
        },
        full: {
            ...identity,
            ...(plan.label !== undefined ? { label: plan.label } : {}),
            vertexBuffers: plan.vertexBuffers,
            targets: plan.targets,
            primitive: plan.primitive,
            ...(plan.depthStencil !== undefined ? { depthStencil: plan.depthStencil } : {}),
            ...(plan.multisample !== undefined ? { multisample: plan.multisample } : {}),
        },
    }
}

function pipelineNativeLabels(label: string | undefined, pipelineId: string): PipelineNativeLabels {

    const suffix = ` [scratch:${pipelineId}]`
    if (label === undefined) {
        const fallback = `scratch:${pipelineId}`
        return Object.freeze({
            pipeline: fallback,
            shaderModule: fallback,
            pipelineLayout: fallback,
        })
    }
    return Object.freeze({
        pipeline: `${label}${suffix}`,
        shaderModule: `${label} shader module${suffix}`,
        pipelineLayout: `${label} layout${suffix}`,
    })
}

function nativeLabelEvidence(labels: PipelineNativeLabels): ScratchPipelineNativeLabelEvidence {

    return Object.freeze({
        pipeline: Object.freeze({ value: labels.pipeline, truncated: false }),
        shaderModule: Object.freeze({ value: labels.shaderModule, truncated: false }),
        pipelineLayout: Object.freeze({ value: labels.pipelineLayout, truncated: false }),
    })
}

function pipelineLifecycleFailures(plan: RenderPipelinePlan): PipelineCreationObservedFailure[] {

    if (plan.runtime.isDisposed) {
        return [ lifecycleFailure(
            'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED',
            'none',
            plan.runtime.subject
        ) ]
    }

    const failures: PipelineCreationObservedFailure[] = []
    if (plan.runtime.isDeviceLost) {
        failures.push(lifecycleFailure(
            'SCRATCH_PIPELINE_CREATION_DEVICE_LOST',
            'device-lost',
            plan.runtime.subject,
            plan.runtime.deviceLostInfo
        ))
    }
    if (plan.program.isDisposed) {
        failures.push(lifecycleFailure(
            'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED',
            'none',
            plan.program.subject
        ))
    }
    for (const layout of plan.bindLayouts) {
        if (!layout.isDisposed) continue
        failures.push(lifecycleFailure(
            'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED',
            'none',
            layout.subject
        ))
    }
    return failures
}

function lifecycleFailure(
    diagnosticCode: string,
    nativeErrorCategory: GpuNativeErrorCategory,
    subject: DiagnosticSubject,
    cause?: unknown
): PipelineCreationObservedFailure {

    return Object.freeze({
        outcome: Object.freeze({
            stage: 'lifecycle-recheck',
            diagnosticCode,
            nativeErrorCategory,
            subject,
            ...(cause !== undefined ? { nativeError: serializeNativeGpuError(cause) } : {}),
        }),
        ...(cause !== undefined ? { cause } : {}),
    })
}

function throwRenderPipelineCreationFailure(
    plan: RenderPipelinePlan,
    operation: ScratchPendingGpuOperation,
    issue: PipelineCreationIssueResult,
    observedFailures: readonly PipelineCreationObservedFailure[],
    nativeLabels: PipelineNativeLabels
): never {

    const failures = [ ...observedFailures ]
    if (failures.length === 0) {
        const cause = new TypeError('Pipeline creation settled without every required native result.')
        failures.push(Object.freeze({
            outcome: Object.freeze({
                stage: 'pipeline-creation',
                diagnosticCode: 'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
                nativeErrorCategory: 'native-exception',
                nativeError: serializeNativeGpuError(cause),
            }),
            cause,
        }))
    }

    const outcomes = Object.freeze(failures.map(failure => failure.outcome))
    const single = outcomes.length === 1 ? outcomes[0] : undefined
    const diagnosticCode = single?.diagnosticCode ?? 'SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES'
    const nativeErrorCategory = single?.nativeErrorCategory ?? 'none'
    const cancelled = failures.every(failure => isLifecycleCancellation(failure.outcome))
    const completion: ScratchGpuOperationCompletion = {
        status: cancelled ? 'cancelled' : 'failed',
        nativeErrorCategory,
        nativeLabels: nativeLabelEvidence(nativeLabels),
        ...(issue.compilationReport !== undefined
            ? { compilationReport: issue.compilationReport }
            : {}),
    }
    const controller = diagnosticsControllerFor(plan.runtime)
    const record = controller.completeOperation(operation, completion)
    const related = [
        plan.runtime.subject,
        plan.program.subject,
        ...plan.bindLayouts.map(layout => layout.subject),
        { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
    ]
    const incident = controller.recordIncident({
        kind: 'pipeline-failure',
        diagnosticCode,
        nativeErrorCategory,
        attribution: pipelineFailureAttribution(outcomes),
        target: operation.target,
        operationId: operation.id,
        triggerOperation: record,
        related,
        failureStage: outcomes[0].stage,
        ...(single?.pipelineErrorReason !== undefined
            ? { pipelineErrorReason: single.pipelineErrorReason }
            : {}),
        ...(single?.nativeError !== undefined ? { nativeError: single.nativeError } : {}),
        ...(issue.compilationReport !== undefined
            ? { compilationReport: issue.compilationReport }
            : {}),
        outcomes,
    })

    throwScratchDiagnostic({
        code: diagnosticCode,
        severity: 'error',
        phase: single?.diagnosticCode === 'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED'
            ? 'runtime'
            : 'pipeline',
        subject: plan.subject,
        related: [ ...related, incident.subject ],
        message: 'Render pipeline creation did not reach acknowledged ready state.',
        expected: { pipeline: 'all native, compilation, scope, and lifecycle outcomes successful' },
        actual: {
            operationId: operation.id,
            pipelineId: plan.id,
            failureCount: outcomes.length,
            failureStages: outcomes.map(outcome => outcome.stage),
            diagnosticCodes: outcomes.map(outcome => outcome.diagnosticCode),
        },
    }, {
        ...(failures[0].cause !== undefined ? { cause: failures[0].cause } : {}),
        incident,
    })
}

function isLifecycleCancellation(outcome: ScratchGpuIncidentOutcome): boolean {

    return outcome.stage === 'lifecycle-recheck'
}

function pipelineFailureAttribution(
    outcomes: readonly ScratchGpuIncidentOutcome[]
): GpuAttributionConfidence {

    if (outcomes.length !== 1) return 'unknown'
    if (outcomes[0].diagnosticCode === 'SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED') {
        return 'enclosing-operation-family'
    }
    if (outcomes[0].diagnosticCode === 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST') {
        return 'temporal-correlation'
    }
    if (outcomes[0].stage === 'lifecycle-recheck') return 'exact-operation'
    return 'exact-operation'
}

function freezeVertexBuffers(
    layouts: GPUVertexBufferLayout[]
): readonly GPUVertexBufferLayout[] {

    return Object.freeze(layouts.map((layout) => {
        const attributes: GPUVertexAttribute[] = layout.attributes
            .map(attribute => Object.freeze({ ...attribute }))
        Object.freeze(attributes)
        return Object.freeze({ ...layout, attributes })
    }))
}

function freezeColorTargets(
    targets: GPUColorTargetState[]
): readonly GPUColorTargetState[] {

    return Object.freeze(targets.map(target => Object.freeze({
        ...target,
        ...(target.blend !== undefined ? {
            blend: Object.freeze({
                color: Object.freeze({ ...target.blend.color }),
                alpha: Object.freeze({ ...target.blend.alpha }),
            }),
        } : {}),
    })))
}

function freezeDepthStencil(state: GPUDepthStencilState): Readonly<GPUDepthStencilState> {

    return Object.freeze({
        ...state,
        ...(state.stencilFront !== undefined
            ? { stencilFront: Object.freeze({ ...state.stencilFront }) }
            : {}),
        ...(state.stencilBack !== undefined
            ? { stencilBack: Object.freeze({ ...state.stencilBack }) }
            : {}),
    })
}

function defineImmutableProperties(
    pipeline: RenderPipeline,
    state: RenderPipelineState
): void {

    const values: Record<string, unknown> = {
        runtime: state.runtime,
        id: state.id,
        pipelineKind: state.pipelineKind,
        program: state.program,
        vertexEntryPoint: state.vertexEntryPoint,
        fragmentEntryPoint: state.fragmentEntryPoint,
        bindLayouts: state.bindLayouts,
        bindLayoutsByGroup: state.bindLayoutsByGroup,
        vertexBuffers: state.vertexBuffers,
        targets: state.targets,
        targetFormats: state.targetFormats,
        primitive: state.primitive,
        shaderModule: state.shaderModule,
        pipelineLayout: state.pipelineLayout,
        gpuPipeline: state.gpuPipeline,
        compilationReport: state.compilationReport,
        ...(state.label !== undefined ? { label: state.label } : {}),
        ...(state.depthStencil !== undefined ? { depthStencil: state.depthStencil } : {}),
        ...(state.depthStencilFormat !== undefined
            ? { depthStencilFormat: state.depthStencilFormat }
            : {}),
    }
    Object.defineProperties(pipeline, Object.fromEntries(
        Object.entries(values).map(([ key, value ]) => [ key, {
            value,
            enumerable: true,
            configurable: false,
            writable: false,
        } ])
    ))
}

function renderPipelineStateFor(pipeline: RenderPipeline): { isDisposed: boolean } {

    const state = renderPipelineStates.get(pipeline)
    if (state === undefined) throw new TypeError('RenderPipeline state is unavailable.')
    return state
}

export interface ComputePipeline {
    runtime: ScratchRuntime
    id: string
    label?: string
    pipelineKind: 'compute'
    program: Program
    computeEntryPoint: string
    bindLayouts: BindLayout[]
    bindLayoutsByGroup: Map<number, BindLayout>
    constants?: Record<string, GPUPipelineConstantValue>
    shaderModule: GPUShaderModule
    pipelineLayout: GPUPipelineLayout
    gpuPipeline: GPUComputePipeline
    isDisposed: boolean
}

export class ComputePipeline {

    constructor(runtime: ScratchRuntime, descriptor: ComputePipelineDescriptor = {} as ComputePipelineDescriptor) {

        runtime.assertActive()

        const program = descriptor.program
        if (!program || typeof program.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_PROGRAM_INVALID',
                severity: 'error',
                phase: 'pipeline',
                subject: { kind: 'Pipeline', pipelineKind: 'compute' },
                message: 'ComputePipeline requires a Program.',
                expected: { program: 'Program' },
                actual: { program: program === undefined || program === null ? String(program) : typeof program },
            })
        }

        program.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-pipeline-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.pipelineKind = 'compute'
        this.program = program
        this.computeEntryPoint = (descriptor.compute ?? program.entryPoints.compute) as string
        this.bindLayouts = normalizeBindLayouts(this, descriptor.bindLayouts)
        this.bindLayoutsByGroup = new Map(this.bindLayouts.map(layout => [ layout.group, layout ]))
        if (descriptor.constants !== undefined) this.constants = descriptor.constants
        this.isDisposed = false

        if (!this.computeEntryPoint) {
            throwMissingEntryPoint(this, 'compute')
        }
        validateProgramLayoutRequirements(this)

        const shaderModuleDescriptor: GPUShaderModuleDescriptor = {
            code: program.modules.join('\n'),
        }
        const shaderModuleLabel = labelWithSuffix(this.label, 'shader module')
        if (shaderModuleLabel !== undefined) shaderModuleDescriptor.label = shaderModuleLabel
        this.shaderModule = runtime.device.createShaderModule(shaderModuleDescriptor)

        const pipelineLayoutDescriptor: GPUPipelineLayoutDescriptor = {
            bindGroupLayouts: this.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        }
        const pipelineLayoutLabel = labelWithSuffix(this.label, 'layout')
        if (pipelineLayoutLabel !== undefined) pipelineLayoutDescriptor.label = pipelineLayoutLabel
        this.pipelineLayout = runtime.device.createPipelineLayout(pipelineLayoutDescriptor)

        const computeStage: GPUProgrammableStage = {
            module: this.shaderModule,
            entryPoint: this.computeEntryPoint,
        }
        if (this.constants !== undefined) computeStage.constants = this.constants

        const pipelineDescriptor: GPUComputePipelineDescriptor = {
            layout: this.pipelineLayout,
            compute: computeStage,
        }
        if (this.label !== undefined) pipelineDescriptor.label = this.label
        this.gpuPipeline = runtime.device.createComputePipeline(pipelineDescriptor)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'compute',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Pipeline belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_DISPOSED',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                message: 'Pipeline has been disposed.',
            })
        }

        this.runtime.assertActive()
        this.program.assertUsable()
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

function normalizeVertexBuffers(pipeline: PipelineValidationContext, vertexBuffers: GPUVertexBufferLayout[] = []): GPUVertexBufferLayout[] {

    if (!Array.isArray(vertexBuffers)) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { vertexBuffers: 'GPUVertexBufferLayout[]' },
            actual: { vertexBuffers },
        })
    }

    return vertexBuffers.map((layout: GPUVertexBufferLayout, slot) => {
        if (!layout || typeof layout !== 'object') {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { layout: 'GPUVertexBufferLayout' },
                actual: { slot, layout: describeValue(layout) },
            })
        }

        if (!Number.isInteger(layout.arrayStride) || layout.arrayStride <= 0) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { arrayStride: 'positive finite number' },
                actual: { slot, arrayStride: layout.arrayStride },
            })
        }

        if (layout.stepMode !== undefined && ![ 'vertex', 'instance' ].includes(layout.stepMode)) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { stepMode: [ 'vertex', 'instance' ] },
                actual: { slot, stepMode: layout.stepMode },
            })
        }

        if (!Array.isArray(layout.attributes) || layout.attributes.length === 0) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { attributes: 'non-empty GPUVertexAttribute[]' },
                actual: { slot, attributes: layout.attributes },
            })
        }

        const normalized: GPUVertexBufferLayout = {
            arrayStride: layout.arrayStride,
            attributes: layout.attributes.map((attribute: GPUVertexAttribute, attributeIndex: number) => normalizeVertexAttribute(
                pipeline,
                attribute,
                slot,
                attributeIndex
            )),
        }
        if (layout.stepMode !== undefined) normalized.stepMode = layout.stepMode

        return normalized
    })
}

function normalizeVertexAttribute(pipeline: PipelineValidationContext, attribute: GPUVertexAttribute, slot: number, attributeIndex: number): GPUVertexAttribute {

    if (!attribute || typeof attribute !== 'object') {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { attribute: 'GPUVertexAttribute' },
            actual: {
                slot,
                attributeIndex,
                attribute: describeValue(attribute),
            },
        })
    }

    if (!Number.isInteger(attribute.shaderLocation) || attribute.shaderLocation < 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { shaderLocation: 'non-negative integer' },
            actual: { slot, attributeIndex, shaderLocation: attribute.shaderLocation },
        })
    }

    if (!Number.isInteger(attribute.offset) || attribute.offset < 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { offset: 'non-negative integer' },
            actual: { slot, attributeIndex, offset: attribute.offset },
        })
    }

    if (typeof attribute.format !== 'string' || attribute.format.length === 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { format: 'GPUVertexFormat' },
            actual: { slot, attributeIndex, format: attribute.format },
        })
    }

    return {
        shaderLocation: attribute.shaderLocation,
        offset: attribute.offset,
        format: attribute.format,
    }
}

function throwVertexLayoutDiagnostic(pipeline: PipelineValidationContext, { expected, actual }: { expected: unknown, actual: unknown }): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        related: [ pipeline.program?.subject ].filter(Boolean),
        message: 'RenderPipeline vertex buffer layout is invalid.',
        expected,
        actual,
    })
}

function normalizeBindLayouts(
    pipeline: PipelineValidationContext,
    bindLayouts: BindLayout[] = []
): BindLayout[] {

    if (!Array.isArray(bindLayouts)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'RenderPipeline bindLayouts must be an array.',
            expected: { bindLayouts: 'BindLayout[]' },
            actual: { bindLayouts },
        })
    }

    const groups = new Set<number>()
    return bindLayouts.map((layout: BindLayout) => {
        if (!layout || typeof layout.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline bindLayouts must contain BindLayout objects.',
                expected: { bindLayout: 'BindLayout' },
                actual: { bindLayout: describeValue(layout) },
            })
        }

        layout.assertRuntime(pipeline.runtime)

        if (groups.has(layout.group)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                related: [ layout.subject ],
                message: 'RenderPipeline cannot use more than one BindLayout for the same group.',
                expected: { group: 'unique' },
                actual: { group: layout.group },
            })
        }
        groups.add(layout.group)

        return layout
    })
}

function normalizeTargets(pipeline: PipelineValidationContext, targets: GPUColorTargetState[]): GPUColorTargetState[] {

    if (!Array.isArray(targets) || targets.length === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'RenderPipeline requires at least one color target format.',
            expected: { targets: 'non-empty array' },
            actual: { targets },
        })
    }

    return targets.map((target) => {
        if (!target || typeof target.format !== 'string') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline target requires a texture format.',
                expected: { format: 'GPUTextureFormat' },
                actual: { target },
            })
        }

        return { ...target }
    })
}

function validateProgramLayoutRequirements(pipeline: PipelineValidationContext): void {

    for (const requirement of pipeline.program.layoutRequirements) {
        const bindLayout = pipeline.bindLayoutsByGroup.get(requirement.group)
        if (bindLayout === undefined) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [ pipeline.program.subject, pipeline.subject ],
                actual: { group: undefined },
            })
        }

        const entry = bindLayout.entries.find(candidate => candidate.binding === requirement.binding)
        if (entry === undefined) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                ],
                actual: {
                    group: bindLayout.group,
                    bindings: bindLayout.entries.map(candidate => candidate.binding),
                },
            })
        }

        if (requirement.name !== undefined && entry.name !== requirement.name) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { name: entry.name },
            })
        }

        if (entry.type !== requirement.type) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { type: entry.type },
            })
        }

        if (requirement.visibility !== undefined && !requirement.visibility.every(stage => entry.visibility.includes(stage))) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { visibility: entry.visibility },
            })
        }
    }
}

function throwProgramLayoutMismatch(
    pipeline: PipelineValidationContext,
    requirement: ProgramBufferLayoutRequirement,
    details: {
        actual: unknown
        related: DiagnosticSubject[]
    }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
        subject: programLayoutRequirementSubject(requirement),
        related: details.related,
        message: 'Pipeline bind layouts do not satisfy Program buffer layout requirements.',
        expected: programLayoutRequirementExpected(requirement),
        actual: details.actual,
    })
}

function validateEntryPoints(pipeline: PipelineValidationContext & {
    vertexEntryPoint: string
    fragmentEntryPoint: string
}) {

    if (!pipeline.vertexEntryPoint) {
        throwMissingEntryPoint(pipeline, 'vertex')
    }

    if (!pipeline.fragmentEntryPoint) {
        throwMissingEntryPoint(pipeline, 'fragment')
    }
}

function throwMissingEntryPoint(pipeline: PipelineValidationContext, stage: 'vertex' | 'fragment' | 'compute') {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING',
        severity: 'error',
        phase: 'program',
        subject: {
            kind: 'ShaderEntryPoint',
            programId: pipeline.program.id,
            name: '',
            stage,
        },
        related: [ pipeline.program.subject, pipeline.subject ],
        message: 'RenderPipeline requires a Program entry point for each shader stage.',
        expected: { stage, entryPoint: 'string' },
        actual: { entryPoint: undefined },
    })
}

function labelWithSuffix(label: string | undefined, suffix: string) {

    return label === undefined ? undefined : `${label} ${suffix}`
}
