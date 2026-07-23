import { UUID } from '../core/utils/uuid.js'
import {
    createNativeDerivedBindLayout,
    firstBindingLimitViolation,
    isBindLayout,
    normalizeBindLayoutDescriptor,
} from './binding.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import {
    issuePipelineCreation,
} from './pipeline-creation.js'
import {
    createPipelineCreationReport,
    snapshotPipelineSource,
} from './pipeline-compilation.js'
import { createPipelineNativeErrorSerializer } from './pipeline-native-error.js'
import { registerRuntimePipeline, unregisterRuntimePipeline } from './pipeline-ownership.js'
import { describeValue } from './type-utils.js'
import {
    assertProgramPipelineAuthority,
    assertProgramUsableAuthority,
    isProgram,
    observeProgramPipelineAuthority,
    programAuthoritySubject,
    programLayoutRequirementExpected,
    programLayoutRequirementSubject,
    snapshotProgramPipelineFacts,
} from './program.js'
import { shaderModuleSourceSnapshot } from './shader-module.js'
import { readonlyMapSnapshot } from './readonly-map.js'
import {
    assertScratchRuntimeActive,
    scratchRuntimeAuthoritySubject,
} from './runtime-authority.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type {
    BindLayout,
    BindLayoutDescriptor,
    NormalizedBindLayoutDescriptor,
} from './binding.js'
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
import type {
    PipelineCreationReport,
    PipelineSourceSnapshot,
} from './pipeline-compilation.js'
import type {
    Program,
    ProgramBufferLayoutRequirement,
    ProgramPipelineAuthorityStamp,
    ProgramStage,
} from './program.js'
import type { ScratchGpuOperationCompletion, ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const renderPipelineToken = Symbol('RenderPipeline')
type PipelineObjectState = {
    isDisposed: boolean
    bindLayoutsByGroup: Map<number, BindLayout>
    derivedLayoutPromises: Map<number, Promise<BindLayout>>
    derivedLayoutSignatures: Map<number, string>
}
const renderPipelineStates = new WeakMap<RenderPipeline, PipelineObjectState>()
const computePipelineToken = Symbol('ComputePipeline')
const computePipelineStates = new WeakMap<ComputePipeline, PipelineObjectState>()
const pipelineProgramLayoutRequirements = new WeakMap<
    RenderPipeline | ComputePipeline,
    readonly ProgramBufferLayoutRequirement[]
>()
const renderPipelineLayouts = new WeakMap<RenderPipeline, RenderPipelineLayoutSnapshot>()

export type RenderPipelineLayoutSnapshot = Readonly<{
    colorFormats: readonly (GPUTextureFormat | null)[]
    depthStencilFormat?: GPUTextureFormat
    sampleCount: number
    immediateSize: number
}>

export type RenderPipelineDescriptor = {
    label?: string
    program: Program
    layout?: PipelineLayoutDescriptor
    vertexBuffers?: readonly (GPUVertexBufferLayout | null)[]
    targets?: readonly (GPUColorTargetState | null)[]
    primitive?: GPUPrimitiveState
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
    immediateSize?: number
}

export type ComputePipelineDescriptor = {
    label?: string
    program: Program
    layout?: PipelineLayoutDescriptor
    immediateSize?: number
}

export type PipelineLayoutDescriptor =
    | Readonly<{
        mode: 'explicit'
        bindLayouts?: readonly BindLayout[]
    }>
    | Readonly<{
        mode: 'auto'
    }>

export interface RenderPipeline {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly pipelineKind: 'render'
    readonly program: Program
    readonly vertex: ProgramStage
    readonly fragment?: ProgramStage
    readonly layoutMode: 'explicit' | 'auto'
    readonly bindLayouts: readonly BindLayout[]
    readonly bindLayoutsByGroup: ReadonlyMap<number, BindLayout>
    readonly vertexBuffers: readonly (GPUVertexBufferLayout | null)[]
    readonly targets: readonly (GPUColorTargetState | null)[]
    readonly targetFormats: readonly (GPUTextureFormat | null)[]
    readonly primitive: Readonly<GPUPrimitiveState>
    readonly depthStencil?: Readonly<GPUDepthStencilState>
    readonly depthStencilFormat?: GPUTextureFormat
    readonly immediateSize: number
    readonly pipelineLayout?: GPUPipelineLayout
    readonly gpuPipeline: GPURenderPipeline
    readonly creationReport: PipelineCreationReport
    getBindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout>
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
        renderPipelineStates.set(this, {
            isDisposed: false,
            bindLayoutsByGroup: new Map(
                state.bindLayouts.map(layout => [ layout.group, layout ])
            ),
            derivedLayoutPromises: new Map(),
            derivedLayoutSignatures: new Map(),
        })
        pipelineProgramLayoutRequirements.set(this, state.layoutRequirements)
        renderPipelineLayouts.set(this, Object.freeze({
            colorFormats: state.targetFormats,
            ...(state.depthStencilFormat !== undefined
                ? { depthStencilFormat: state.depthStencilFormat }
                : {}),
            sampleCount: state.multisample?.count ?? 1,
            immediateSize: state.immediateSize,
        }))
        defineImmutableRenderProperties(this, state)
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
        if (this.label !== undefined) subject.label = boundedPipelineDiagnosticLabel(this.label)

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

        assertScratchRuntimeActive(this.runtime)
        assertProgramUsableAuthority(this.program)
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    async getBindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout> {

        return getPipelineBindLayout(this, descriptor)
    }

    dispose(): void {

        const state = renderPipelineStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        disposeDerivedPipelineLayouts(state)
        unregisterRuntimePipeline(this.runtime, this)
    }
}

export function isRenderPipeline(value: unknown): value is RenderPipeline {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === RenderPipeline.prototype &&
        renderPipelineStates.has(value as RenderPipeline)
}

type PipelineValidationContext = {
    runtime: ScratchRuntime
    id: string
    label?: string
    pipelineKind: 'render' | 'compute'
    program: Program
    programAuthority: ProgramPipelineAuthorityStamp
    subject: DiagnosticSubject
    layoutMode: 'explicit' | 'auto'
    bindLayouts: readonly BindLayout[]
    bindLayoutsByGroup: ReadonlyMap<number, BindLayout>
    layoutRequirements: readonly ProgramBufferLayoutRequirement[]
}

type PipelineCreationPlan = PipelineValidationContext & Readonly<{
    immediateSize: number
    sourceSnapshot: PipelineSourceSnapshot
    creationReport: PipelineCreationReport
}>

type RenderPipelinePlan = PipelineValidationContext & Readonly<{
    pipelineKind: 'render'
    immediateSize: number
    vertex: ProgramStage
    fragment?: ProgramStage
    vertexBuffers: readonly (GPUVertexBufferLayout | null)[]
    targets: readonly (GPUColorTargetState | null)[]
    targetFormats: readonly (GPUTextureFormat | null)[]
    primitive: Readonly<GPUPrimitiveState>
    depthStencil?: Readonly<GPUDepthStencilState>
    depthStencilFormat?: GPUTextureFormat
    multisample?: Readonly<GPUMultisampleState>
    sourceSnapshot: PipelineSourceSnapshot
    creationReport: PipelineCreationReport
}>

type RenderPipelineState = RenderPipelinePlan & Readonly<{
    pipelineLayout?: GPUPipelineLayout
    gpuPipeline: GPURenderPipeline
}>

export async function createRenderPipeline(
    runtime: ScratchRuntime,
    descriptor: RenderPipelineDescriptor
): Promise<RenderPipeline> {

    const plan = prepareRenderPipeline(runtime, descriptor)
    assertProgramPipelineAuthority(plan.programAuthority)
    const nativeLabels = pipelineNativeLabels(plan.label, plan.id)
    const controller = diagnosticsControllerFor(runtime)
    const target = {
        kind: 'pipeline' as const,
        pipelineId: plan.id,
        pipelineKind: 'render' as const,
        programId: plan.program.id,
        programContractHash: plan.creationReport.contractHash,
    }
    const descriptorEvidence = renderPipelineDescriptorEvidence(plan)
    const operation = controller.beginOperation({
        kind: 'render-pipeline-creation',
        target,
        descriptorSummary: descriptorEvidence.summary,
        fullDescriptor: descriptorEvidence.full,
        nativeLabel: nativeLabels.pipeline,
    })
    const observedIssue = await observePipelineDeviceLoss(controller, () => issuePipelineCreation({
        runtime,
        pipelineId: plan.id,
        pipelineKind: 'render',
        sourceSnapshot: plan.sourceSnapshot,
        nativeLabels,
        layout: plan.layoutMode === 'auto'
            ? 'auto'
            : {
                bindGroupLayouts: nativeBindGroupLayouts(plan.bindLayouts),
                immediateSize: plan.immediateSize,
            },
        lowerPipelineDescriptor: (pipelineLayout) => {
            const nativeDescriptor: GPURenderPipelineDescriptor = {
                label: nativeLabels.pipeline,
                layout: pipelineLayout,
                vertex: {
                    module: plan.vertex.module.gpuShaderModule,
                    buffers: [ ...plan.vertexBuffers ],
                    ...(plan.vertex.entryPoint !== undefined
                        ? { entryPoint: plan.vertex.entryPoint }
                        : {}),
                    ...(plan.vertex.constants !== undefined
                        ? { constants: plan.vertex.constants }
                        : {}),
                },
                primitive: plan.primitive,
            }
            if (plan.fragment !== undefined) {
                nativeDescriptor.fragment = {
                    module: plan.fragment.module.gpuShaderModule,
                    ...(plan.fragment.entryPoint !== undefined
                        ? { entryPoint: plan.fragment.entryPoint }
                        : {}),
                    targets: [ ...plan.targets ],
                    ...(plan.fragment.constants !== undefined
                        ? { constants: plan.fragment.constants }
                        : {}),
                }
            }
            if (plan.depthStencil !== undefined) nativeDescriptor.depthStencil = plan.depthStencil
            if (plan.multisample !== undefined) nativeDescriptor.multisample = plan.multisample
            return nativeDescriptor
        },
    }))
    const issue = observedIssue.result
    const failures = [
        ...issue.failures,
        ...pipelineLifecycleFailures(plan, observedIssue.deviceLostInfo),
    ]
    if (
        failures.length > 0 ||
        issue.nativePipeline === undefined ||
        (plan.layoutMode === 'explicit' && issue.pipelineLayout === undefined)
    ) {
        throwPipelineCreationFailure(
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
        pipelineCreationReport: plan.creationReport,
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
        ...(issue.pipelineLayout !== undefined ? { pipelineLayout: issue.pipelineLayout } : {}),
        gpuPipeline: issue.nativePipeline as GPURenderPipeline,
    })
    registerRuntimePipeline(runtime, pipeline, creationRecord)
    return pipeline
}

function prepareRenderPipeline(
    runtime: ScratchRuntime,
    descriptor: RenderPipelineDescriptor
): RenderPipelinePlan {

    assertScratchRuntimeActive(runtime)
    const input = descriptor ?? {} as RenderPipelineDescriptor
    const program = input.program
    if (!isProgram(program)) {
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
    const programSnapshot = snapshotProgramPipelineFacts(program, runtime)
    const programFacts = programSnapshot.facts
    const layoutRequirements = programFacts.layoutRequirements

    const id = `scratch-pipeline-${UUID()}`
    const subject = Object.freeze({
        kind: 'Pipeline',
        id,
        pipelineKind: 'render',
        ...(input.label !== undefined
            ? { label: boundedPipelineDiagnosticLabel(input.label) }
            : {}),
    })
    const context: PipelineValidationContext & { pipelineKind: 'render' } = {
        runtime,
        id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        pipelineKind: 'render',
        program,
        programAuthority: programSnapshot.authority,
        subject,
        layoutMode: 'explicit',
        bindLayouts: Object.freeze([]),
        bindLayoutsByGroup: readonlyMapSnapshot(new Map()),
        layoutRequirements,
    }
    const normalizedLayout = normalizePipelineLayout(context, input.layout)
    context.layoutMode = normalizedLayout.mode
    const bindLayouts = normalizedLayout.bindLayouts
    const bindLayoutsByGroup = readonlyMapSnapshot(
        new Map(bindLayouts.map(layout => [ layout.group, layout ]))
    )
    const immediateSize = normalizePipelineImmediateSize(
        context,
        input.immediateSize,
        programFacts.requiredLanguageFeatures
    )
    const vertexBuffers = freezeVertexBuffers(normalizeVertexBuffers(context, input.vertexBuffers))
    const vertex = programFacts.vertex
    if (vertex === undefined) throwMissingProgramStage(context, 'vertex')
    const fragment = programFacts.fragment
    const targets = normalizeRenderTargetsForFragment(context, fragment, input.targets)
    const primitive = Object.freeze({
        topology: 'triangle-list' as GPUPrimitiveTopology,
        ...input.primitive,
    })
    const depthStencil = input.depthStencil === undefined
        ? undefined
        : freezeDepthStencil(input.depthStencil)
    validateRenderPipelineHasAttachment(context, targets, depthStencil)
    const multisample = input.multisample === undefined
        ? undefined
        : Object.freeze({ ...input.multisample })
    const draft: Omit<RenderPipelinePlan, 'sourceSnapshot'> = {
        ...context,
        layoutMode: normalizedLayout.mode,
        bindLayouts,
        bindLayoutsByGroup,
        immediateSize,
        vertex,
        ...(fragment !== undefined ? { fragment } : {}),
        vertexBuffers,
        targets,
        targetFormats: Object.freeze(targets.map(target => target?.format ?? null)),
        primitive,
        ...(depthStencil !== undefined ? {
            depthStencil,
            depthStencilFormat: depthStencil.format,
        } : {}),
        ...(multisample !== undefined ? { multisample } : {}),
        creationReport: createPipelineCreationReport({
            pipelineId: id,
            pipelineKind: 'render',
            programId: program.id,
            stages: [
                pipelineCreationStage('vertex', vertex),
                ...(fragment !== undefined
                    ? [ pipelineCreationStage('fragment', fragment) ]
                    : []),
            ],
        }),
    }
    if (draft.layoutMode === 'explicit') validateProgramLayoutRequirements(draft)

    const plan = Object.freeze({
        ...draft,
        sourceSnapshot: snapshotProgramSource(
            program,
            [ vertex, fragment ].filter((stage): stage is ProgramStage => stage !== undefined),
            subject
        ),
    })
    assertProgramPipelineAuthority(plan.programAuthority)
    return plan
}

function snapshotProgramSource(
    program: Program,
    stages: readonly ProgramStage[],
    pipelineSubject: DiagnosticSubject
): PipelineSourceSnapshot {

    try {
        const modules: string[] = []
        const seen = new Set<string>()
        for (const stage of stages) {
            const snapshot = shaderModuleSourceSnapshot(stage.module)
            if (seen.has(snapshot.shaderModuleId)) continue
            seen.add(snapshot.shaderModuleId)
            modules.push(...snapshot.sourceParts.map(part => part.code))
        }
        return snapshotPipelineSource({ id: program.id, modules })
    } catch {
        throwScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_STAGE_INVALID',
            severity: 'error',
            phase: 'program',
            subject: programAuthoritySubject(program),
            related: [ pipelineSubject ],
            message: 'Program ShaderModule stages are invalid at the pipeline snapshot boundary.',
            expected: { stages: 'usable ShaderModule stages' },
            actual: { stageCount: stages.length },
        })
    }
}

function renderPipelineDescriptorEvidence(plan: RenderPipelinePlan): {
    summary: Record<string, unknown>
    full: Record<string, unknown>
} {

    const identity = {
        pipelineKind: plan.pipelineKind,
        programId: plan.program.id,
        programContractHash: plan.creationReport.contractHash,
        stages: plan.creationReport.stages,
        immediateSize: plan.immediateSize,
        layoutMode: plan.layoutMode,
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
            pipelineLayout: fallback,
        })
    }
    return Object.freeze({
        pipeline: `${label}${suffix}`,
        pipelineLayout: `${label} layout${suffix}`,
    })
}

function nativeLabelEvidence(labels: PipelineNativeLabels): ScratchPipelineNativeLabelEvidence {

    return Object.freeze({
        pipeline: Object.freeze({ value: labels.pipeline, truncated: false }),
        pipelineLayout: Object.freeze({ value: labels.pipelineLayout, truncated: false }),
    })
}

function pipelineLifecycleFailures(
    plan: PipelineCreationPlan,
    observedDeviceLostInfo?: GPUDeviceLostInfo
): PipelineCreationObservedFailure[] {

    const failures: PipelineCreationObservedFailure[] = []
    const serializeNativeError = createPipelineNativeErrorSerializer(plan.sourceSnapshot)
    const authority = observeProgramPipelineAuthority(plan.programAuthority)
    if (authority.runtime.isDisposed) {
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED',
            'none',
            scratchRuntimeAuthoritySubject(plan.runtime)
        ))
    }

    if (authority.runtime.isDeviceLost) {
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_DEVICE_LOST',
            'device-lost',
            scratchRuntimeAuthoritySubject(plan.runtime),
            observedDeviceLostInfo ?? authority.runtime.deviceLostInfo
        ))
    }
    if (!authority.runtime.isCurrent && !authority.runtime.isDisposed && !authority.runtime.isDeviceLost) {
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_RUNTIME_LIFECYCLE_CHANGED',
            'none',
            scratchRuntimeAuthoritySubject(plan.runtime)
        ))
    }
    if (authority.isProgramDisposed) {
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED',
            'none',
            programAuthoritySubject(plan.program)
        ))
    } else if (!authority.isProgramCurrent) {
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_PROGRAM_LIFECYCLE_CHANGED',
            'none',
            programAuthoritySubject(plan.program)
        ))
    }
    for (const stage of pipelineStages(plan)) {
        if (!stage.module.isDisposed) continue
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_SHADER_MODULE_DISPOSED',
            'none',
            stage.module.subject
        ))
    }
    for (const layout of plan.bindLayouts) {
        if (!layout.isDisposed) continue
        failures.push(lifecycleFailure(serializeNativeError,
            'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED',
            'none',
            layout.subject
        ))
    }
    return failures
}

async function observePipelineDeviceLoss<T>(
    controller: ReturnType<typeof diagnosticsControllerFor>,
    issue: () => Promise<T>
): Promise<Readonly<{ result: T, deviceLostInfo?: GPUDeviceLostInfo }>> {

    let deviceLostInfo: GPUDeviceLostInfo | undefined
    const unsubscribe = controller.subscribeLifecycle(change => {
        if (change.kind === 'device-lost' && deviceLostInfo === undefined) {
            deviceLostInfo = change.info
        }
    })
    try {
        const result = await issue()
        return Object.freeze({
            result,
            ...(deviceLostInfo !== undefined ? { deviceLostInfo } : {}),
        })
    } finally {
        unsubscribe()
    }
}

function lifecycleFailure(
    serializeNativeError: ReturnType<typeof createPipelineNativeErrorSerializer>,
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
            ...(cause !== undefined ? { nativeError: serializeNativeError(cause) } : {}),
        }),
        ...(cause !== undefined ? { cause } : {}),
    })
}

function throwPipelineCreationFailure(
    plan: PipelineCreationPlan,
    operation: ScratchPendingGpuOperation,
    issue: PipelineCreationIssueResult,
    observedFailures: readonly PipelineCreationObservedFailure[],
    nativeLabels: PipelineNativeLabels
): never {

    const failures = [ ...observedFailures ]
    if (failures.length === 0) {
        const cause = new TypeError('Pipeline creation settled without every required native result.')
        const serializeNativeError = createPipelineNativeErrorSerializer(plan.sourceSnapshot)
        failures.push(Object.freeze({
            outcome: Object.freeze({
                stage: 'pipeline-creation',
                diagnosticCode: 'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
                nativeErrorCategory: 'native-exception',
                nativeError: serializeNativeError(cause),
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
        pipelineCreationReport: plan.creationReport,
    }
    const controller = diagnosticsControllerFor(plan.runtime)
    const record = controller.completeOperation(operation, completion)
    const related = [
        scratchRuntimeAuthoritySubject(plan.runtime),
        programAuthoritySubject(plan.program),
        { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
        ...plan.bindLayouts.map(layout => layout.subject),
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
        pipelineCreationReport: plan.creationReport,
        outcomes,
    })
    const retainedOutcomes = incident.kind === 'pipeline-failure'
        ? incident.outcomes ?? []
        : []

    throwScratchDiagnostic({
        code: diagnosticCode,
        severity: 'error',
        phase: single?.diagnosticCode === 'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED'
            ? 'runtime'
            : 'pipeline',
        subject: incident.subject,
        related: [
            ...incident.related,
            { kind: 'Incident', id: incident.id, incidentKind: incident.kind },
        ],
        message: `${plan.pipelineKind === 'render' ? 'Render' : 'Compute'} pipeline creation did not reach acknowledged ready state.`,
        expected: { pipeline: 'all native, compilation, scope, and lifecycle outcomes successful' },
        actual: {
            operationId: operation.id,
            pipelineId: plan.id,
            failureCount: outcomes.length,
            retainedFailureCount: retainedOutcomes.length,
            omittedFailureCount: outcomes.length - retainedOutcomes.length,
            failureStages: retainedOutcomes.map(outcome => outcome.stage),
            diagnosticCodes: retainedOutcomes.map(outcome => outcome.diagnosticCode),
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
    layouts: (GPUVertexBufferLayout | null)[]
): readonly (GPUVertexBufferLayout | null)[] {

    return Object.freeze(layouts.map((layout) => {
        if (layout === null) return null
        const attributes: GPUVertexAttribute[] = layout.attributes
            .map(attribute => Object.freeze({ ...attribute }))
        Object.freeze(attributes)
        return Object.freeze({ ...layout, attributes })
    }))
}

function freezeColorTargets(
    targets: (GPUColorTargetState | null)[]
): readonly (GPUColorTargetState | null)[] {

    return Object.freeze(targets.map(target => target === null
        ? null
        : Object.freeze({
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

function defineImmutableRenderProperties(
    pipeline: RenderPipeline,
    state: RenderPipelineState
): void {

    const values: Record<string, unknown> = {
        runtime: state.runtime,
        id: state.id,
        pipelineKind: state.pipelineKind,
        program: state.program,
        vertex: state.vertex,
        ...(state.fragment !== undefined ? { fragment: state.fragment } : {}),
        layoutMode: state.layoutMode,
        vertexBuffers: state.vertexBuffers,
        targets: state.targets,
        targetFormats: state.targetFormats,
        primitive: state.primitive,
        immediateSize: state.immediateSize,
        ...(state.pipelineLayout !== undefined
            ? { pipelineLayout: state.pipelineLayout }
            : {}),
        gpuPipeline: state.gpuPipeline,
        creationReport: state.creationReport,
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
    Object.defineProperties(pipeline, pipelineBindLayoutProperties(
        () => renderPipelineStateFor(pipeline)
    ))
}

function renderPipelineStateFor(pipeline: RenderPipeline): PipelineObjectState {

    const state = renderPipelineStates.get(pipeline)
    if (state === undefined) throw new TypeError('RenderPipeline state is unavailable.')
    return state
}

export interface ComputePipeline {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly pipelineKind: 'compute'
    readonly program: Program
    readonly compute: ProgramStage
    readonly layoutMode: 'explicit' | 'auto'
    readonly bindLayouts: readonly BindLayout[]
    readonly bindLayoutsByGroup: ReadonlyMap<number, BindLayout>
    readonly immediateSize: number
    readonly pipelineLayout?: GPUPipelineLayout
    readonly gpuPipeline: GPUComputePipeline
    readonly creationReport: PipelineCreationReport
    getBindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout>
}

export class ComputePipeline {

    private constructor(token: symbol, state?: ComputePipelineState) {

        if (token !== computePipelineToken || state === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'pipeline',
                subject: { kind: 'Pipeline', pipelineKind: 'compute' },
                message: 'ComputePipeline is created only by ScratchRuntime.',
                hints: [ 'Use await runtime.createComputePipeline(descriptor).' ],
            })
        }
        computePipelineStates.set(this, {
            isDisposed: false,
            bindLayoutsByGroup: new Map(
                state.bindLayouts.map(layout => [ layout.group, layout ])
            ),
            derivedLayoutPromises: new Map(),
            derivedLayoutSignatures: new Map(),
        })
        pipelineProgramLayoutRequirements.set(this, state.layoutRequirements)
        defineImmutableComputeProperties(this, state)
        Object.preventExtensions(this)
    }

    get isDisposed(): boolean {

        return computePipelineStateFor(this).isDisposed
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'compute',
        }
        if (this.label !== undefined) subject.label = boundedPipelineDiagnosticLabel(this.label)

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

        assertScratchRuntimeActive(this.runtime)
        assertProgramUsableAuthority(this.program)
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    async getBindLayout(descriptor: BindLayoutDescriptor): Promise<BindLayout> {

        return getPipelineBindLayout(this, descriptor)
    }

    dispose(): void {

        const state = computePipelineStateFor(this)
        if (state.isDisposed) return
        state.isDisposed = true
        disposeDerivedPipelineLayouts(state)
        unregisterRuntimePipeline(this.runtime, this)
    }
}

export function isComputePipeline(value: unknown): value is ComputePipeline {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === ComputePipeline.prototype &&
        computePipelineStates.has(value as ComputePipeline)
}

type ComputePipelinePlan = PipelineCreationPlan & Readonly<{
    pipelineKind: 'compute'
    compute: ProgramStage
    creationReport: PipelineCreationReport
}>

type ComputePipelineState = ComputePipelinePlan & Readonly<{
    pipelineLayout?: GPUPipelineLayout
    gpuPipeline: GPUComputePipeline
}>

export async function createComputePipeline(
    runtime: ScratchRuntime,
    descriptor: ComputePipelineDescriptor
): Promise<ComputePipeline> {

    const plan = prepareComputePipeline(runtime, descriptor)
    assertProgramPipelineAuthority(plan.programAuthority)
    const nativeLabels = pipelineNativeLabels(plan.label, plan.id)
    const controller = diagnosticsControllerFor(runtime)
    const target = {
        kind: 'pipeline' as const,
        pipelineId: plan.id,
        pipelineKind: 'compute' as const,
        programId: plan.program.id,
        programContractHash: plan.creationReport.contractHash,
    }
    const descriptorEvidence = computePipelineDescriptorEvidence(plan)
    const operation = controller.beginOperation({
        kind: 'compute-pipeline-creation',
        target,
        descriptorSummary: descriptorEvidence.summary,
        fullDescriptor: descriptorEvidence.full,
        nativeLabel: nativeLabels.pipeline,
    })
    const observedIssue = await observePipelineDeviceLoss(controller, () => issuePipelineCreation({
        runtime,
        pipelineId: plan.id,
        pipelineKind: 'compute',
        sourceSnapshot: plan.sourceSnapshot,
        nativeLabels,
        layout: plan.layoutMode === 'auto'
            ? 'auto'
            : {
                bindGroupLayouts: nativeBindGroupLayouts(plan.bindLayouts),
                immediateSize: plan.immediateSize,
            },
        lowerPipelineDescriptor: (pipelineLayout) => {
            const compute: GPUProgrammableStage = {
                module: plan.compute.module.gpuShaderModule,
                ...(plan.compute.entryPoint !== undefined
                    ? { entryPoint: plan.compute.entryPoint }
                    : {}),
            }
            if (plan.compute.constants !== undefined) {
                compute.constants = plan.compute.constants
            }
            return {
                label: nativeLabels.pipeline,
                layout: pipelineLayout,
                compute,
            }
        },
    }))
    const issue = observedIssue.result
    const failures = [
        ...issue.failures,
        ...pipelineLifecycleFailures(plan, observedIssue.deviceLostInfo),
    ]
    if (
        failures.length > 0 ||
        issue.nativePipeline === undefined ||
        (plan.layoutMode === 'explicit' && issue.pipelineLayout === undefined)
    ) {
        throwPipelineCreationFailure(
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
        pipelineCreationReport: plan.creationReport,
    }
    const creationRecord = controller.completeOperation(operation, completion)
    if (
        creationRecord.kind !== 'compute-pipeline-creation' ||
        creationRecord.target.kind !== 'pipeline'
    ) {
        throw new TypeError('Compute pipeline creation produced an incompatible operation record.')
    }
    const Constructor = ComputePipeline as unknown as new (
        token: symbol,
        state: ComputePipelineState
    ) => ComputePipeline
    const pipeline = new Constructor(computePipelineToken, {
        ...plan,
        ...(issue.pipelineLayout !== undefined ? { pipelineLayout: issue.pipelineLayout } : {}),
        gpuPipeline: issue.nativePipeline as GPUComputePipeline,
    })
    registerRuntimePipeline(runtime, pipeline, creationRecord)
    return pipeline
}

function prepareComputePipeline(
    runtime: ScratchRuntime,
    descriptor: ComputePipelineDescriptor
): ComputePipelinePlan {

    assertScratchRuntimeActive(runtime)
    const input = descriptor ?? {} as ComputePipelineDescriptor
    const program = input.program
    if (!isProgram(program)) {
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
    const programSnapshot = snapshotProgramPipelineFacts(program, runtime)
    const programFacts = programSnapshot.facts
    const layoutRequirements = programFacts.layoutRequirements

    const id = `scratch-pipeline-${UUID()}`
    const subject = Object.freeze({
        kind: 'Pipeline',
        id,
        pipelineKind: 'compute',
        ...(input.label !== undefined
            ? { label: boundedPipelineDiagnosticLabel(input.label) }
            : {}),
    })
    const context: PipelineValidationContext & { pipelineKind: 'compute' } = {
        runtime,
        id,
        ...(input.label !== undefined ? { label: input.label } : {}),
        pipelineKind: 'compute',
        program,
        programAuthority: programSnapshot.authority,
        subject,
        layoutMode: 'explicit',
        bindLayouts: Object.freeze([]),
        bindLayoutsByGroup: readonlyMapSnapshot(new Map()),
        layoutRequirements,
    }
    const normalizedLayout = normalizePipelineLayout(context, input.layout)
    context.layoutMode = normalizedLayout.mode
    const bindLayouts = normalizedLayout.bindLayouts
    const bindLayoutsByGroup = readonlyMapSnapshot(
        new Map(bindLayouts.map(layout => [ layout.group, layout ]))
    )
    const immediateSize = normalizePipelineImmediateSize(
        context,
        input.immediateSize,
        programFacts.requiredLanguageFeatures
    )
    const compute = programFacts.compute
    if (compute === undefined) throwMissingProgramStage(context, 'compute')
    const draft: Omit<ComputePipelinePlan, 'sourceSnapshot'> = {
        ...context,
        layoutMode: normalizedLayout.mode,
        bindLayouts,
        bindLayoutsByGroup,
        immediateSize,
        compute,
        creationReport: createPipelineCreationReport({
            pipelineId: id,
            pipelineKind: 'compute',
            programId: program.id,
            stages: [ pipelineCreationStage('compute', compute) ],
        }),
    }
    if (draft.layoutMode === 'explicit') validateProgramLayoutRequirements(draft)

    const plan = Object.freeze({
        ...draft,
        sourceSnapshot: snapshotProgramSource(program, [ compute ], subject),
    })
    assertProgramPipelineAuthority(plan.programAuthority)
    return plan
}

function computePipelineDescriptorEvidence(plan: ComputePipelinePlan): {
    summary: Record<string, unknown>
    full: Record<string, unknown>
} {

    const identity = {
        pipelineKind: plan.pipelineKind,
        programId: plan.program.id,
        programContractHash: plan.creationReport.contractHash,
        stages: plan.creationReport.stages,
        immediateSize: plan.immediateSize,
        layoutMode: plan.layoutMode,
        bindLayouts: plan.bindLayouts.map(layout => ({ id: layout.id, group: layout.group })),
    }
    return {
        summary: {
            ...identity,
            constantNames: Object.keys(plan.compute.constants ?? {}).sort(),
        },
        full: {
            ...identity,
            ...(plan.label !== undefined ? { label: plan.label } : {}),
            ...(plan.compute.constants !== undefined
                ? { constants: plan.compute.constants }
                : {}),
        },
    }
}

function defineImmutableComputeProperties(
    pipeline: ComputePipeline,
    state: ComputePipelineState
): void {

    const values: Record<string, unknown> = {
        runtime: state.runtime,
        id: state.id,
        pipelineKind: state.pipelineKind,
        program: state.program,
        compute: state.compute,
        layoutMode: state.layoutMode,
        immediateSize: state.immediateSize,
        ...(state.pipelineLayout !== undefined
            ? { pipelineLayout: state.pipelineLayout }
            : {}),
        gpuPipeline: state.gpuPipeline,
        creationReport: state.creationReport,
        ...(state.label !== undefined ? { label: state.label } : {}),
    }
    Object.defineProperties(pipeline, Object.fromEntries(
        Object.entries(values).map(([ key, value ]) => [ key, {
            value,
            enumerable: true,
            configurable: false,
            writable: false,
        } ])
    ))
    Object.defineProperties(pipeline, pipelineBindLayoutProperties(
        () => computePipelineStateFor(pipeline)
    ))
}

function computePipelineStateFor(pipeline: ComputePipeline): PipelineObjectState {

    const state = computePipelineStates.get(pipeline)
    if (state === undefined) throw new TypeError('ComputePipeline state is unavailable.')
    return state
}

function pipelineBindLayoutProperties(
    state: () => PipelineObjectState
): PropertyDescriptorMap {

    return {
        bindLayouts: {
            get: () => Object.freeze([ ...state().bindLayoutsByGroup.values() ]),
            enumerable: true,
            configurable: false,
        },
        bindLayoutsByGroup: {
            get: () => readonlyMapSnapshot(state().bindLayoutsByGroup),
            enumerable: true,
            configurable: false,
        },
    }
}

async function getPipelineBindLayout(
    pipeline: RenderPipeline | ComputePipeline,
    descriptor: BindLayoutDescriptor
): Promise<BindLayout> {

    pipeline.assertUsable()
    if (pipeline.layoutMode !== 'auto') {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_LAYOUT_DERIVATION_FORBIDDEN',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'Only an auto-layout Pipeline can derive native BindLayouts.',
            expected: { layoutMode: 'auto' },
            actual: { layoutMode: pipeline.layoutMode },
        })
    }
    const state = pipeline.pipelineKind === 'render'
        ? renderPipelineStateFor(pipeline)
        : computePipelineStateFor(pipeline)
    const normalizedDescriptor = normalizeBindLayoutDescriptor(
        pipeline.runtime,
        `${pipeline.id}:derived-bind-layout`,
        descriptor
    )
    const group = normalizedDescriptor.group
    const signature = normalizedBindLayoutDescriptorSignature(normalizedDescriptor)
    const establishedSignature = state.derivedLayoutSignatures.get(group)
    if (establishedSignature !== undefined && establishedSignature !== signature) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_LAYOUT_DERIVATION_DESCRIPTOR_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'An auto-layout Pipeline group may retain only one declared binding schema.',
            expected: {
                group,
                descriptorSignature: establishedSignature,
            },
            actual: {
                group,
                descriptorSignature: signature,
            },
        })
    }
    const cached = state.bindLayoutsByGroup.get(group)
    if (cached !== undefined) return cached
    const pending = state.derivedLayoutPromises.get(group)
    if (pending !== undefined) return pending

    state.derivedLayoutSignatures.set(group, signature)
    const creation = createNativeDerivedBindLayout(
        pipeline.runtime,
        {
            pipelineId: pipeline.id,
            pipelineKind: pipeline.pipelineKind,
            gpuPipeline: pipeline.gpuPipeline,
        },
        normalizedDescriptor
    ).then(layout => {
        try {
            pipeline.assertUsable()
        } catch (cause) {
            layout.dispose()
            throw cause
        }
        state.bindLayoutsByGroup.set(group, layout)
        return layout
    }).finally(() => {
        state.derivedLayoutPromises.delete(group)
        if (!state.bindLayoutsByGroup.has(group)) {
            state.derivedLayoutSignatures.delete(group)
        }
    })
    state.derivedLayoutPromises.set(group, creation)
    return creation
}

function disposeDerivedPipelineLayouts(state: PipelineObjectState): void {

    for (const layout of state.bindLayoutsByGroup.values()) {
        if (layout.origin === 'native-derived') layout.dispose()
    }
    state.bindLayoutsByGroup.clear()
    state.derivedLayoutSignatures.clear()
}

function normalizedBindLayoutDescriptorSignature(
    descriptor: NormalizedBindLayoutDescriptor
): string {

    return JSON.stringify({
        ...(descriptor.label !== undefined ? { label: descriptor.label } : {}),
        group: descriptor.group,
        entries: descriptor.entries,
    })
}

function normalizePipelineImmediateSize(
    pipeline: PipelineValidationContext,
    immediateSize: unknown,
    requiredLanguageFeatures: readonly string[]
): number {

    const normalized = immediateSize === undefined ? 0 : immediateSize
    const maxImmediateSize = (
        pipeline.runtime.deviceLimits as GPUSupportedLimits & {
            readonly maxImmediateSize?: number
        }
    ).maxImmediateSize
    const finiteNumber = typeof normalized === 'number' && Number.isFinite(normalized)
    const safeInteger = typeof normalized === 'number' && Number.isSafeInteger(normalized)
    const nonNegative = typeof normalized === 'number' && safeInteger && normalized >= 0
    const alignedTo4Bytes = typeof normalized === 'number' && safeInteger && normalized % 4 === 0
    const withinGpuSize32 = typeof normalized === 'number' &&
        nonNegative &&
        normalized <= 0xffff_ffff
    const validDeviceLimit = typeof maxImmediateSize === 'number' &&
        Number.isFinite(maxImmediateSize)
    const withinDeviceLimit = typeof normalized === 'number' &&
        nonNegative &&
        validDeviceLimit &&
        typeof maxImmediateSize === 'number' &&
        normalized <= maxImmediateSize
    const positive = typeof normalized === 'number' && nonNegative && normalized > 0
    if (
        !finiteNumber ||
        !safeInteger ||
        !nonNegative ||
        !withinGpuSize32 ||
        !alignedTo4Bytes ||
        (positive && !withinDeviceLimit)
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            related: [ pipeline.program.subject, pipeline.runtime.subject ],
            message: 'Pipeline immediateSize is outside the supported WebGPU immediate range.',
            expected: {
                alignmentBytes: 4,
                gpuSize32Minimum: 0,
                gpuSize32Maximum: 0xffff_ffff,
                maxImmediateSize,
            },
            actual: {
                authoredImmediateSize: immediateSize === undefined ? 'omitted' : immediateSize,
                normalizedImmediateSize: normalized,
                finiteNumber,
                safeInteger,
                nonNegative,
                alignedTo4Bytes,
                withinGpuSize32,
                withinDeviceLimit,
            },
        })
    }

    if (
        normalized > 0 &&
        !requiredLanguageFeatures.includes('immediate_address_space')
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            related: [ pipeline.program.subject ],
            message: 'A nonzero immediateSize requires an explicit Program language-feature contract.',
            expected: { requiredLanguageFeature: 'immediate_address_space' },
            actual: {
                immediateSize: normalized,
                requiredLanguageFeatures,
            },
        })
    }

    return normalized
}

function normalizeVertexBuffers(
    pipeline: PipelineValidationContext,
    vertexBuffers: readonly (GPUVertexBufferLayout | null)[] = []
): (GPUVertexBufferLayout | null)[] {

    if (!Array.isArray(vertexBuffers)) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { vertexBuffers: 'readonly (GPUVertexBufferLayout | null)[]' },
            actual: { field: 'vertexBuffers', vertexBuffers },
        })
    }

    const normalizedLayouts: (GPUVertexBufferLayout | null)[] = []
    for (let slot = 0; slot < vertexBuffers.length; slot++) {
        if (!Object.hasOwn(vertexBuffers, slot) || vertexBuffers[slot] === undefined) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { slot: 'explicit GPUVertexBufferLayout or null' },
                actual: {
                    field: 'vertexBuffers',
                    slot,
                    reason: Object.hasOwn(vertexBuffers, slot) ? 'undefined' : 'hole',
                },
            })
        }

        const layout = vertexBuffers[slot]
        if (layout === null) {
            normalizedLayouts.push(null)
            continue
        }

        if (typeof layout !== 'object') {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { layout: 'GPUVertexBufferLayout or null' },
                actual: {
                    field: 'vertexBuffers',
                    slot,
                    layout: describeValue(layout),
                },
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

        const normalizedLayout: GPUVertexBufferLayout = {
            arrayStride: layout.arrayStride,
            attributes: layout.attributes.map((attribute: GPUVertexAttribute, attributeIndex: number) => normalizeVertexAttribute(
                pipeline,
                attribute,
                slot,
                attributeIndex
            )),
        }
        if (layout.stepMode !== undefined) normalizedLayout.stepMode = layout.stepMode

        normalizedLayouts.push(normalizedLayout)
    }

    return normalizedLayouts
}

function normalizeRenderConstants(
    pipeline: PipelineValidationContext,
    constants: Readonly<Record<string, number>> | undefined,
    stage: 'vertex' | 'fragment'
): Readonly<Record<string, number>> | undefined {

    if (constants === undefined) return undefined

    let entries: [string, unknown][]
    try {
        const prototype = constants !== null && typeof constants === 'object'
            ? Object.getPrototypeOf(constants)
            : undefined
        if (
            constants === null ||
            typeof constants !== 'object' ||
            Array.isArray(constants) ||
            (prototype !== Object.prototype && prototype !== null)
        ) {
            throwRenderConstantsDiagnostic(pipeline, stage, 'record', constants)
        }
        entries = Object.entries(constants)
    } catch (error) {
        if (error instanceof Error && error.name === 'ScratchDiagnosticError') throw error
        throwRenderConstantsDiagnostic(pipeline, stage, 'record', constants)
    }

    for (const [ name, value ] of entries) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throwRenderConstantsDiagnostic(pipeline, stage, 'value', value, name)
        }
    }

    return Object.freeze(Object.fromEntries(entries) as Record<string, number>)
}

function throwRenderConstantsDiagnostic(
    pipeline: PipelineValidationContext,
    stage: 'vertex' | 'fragment',
    reason: 'record' | 'value',
    value: unknown,
    name?: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PIPELINE_CONSTANTS_INVALID',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        related: [ pipeline.program.subject ],
        message: 'RenderPipeline stage constants must be a plain record of finite numbers.',
        expected: {
            stage,
            constants: 'Readonly<Record<string, finite number>>',
        },
        actual: {
            stage,
            reason,
            ...(name !== undefined ? { name } : {}),
            value: describeValue(value),
        },
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

    const pipelineName = pipeline.pipelineKind === 'render' ? 'RenderPipeline' : 'ComputePipeline'
    if (!Array.isArray(bindLayouts)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: `${pipelineName} bindLayouts must be an array.`,
            expected: { bindLayouts: 'BindLayout[]' },
            actual: { bindLayouts },
        })
    }

    const groups = new Set<number>()
    const normalized = bindLayouts.map((layout: BindLayout) => {
        if (!isBindLayout(layout)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: `${pipelineName} bindLayouts must contain BindLayout objects.`,
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
                message: `${pipelineName} cannot use more than one BindLayout for the same group.`,
                expected: { group: 'unique' },
                actual: { group: layout.group },
            })
        }
        groups.add(layout.group)

        return layout
    })

    const violation = firstBindingLimitViolation(
        pipeline.runtime,
        normalized.flatMap(layout => layout.entries)
    )
    if (violation !== undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            related: normalized.map(layout => layout.subject),
            message: `${pipelineName} bindLayouts collectively exceed a device binding-slot limit.`,
            expected: {
                limit: violation.limit,
                maximum: violation.maximum,
                ...(violation.stage !== undefined ? { stage: violation.stage } : {}),
            },
            actual: {
                count: violation.actual,
                ...(violation.stage !== undefined ? { stage: violation.stage } : {}),
            },
        })
    }

    return normalized
}

function normalizePipelineLayout(
    pipeline: PipelineValidationContext,
    value: unknown
): Readonly<{
    mode: 'explicit' | 'auto'
    bindLayouts: readonly BindLayout[]
}> {

    if (value === undefined) {
        return Object.freeze({
            mode: 'explicit' as const,
            bindLayouts: Object.freeze([]),
        })
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throwPipelineLayoutModeInvalid(pipeline, value)
    }
    const descriptor = value as Record<string, unknown>
    if (descriptor.mode === 'auto') {
        if (Object.prototype.hasOwnProperty.call(descriptor, 'bindLayouts')) {
            throwPipelineLayoutModeInvalid(pipeline, value)
        }
        return Object.freeze({
            mode: 'auto' as const,
            bindLayouts: Object.freeze([]),
        })
    }
    if (descriptor.mode !== 'explicit') {
        throwPipelineLayoutModeInvalid(pipeline, value)
    }
    const bindLayouts = Object.freeze(normalizeBindLayouts(
        pipeline,
        (descriptor.bindLayouts ?? []) as BindLayout[]
    ))
    return Object.freeze({
        mode: 'explicit' as const,
        bindLayouts,
    })
}

function throwPipelineLayoutModeInvalid(
    pipeline: PipelineValidationContext,
    actual: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PIPELINE_LAYOUT_MODE_INVALID',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        message: `${pipelineDisplayName(pipeline)} layout must select explicit or auto mode.`,
        expected: {
            layout: [
                '{ mode: "explicit", bindLayouts?: BindLayout[] }',
                '{ mode: "auto" }',
            ],
        },
        actual: { layout: describeValue(actual) },
    })
}

function nativeBindGroupLayouts(
    bindLayouts: readonly BindLayout[]
): readonly (GPUBindGroupLayout | null)[] {

    if (bindLayouts.length === 0) return []

    const highestGroup = Math.max(...bindLayouts.map(layout => layout.group))
    const nativeLayouts = Array<GPUBindGroupLayout | null>(highestGroup + 1).fill(null)
    for (const layout of bindLayouts) {
        nativeLayouts[layout.group] = layout.gpuBindGroupLayout
    }
    return nativeLayouts
}

function normalizeTargets(
    pipeline: PipelineValidationContext,
    targets: unknown
): (GPUColorTargetState | null)[] {

    if (!Array.isArray(targets)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_TARGET_STATE_INVALID',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'RenderPipeline color targets must be an array.',
            expected: { targets: 'readonly (GPUColorTargetState | null)[]' },
            actual: { targets },
        })
    }
    const targetSlots = targets as readonly (GPUColorTargetState | null)[]

    const normalized: (GPUColorTargetState | null)[] = []
    for (let slot = 0; slot < targetSlots.length; slot++) {
        if (!Object.hasOwn(targetSlots, slot) || targetSlots[slot] === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_STATE_INVALID',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline target slots must be explicit target states or null.',
                expected: { slot: 'explicit GPUColorTargetState or null' },
                actual: {
                    field: 'targets',
                    slot,
                    reason: Object.hasOwn(targets, slot) ? 'undefined' : 'hole',
                },
            })
        }

        const target = targetSlots[slot]
        if (target === null) {
            normalized.push(null)
            continue
        }

        if (typeof target !== 'object' || typeof target.format !== 'string') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_STATE_INVALID',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline non-null target requires a texture format.',
                expected: { format: 'GPUTextureFormat' },
                actual: {
                    field: 'targets',
                    slot,
                    target: describeValue(target),
                },
            })
        }

        normalized.push({ ...target })
    }

    return normalized
}

function normalizeRenderTargetsForFragment(
    pipeline: PipelineValidationContext,
    fragment: ProgramStage | undefined,
    value: unknown
): readonly (GPUColorTargetState | null)[] {

    if (fragment === undefined) {
        if (value !== undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_FRAGMENT_FIELDS_FORBIDDEN',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                related: [ programAuthoritySubject(pipeline.program) ],
                message: 'Fragmentless RenderPipeline forbids color targets.',
                expected: { targets: 'omitted' },
                actual: { targets: describeValue(value) },
            })
        }
        return Object.freeze([])
    }
    if (value === undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_TARGETS_INVALID',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            related: [ programAuthoritySubject(pipeline.program) ],
            message: 'RenderPipeline with a fragment stage requires an explicit targets sequence.',
            expected: { targets: '(GPUColorTargetState | null)[]' },
            actual: { targets: 'undefined' },
        })
    }
    return freezeColorTargets(normalizeTargets(pipeline, value))
}

function throwMissingProgramStage(
    pipeline: PipelineValidationContext,
    stage: 'vertex' | 'compute'
): never {

    throwScratchDiagnostic({
        code: stage === 'vertex'
            ? 'SCRATCH_PIPELINE_VERTEX_STAGE_MISSING'
            : 'SCRATCH_PIPELINE_COMPUTE_STAGE_MISSING',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        related: [ programAuthoritySubject(pipeline.program) ],
        message: `${pipelineDisplayName(pipeline)} requires a Program ${stage} stage.`,
        expected: { stage },
        actual: { stage: 'missing' },
    })
}

function pipelineCreationStage(
    stage: 'vertex' | 'fragment' | 'compute',
    descriptor: ProgramStage
) {

    return {
        stage,
        shaderModuleId: descriptor.module.id,
        sourceHash: descriptor.module.compilationReport.sourceHash,
        ...(descriptor.entryPoint !== undefined
            ? { entryPoint: descriptor.entryPoint }
            : {}),
        constantKeys: Object.keys(descriptor.constants ?? {}),
    }
}

function pipelineStages(plan: PipelineCreationPlan): readonly ProgramStage[] {

    if (plan.pipelineKind === 'compute') {
        return [ (plan as ComputePipelinePlan).compute ]
    }
    const render = plan as RenderPipelinePlan
    return [
        render.vertex,
        ...(render.fragment !== undefined ? [ render.fragment ] : []),
    ]
}

function pipelineDisplayName(pipeline: PipelineValidationContext): string {

    return pipeline.pipelineKind === 'render' ? 'RenderPipeline' : 'ComputePipeline'
}

function validateRenderPipelineHasAttachment(
    pipeline: PipelineValidationContext,
    targets: readonly (GPUColorTargetState | null)[],
    depthStencil: Readonly<GPUDepthStencilState> | undefined
): void {

    if (targets.some(target => target !== null) || depthStencil !== undefined) return

    throwScratchDiagnostic({
        code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        message: 'RenderPipeline requires at least one color or depth/stencil attachment format.',
        expected: {
            targets: 'at least one color target when depthStencil is absent',
            depthStencil: 'GPUDepthStencilState when targets is empty',
        },
        actual: { targetCount: targets.length, depthStencil: undefined },
    })
}

export function programLayoutRequirementsForPipeline(
    pipeline: RenderPipeline | ComputePipeline
): readonly ProgramBufferLayoutRequirement[] {

    const requirements = pipelineProgramLayoutRequirements.get(pipeline)
    if (requirements === undefined) throw new TypeError('Pipeline Program layout requirement snapshot is unavailable.')
    return requirements
}

export function renderPipelineLayoutFor(
    pipeline: RenderPipeline
): RenderPipelineLayoutSnapshot {

    const layout = renderPipelineLayouts.get(pipeline)
    if (layout === undefined) {
        throw new TypeError('RenderPipeline render-pass layout snapshot is unavailable.')
    }
    return layout
}

function validateProgramLayoutRequirements(pipeline: PipelineValidationContext): void {

    for (const requirement of pipeline.layoutRequirements) {
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

        if (
            (entry.type === 'uniform' || entry.type === 'read-storage' || entry.type === 'storage') &&
            entry.hasDynamicOffset !== requirement.hasDynamicOffset
        ) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { hasDynamicOffset: entry.hasDynamicOffset },
            })
        }

        if (
            (entry.type === 'uniform' || entry.type === 'read-storage' || entry.type === 'storage') &&
            entry.minBindingSize !== 0 &&
            entry.minBindingSize < requirement.layout.byteLength
        ) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { minBindingSize: entry.minBindingSize },
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

function boundedPipelineDiagnosticLabel(label: string): string {

    const maxLength = 256
    if (label.length <= maxLength) return label
    let end = maxLength - 3
    if (
        end > 0 &&
        isHighSurrogate(label.charCodeAt(end - 1)) &&
        isLowSurrogate(label.charCodeAt(end))
    ) end--
    return `${label.slice(0, end)}...`
}

function isHighSurrogate(value: number): boolean {

    return value >= 0xD800 && value <= 0xDBFF
}

function isLowSurrogate(value: number): boolean {

    return value >= 0xDC00 && value <= 0xDFFF
}

Object.freeze(RenderPipeline.prototype)
Object.freeze(ComputePipeline.prototype)
