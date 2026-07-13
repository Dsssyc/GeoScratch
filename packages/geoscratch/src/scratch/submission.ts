import { UUID } from '../core/utils/uuid.js'
import {
    claimReadbackCommand,
    commitUploadCommandLogicalWrite,
    encodeReadbackCommandClaim,
    markReadbackCommandClaimAdopted,
    markReadbackCommandClaimMapping,
    markReadbackCommandClaimSubmitted,
    readbackCommandClaimBuffer,
    registerReadbackCommandResult,
    releaseReadbackCommandClaim,
    updateReadbackCommandClaimProvenance,
    uploadCommandHasContentEffect,
    validateUploadCommandQueueAction,
    writeUploadCommandQueueAction,
} from './command.js'
import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    throwScratchDiagnostic,
} from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { validateRenderPassAttachments } from './pass.js'
import { createScheduledReadbackOperation } from './readback.js'
import { advanceResourceContentEpoch, setResourceContentState } from './resource.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { setQuerySlotContentState } from './query-set.js'
import {
    beginSubmissionNativeObservation,
    compareSubmissionNativeStages,
} from './submission-native-observation.js'
import { TextureResource } from './texture.js'
import { diagnosticSubjectOf, isDefined, isRecord } from './type-utils.js'
import type { BeginOcclusionQueryCommand, CommandResourceReadDescriptor, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, ExternalImageUploadCommand, QuerySetSlotReadDescriptor, ReadbackCommand, ReadbackCommandClaim, ResolveQuerySetCommand, ResourceReadinessPolicy, TextureUploadCommand, UploadCommand } from './command.js'
import type { DiagnosticSubject, ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { QuerySetResource, QuerySetSlotState } from './query-set.js'
import type { Resource, ResourceState } from './resource.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    SubmissionNativeIssue,
    SubmissionNativeObservation,
    SubmissionNativeSettlement,
} from './submission-native-observation.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuIncidentReport,
    ScratchSubmissionNativeLocation,
    ScratchSubmissionNativeOutcome,
    ScratchSubmissionNativeStage,
    ScratchSubmissionQueueActionKind,
} from './gpu-operation.js'
import type {
    ScratchEffectfulSubmittedWorkReservation,
    ScratchRuntimeLifecycleChange,
} from './runtime-diagnostics.js'

export type SubmissionValidationMode = 'off' | 'warn' | 'throw'

export type SubmissionStepKind = 'upload' | 'copy' | 'readback' | 'resolve' | 'compute' | 'render'

export type SubmissionResourceAccessKind = 'read' | 'write'

type SubmissionAccessOrigin = {
    stepIndex: number
    stepKind: SubmissionStepKind
    commandKind?: string
    commandId?: string
    passId?: string
}

export type SubmissionResourceAccess = SubmissionAccessOrigin & {
    resourceId: string
    resourceKind: string
    label?: string
    subject: DiagnosticSubject
    access: SubmissionResourceAccessKind
    contentEpochBefore: number
    contentEpochAfter: number
    allocationVersion: number
}

export type SubmittedResourceEpoch = {
    resourceId: string
    resourceKind: string
    label?: string
    subject: DiagnosticSubject
    contentEpoch: number
    allocationVersion: number
    producedBy: SubmissionAccessOrigin
}

export type SubmittedReadbackLink = Readonly<{
    commandId: string
    operationId: string
    stepIndex: number
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    stagingAllocationOperationId: string
}>

export type SubmittedPotentialWrite =
    | Readonly<{
        kind: 'resource'
        resourceId: string
        resourceKind: string
        label?: string
        subject: DiagnosticSubject
        allocationVersion: number
        contentEpoch: number
    }>
    | Readonly<{
        kind: 'query-slot'
        querySetId: string
        queryType: string
        label?: string
        subject: DiagnosticSubject
        index: number
        allocationVersion: number
        contentEpoch: number
    }>

export type SubmissionMissingResource = {
    resourceId: string
    resourceKind: string
    label?: string
    subject: DiagnosticSubject
    role?: string
    requiredContentEpoch: number
    simulatedState: ResourceState
    simulatedContentEpoch: number
    allocationVersion: number
}

export type SubmissionCommandReadinessAttempt = {
    commandId: string
    commandKind: 'draw' | 'dispatch'
    policy: ResourceReadinessPolicy
    missing: readonly SubmissionMissingResource[]
}

export type SubmissionCommandExecutionOutcome = {
    outcomeKind: 'command'
    stepIndex: number
    stepKind: 'render' | 'compute'
    passId: string
    requestedCommandId: string
    requestedCommandKind: 'draw' | 'dispatch'
    status:
        | 'executed'
        | 'fallback-executed'
        | 'skipped-command'
        | 'skipped-pass'
    executedCommandId?: string
    attempts: readonly SubmissionCommandReadinessAttempt[]
}

export type SubmissionPassExecutionOutcome = {
    outcomeKind: 'pass'
    stepIndex: number
    stepKind: 'render' | 'compute'
    passId: string
    status:
        | 'executed'
        | 'skipped-pass'
        | 'skipped-empty'
    triggerCommandId?: string
    requestedCommandIds: readonly string[]
    encodedCommandIds: readonly string[]
}

export type SubmissionExecutionOutcome =
    | SubmissionCommandExecutionOutcome
    | SubmissionPassExecutionOutcome

type ReadonlySubmittedFact<T> =
    T extends (...args: any[]) => unknown
        ? T
        : T extends readonly (infer Item)[]
            ? readonly ReadonlySubmittedFact<Item>[]
            : T extends object
                ? { readonly [Key in keyof T]: ReadonlySubmittedFact<T[Key]> }
                : T

type PendingSubmissionResourceAccess = {
    origin: SubmissionAccessOrigin
    resource: Resource
    access: SubmissionResourceAccessKind
    contentEpochBefore: number
}

export type SubmissionBuilderOptions = {
    validation?: SubmissionValidationMode
}

export type RenderCommand = DrawCommand | BeginOcclusionQueryCommand | EndOcclusionQueryCommand

type RenderStep = {
    kind: 'render'
    passSpec: RenderPassSpec
    commands: RenderCommand[]
}

type ComputeStep = {
    kind: 'compute'
    passSpec: ComputePassSpec
    commands: DispatchCommand[]
}

type UploadStep = {
    kind: 'upload'
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand
}

type CopyStep = {
    kind: 'copy'
    command: CopyCommand
}

type ReadbackStep = {
    kind: 'readback'
    command: ReadbackCommand
}

type ResolveStep = {
    kind: 'resolve'
    command: ResolveQuerySetCommand
}

type SubmissionStep = RenderStep | ComputeStep | UploadStep | CopyStep | ReadbackStep | ResolveStep

type ResolvedPassDisposition =
    | { disposition: 'execute', triggerCommandId?: never }
    | { disposition: 'skip-pass', triggerCommandId: string }

type ResolvedRenderStep = RenderStep & ResolvedPassDisposition

type ResolvedComputeStep = ComputeStep & ResolvedPassDisposition

type ResolvedSubmissionStep =
    | ResolvedRenderStep
    | ResolvedComputeStep
    | UploadStep
    | CopyStep
    | ReadbackStep
    | ResolveStep

type ResolvedSubmissionPlan = {
    report: ScratchDiagnosticReport
    steps: ResolvedSubmissionStep[]
    readiness: ReadinessSimulation
    querySlots: QuerySlotSimulation
    executionOutcomes: SubmissionExecutionOutcome[]
}

type ReadCommand = CopyCommand | DispatchCommand | DrawCommand | ReadbackCommand

type ExecutableCommand = DrawCommand | DispatchCommand

type PendingReadback = {
    command: ReadbackCommand
    claim: ReadbackCommandClaim
    stepIndex: number
    contentEpoch: number
    allocationVersion: number
}

type PreparedResourceContentEffect = {
    kind: 'resource-content'
    resource: Resource
    state: ResourceState
    contentEpoch: number
}

type PreparedQuerySlotContentEffect = {
    kind: 'query-slot-content'
    querySet: QuerySetResource
    index: number
    state: QuerySetSlotState
    contentEpoch: number
}

type PreparedQueueEffect = PreparedResourceContentEffect | PreparedQuerySlotContentEffect

type SubmissionPotentialWrite =
    | Readonly<{
        kind: 'resource'
        resource: Resource
        allocationVersion: number
        contentEpoch: number
    }>
    | Readonly<{
        kind: 'query-slot'
        querySet: QuerySetResource
        index: number
        contentEpoch: number
    }>

type PreparedQueueAction =
    | {
        kind: 'command-buffer'
        commandBuffer: GPUCommandBuffer
        effects: PreparedQueueEffect[]
    }
    | {
        kind: 'buffer-upload'
        command: UploadCommand
        effects: PreparedQueueEffect[]
    }
    | {
        kind: 'texture-upload'
        command: TextureUploadCommand
        effects: PreparedQueueEffect[]
    }
    | {
        kind: 'external-image-upload'
        command: ExternalImageUploadCommand
        effects: PreparedQueueEffect[]
    }

type PreparedUploadQueueAction = Exclude<PreparedQueueAction, { kind: 'command-buffer' }>

function createPreparedUploadQueueAction(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand,
    effects: PreparedQueueEffect[]
): PreparedUploadQueueAction {

    switch (command.uploadKind) {
        case 'buffer':
            return { kind: 'buffer-upload', command, effects }
        case 'texture':
            return { kind: 'texture-upload', command, effects }
        case 'external-image':
            return { kind: 'external-image-upload', command, effects }
        default:
            return assertNeverUploadCommand(command)
    }
}

function assertNeverUploadCommand(command: never): never {

    throw new TypeError(`Unsupported upload command: ${String(command)}`)
}

function assertNeverPreparedQueueAction(action: never): never {

    throw new TypeError(`Unsupported prepared queue action: ${String(action)}`)
}

type ResourceContentSnapshot = {
    state: ResourceState
    contentEpoch: number
}

type QuerySlotContentSnapshot = {
    state: QuerySetSlotState
    contentEpoch: number
}

type ResourceSimulationState = {
    state: ResourceState
    contentEpoch: number
}

type ReadinessSimulation = Map<string, ResourceSimulationState>

type QuerySlotSimulationState = {
    state: QuerySetSlotState
    contentEpoch: number
}

type QuerySlotSimulation = Map<string, QuerySlotSimulationState>

type ResolvedPassCommands<Command> =
    | {
        disposition: 'execute'
        commands: Command[]
        commandOutcomes: SubmissionCommandExecutionOutcome[]
    }
    | {
        disposition: 'skip-pass'
        commands: Command[]
        commandOutcomes: SubmissionCommandExecutionOutcome[]
        triggerCommandId: string
    }

type ResolvedExecutableCommand<Command extends ExecutableCommand> =
    | {
        disposition: 'execute'
        command: Command
        outcome: SubmissionCommandExecutionOutcome
    }
    | {
        disposition: 'skip-command'
        outcome: SubmissionCommandExecutionOutcome
    }
    | {
        disposition: 'skip-pass'
        triggerCommandId: string
        outcome: SubmissionCommandExecutionOutcome
    }

type MissingReadRequirement = {
    readRequirement: CommandResourceReadDescriptor
    simulated: ResourceSimulationState
}

type CommandExecutionDiagnosticContext = {
    requestedCommand: ExecutableCommand
    attemptedCommands: readonly ExecutableCommand[]
    attempts: readonly SubmissionCommandReadinessAttempt[]
}

type RenderAttachmentKind = 'color' | 'depth-stencil'

export interface SubmissionBuilder {
    runtime: ScratchRuntime
    id: string
    validation: SubmissionValidationMode
    steps: SubmissionStep[]
    isSubmitted: boolean
}

export class SubmissionBuilder {

    constructor(runtime: ScratchRuntime, options: SubmissionBuilderOptions = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-submission-builder-${UUID()}`
        this.validation = options.validation ?? 'throw'
        this.steps = []
        this.isSubmitted = false
    }

    render(passSpec: RenderPassSpec, commands: RenderCommand[] = []) {

        this.steps.push({
            kind: 'render',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    compute(passSpec: ComputePassSpec, commands: DispatchCommand[] = []) {

        this.steps.push({
            kind: 'compute',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    upload(command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand) {

        this.steps.push({
            kind: 'upload',
            command,
        })

        return this
    }

    copy(command: CopyCommand) {

        this.steps.push({
            kind: 'copy',
            command,
        })

        return this
    }

    readback(command: ReadbackCommand) {

        this.steps.push({
            kind: 'readback',
            command,
        })

        return this
    }

    resolve(command: ResolveQuerySetCommand) {

        this.steps.push({
            kind: 'resolve',
            command,
        })

        return this
    }

    submit() {

        this.runtime.assertActive()

        if (this.isSubmitted) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                message: 'SubmissionBuilder has already submitted work.',
            })
        }

        const resolvedPlan = resolveSubmissionBeforeEncoding(this)
        applySubmissionValidationDisposition(this, resolvedPlan.report)
        for (const step of resolvedPlan.steps) {
            if (step.kind === 'upload') {
                validateUploadCommandQueueAction(step.command, this.runtime.queue)
            }
        }

        const submittedId = `scratch-submitted-${UUID()}`
        const nativeIssuePlan = createSubmissionNativeIssuePlan(submittedId, resolvedPlan.steps)
        const commandBuffers: GPUCommandBuffer[] = []
        const queueTimeline: PreparedQueueAction[] = []
        const resourceAccesses: SubmissionResourceAccess[] = []
        const pendingReadbacks: PendingReadback[] = []
        const submittedReadbacks = new Set<PendingReadback>()
        const readbackClaims = new Map<number, ReadbackCommandClaim>()
        const commandBufferReadbacks = new Map<GPUCommandBuffer, PendingReadback[]>()
        const resourceSnapshots = new Map<Resource, ResourceContentSnapshot>()
        const querySlotSnapshots = new Map<QuerySetResource, Map<number, QuerySlotContentSnapshot>>()
        let encoder: GPUCommandEncoder | undefined
        let encoderSegmentIndex = 0
        let activeEncoderSegmentIndex: number | undefined
        let segmentResources = new Set<Resource>()
        let segmentQuerySlots = new Map<QuerySetResource, Set<number>>()
        let segmentReadbacks: PendingReadback[] = []
        let replayedQueueActionCount = 0

        try {
            for (const [stepIndex, step] of resolvedPlan.steps.entries()) {
                if (step.kind !== 'readback') continue
                readbackClaims.set(stepIndex, claimReadbackCommand(step.command, {
                    submissionId: submittedId,
                    stepIndex,
                }))
            }
        } catch (cause) {
            releaseUnsubmittedReadbackClaims(readbackClaims.values())
            throw cause
        }

        let nativeObservation: SubmissionNativeObservation
        try {
            nativeObservation = beginSubmissionNativeObservation({
                runtime: this.runtime,
                submissionId: submittedId,
                effectful: nativeIssuePlan.length > 0,
                plan: nativeIssuePlan,
            })
        } catch (cause) {
            releaseUnsubmittedReadbackClaims(readbackClaims.values())
            throw cause
        }

        try {

        const trackSegmentResourceWrite = (resource: Resource) => {

            captureResourceContentSnapshot(resourceSnapshots, resource)
            segmentResources.add(resource)
        }

        const trackSegmentQuerySlotWrite = (querySet: QuerySetResource, index: number) => {

            captureQuerySlotContentSnapshot(querySlotSnapshots, querySet, index)
            let indices = segmentQuerySlots.get(querySet)
            if (indices === undefined) {
                indices = new Set()
                segmentQuerySlots.set(querySet, indices)
            }
            indices.add(index)
        }

        const trackTimestampWrites = (passSpec: RenderPassSpec | ComputePassSpec) => {

            if (passSpec.timestampWrites === undefined) return

            const { querySet, begin, end } = passSpec.timestampWrites
            if (begin !== undefined) trackSegmentQuerySlotWrite(querySet, begin)
            if (end !== undefined) trackSegmentQuerySlotWrite(querySet, end)
        }

        const getEncoder = () => {

            if (encoder === undefined) {
                const segmentIndex = encoderSegmentIndex++
                const location = encoderSegmentLocation(submittedId, segmentIndex)
                encoder = nativeObservation.issue('encoder-create', location, () =>
                    this.runtime.device.createCommandEncoder({
                    label: segmentIndex === 0
                        ? submittedId
                        : `${submittedId}:segment-${segmentIndex}`,
                    })
                )
                activeEncoderSegmentIndex = segmentIndex
            }

            return encoder
        }

        const finishEncoderSegment = () => {

            if (encoder === undefined) return

            if (activeEncoderSegmentIndex === undefined) {
                throw new TypeError('Active encoder segment index is unavailable.')
            }
            const location = encoderSegmentLocation(submittedId, activeEncoderSegmentIndex)
            const commandBuffer = nativeObservation.issue(
                'encoder-finish',
                location,
                () => encoder!.finish()
            )
            commandBuffers.push(commandBuffer)
            queueTimeline.push({
                kind: 'command-buffer',
                commandBuffer,
                effects: createPreparedQueueEffects(segmentResources, segmentQuerySlots),
            })
            commandBufferReadbacks.set(commandBuffer, segmentReadbacks)
            encoder = undefined
            activeEncoderSegmentIndex = undefined
            segmentResources = new Set()
            segmentQuerySlots = new Map()
            segmentReadbacks = []
        }

        try {
            for (const [stepIndex, step] of resolvedPlan.steps.entries()) {
                if (step.kind === 'upload') {
                    finishEncoderSegment()
                    const effects: PreparedQueueEffect[] = []
                    if (uploadCommandHasContentEffect(step.command)) {
                        const writes = [
                            captureResourceAccess(step.command.target, 'write', commandAccessOrigin(stepIndex, 'upload', step.command)),
                        ]
                        captureResourceContentSnapshot(resourceSnapshots, step.command.target)
                        commitUploadCommandLogicalWrite(step.command)
                        completeResourceAccesses(resourceAccesses, writes)
                        effects.push(createPreparedResourceContentEffect(step.command.target))
                    }
                    queueTimeline.push(createPreparedUploadQueueAction(step.command, effects))
                    continue
                }

                if (step.kind === 'copy') {
                    const encoder = getEncoder()
                    trackSegmentResourceWrite(step.command.target)
                    const origin = commandAccessOrigin(stepIndex, 'copy', step.command)
                    const accesses = [
                        captureResourceAccess(step.command.source.resource, 'read', origin),
                        captureResourceAccess(step.command.target, 'write', origin),
                    ]
                    issueStandaloneCommandEncoding(
                        nativeObservation,
                        submittedId,
                        stepIndex,
                        step.command,
                        encoder,
                        () => step.command.encode(encoder)
                    )
                    completeResourceAccesses(resourceAccesses, accesses)
                    continue
                }

                if (step.kind === 'readback') {
                    const encoder = getEncoder()
                    const origin = commandAccessOrigin(stepIndex, 'readback', step.command)
                    const readAccess = captureResourceAccess(step.command.source.resource, 'read', origin)
                    const claim = readbackClaims.get(stepIndex)
                    if (claim === undefined) throw new TypeError(`Readback step ${stepIndex} has no staging claim.`)
                    updateReadbackCommandClaimProvenance(claim, {
                        contentEpoch: readAccess.contentEpochBefore,
                        allocationVersion: step.command.source.resource.allocationVersion,
                    })
                    issueStandaloneCommandEncoding(
                        nativeObservation,
                        submittedId,
                        stepIndex,
                        step.command,
                        encoder,
                        () => encodeReadbackCommandClaim(claim, encoder)
                    )
                    const pendingReadback = {
                        command: step.command,
                        claim,
                        stepIndex,
                        contentEpoch: readAccess.contentEpochBefore,
                        allocationVersion: step.command.source.resource.allocationVersion,
                    }
                    pendingReadbacks.push(pendingReadback)
                    segmentReadbacks.push(pendingReadback)
                    completeResourceAccesses(resourceAccesses, [ readAccess ])
                    continue
                }

                if (step.kind === 'resolve') {
                    const encoder = getEncoder()
                    trackSegmentResourceWrite(step.command.destination)
                    const writes = [
                        captureResourceAccess(step.command.destination, 'write', commandAccessOrigin(stepIndex, 'resolve', step.command)),
                    ]
                    issueStandaloneCommandEncoding(
                        nativeObservation,
                        submittedId,
                        stepIndex,
                        step.command,
                        encoder,
                        () => step.command.encode(encoder)
                    )
                    completeResourceAccesses(resourceAccesses, writes)
                    continue
                }

                if (step.kind === 'compute') {
                    if (step.disposition === 'skip-pass') continue
                    if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                    const encoder = getEncoder()
                    const passLocation = submissionPassLocation(
                        submittedId,
                        stepIndex,
                        step.passSpec
                    )
                    const passEncoder = nativeObservation.issue(
                        'pass-begin',
                        passLocation,
                        () => encoder.beginComputePass(step.passSpec.createComputePassDescriptor())
                    )
                    for (const command of step.commands) {
                        const origin = commandAccessOrigin(stepIndex, 'compute', command, step.passSpec)
                        const declaredWrites = command._producesDeclaredWrites ? command.resources.write : []
                        for (const resource of declaredWrites) trackSegmentResourceWrite(resource)
                        const accesses = [
                            ...command.resources.read.map(read => captureResourceAccess(read.resource, 'read', origin)),
                            ...declaredWrites.map(resource => captureResourceAccess(resource, 'write', origin)),
                        ]
                        issuePassCommandEncoding(
                            nativeObservation,
                            submittedId,
                            stepIndex,
                            step.passSpec,
                            command,
                            passEncoder,
                            () => command.encode(passEncoder)
                        )
                        completeResourceAccesses(resourceAccesses, accesses)
                    }
                    nativeObservation.issue('pass-end', passLocation, () => passEncoder.end())
                    trackTimestampWrites(step.passSpec)
                    step.passSpec.advanceTimestampWriteEpochs()
                    continue
                }

                if (step.disposition === 'skip-pass') continue
                if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                const encoder = getEncoder()
                const colorWrites = captureRenderAttachmentWrites(stepIndex, step.passSpec)
                const passLocation = submissionPassLocation(
                    submittedId,
                    stepIndex,
                    step.passSpec
                )
                const passEncoder = nativeObservation.issue(
                    'pass-begin',
                    passLocation,
                    () => encoder.beginRenderPass(step.passSpec.createRenderPassDescriptor())
                )
                let activeOcclusionQueryCommand: BeginOcclusionQueryCommand | undefined
                for (const command of step.commands) {
                    const origin = commandAccessOrigin(stepIndex, 'render', command, step.passSpec)
                    const declaredWrites = command.commandKind === 'draw' && command._producesDeclaredWrites
                        ? command.resources.write
                        : []
                    for (const resource of declaredWrites) trackSegmentResourceWrite(resource)
                    const accesses = command.commandKind === 'draw'
                        ? [
                            ...command.resources.read.map(read => captureResourceAccess(read.resource, 'read', origin)),
                            ...declaredWrites.map(resource => captureResourceAccess(resource, 'write', origin)),
                        ]
                        : []
                    issuePassCommandEncoding(
                        nativeObservation,
                        submittedId,
                        stepIndex,
                        step.passSpec,
                        command,
                        passEncoder,
                        () => command.encode(passEncoder)
                    )
                    if (command.commandKind === 'begin-occlusion-query') {
                        activeOcclusionQueryCommand = command
                    } else if (command.commandKind === 'end-occlusion-query') {
                        if (activeOcclusionQueryCommand !== undefined) {
                            trackSegmentQuerySlotWrite(
                                activeOcclusionQueryCommand.querySet,
                                activeOcclusionQueryCommand.index
                            )
                        }
                        activeOcclusionQueryCommand?.querySet._advanceSlotContentEpoch(activeOcclusionQueryCommand.index)
                        activeOcclusionQueryCommand = undefined
                    }
                    completeResourceAccesses(resourceAccesses, accesses)
                }
                nativeObservation.issue('pass-end', passLocation, () => passEncoder.end())
                trackTimestampWrites(step.passSpec)
                step.passSpec.advanceTimestampWriteEpochs()
                for (const write of colorWrites) trackSegmentResourceWrite(write.resource)
                advanceRenderAttachmentEpochs(step.passSpec)
                completeResourceAccesses(resourceAccesses, colorWrites)
            }

            finishEncoderSegment()
        } catch (cause) {
            releaseUnsubmittedReadbackClaims(readbackClaims.values())
            throw cause
        } finally {
            restorePreparedContentState(resourceSnapshots, querySlotSnapshots)
        }
        this.isSubmitted = true
        try {
            for (const [ actionIndex, action ] of queueTimeline.entries()) {
                const location = submissionQueueActionLocation(
                    submittedId,
                    actionIndex,
                    action.kind
                )
                switch (action.kind) {
                    case 'command-buffer':
                        nativeObservation.issue(
                            'queue-submit',
                            location,
                            () => this.runtime.queue.submit([ action.commandBuffer ])
                        )
                        for (const pending of commandBufferReadbacks.get(action.commandBuffer) ?? []) {
                            submittedReadbacks.add(pending)
                        }
                        break
                    case 'buffer-upload':
                    case 'texture-upload':
                    case 'external-image-upload':
                        nativeObservation.issue(
                            'queue-action',
                            location,
                            () => writeUploadCommandQueueAction(action.command, this.runtime.queue)
                        )
                        break
                    default:
                        assertNeverPreparedQueueAction(action)
                }

                applyPreparedQueueEffects(action.effects)
                replayedQueueActionCount++
            }
        } catch (cause) {
            observeSubmissionPotentialWriteNativeFailures(
                nativeObservation.settlement,
                snapshotSubmissionPotentialWrites(queueTimeline.slice(0, replayedQueueActionCount))
            )
            releaseFailedSubmissionReadbacks(this.runtime.queue, pendingReadbacks, submittedReadbacks)
            throw cause
        }
        } finally {
            nativeObservation.finish()
        }

        let nativeDone: Promise<unknown>
        try {
            nativeDone = queueTimeline.length === 0
                ? Promise.resolve()
                : createDonePromise(this.runtime.queue)
        } catch (cause) {
            releaseFailedSubmissionReadbacks(this.runtime.queue, pendingReadbacks, submittedReadbacks, cause)
            throw cause
        }
        const readbackLinks = freezeSubmittedReadbackLinks(pendingReadbacks.map(pending => ({
            commandId: pending.claim.commandId,
            operationId: pending.claim.operationId,
            stepIndex: pending.claim.stepIndex,
            sourceResourceId: pending.claim.sourceResourceId,
            allocationVersion: pending.claim.allocationVersion,
            contentEpoch: pending.claim.contentEpoch,
            stagingAllocationOperationId: pending.claim.stagingAllocationOperationId,
        })))
        const potentialWrites = snapshotSubmissionPotentialWrites(queueTimeline)
        const potentialWriteFacts = freezeSubmittedPotentialWriteFacts(potentialWrites)
        const nativeOutcome = nativeObservation.outcome
        const effectfulWorkReservation = nativeIssuePlan.length === 0
            ? undefined
            : diagnosticsControllerFor(this.runtime).retainEffectfulSubmittedWork(submittedId)
        const done = createSubmittedWorkDone(
            this.runtime,
            submittedId,
            nativeDone,
            nativeObservation.settlement,
            readbackLinks,
            potentialWrites,
            effectfulWorkReservation
        )
        for (const pending of pendingReadbacks) {
            markReadbackCommandClaimSubmitted(pending.claim, done)
        }
        const submitted = createSubmittedWork(this.runtime, {
            id: submittedId,
            commandBuffers,
            report: resolvedPlan.report,
            resourceAccesses,
            executionOutcomes: resolvedPlan.executionOutcomes,
            readbacks: readbackLinks,
            potentialWrites: potentialWriteFacts,
            nativeOutcome,
            done,
        })
        for (const pending of pendingReadbacks) {
            const producerEpoch = findReadbackProducerEpoch(submitted, pending)
            const operation = createScheduledReadbackOperation(this.runtime, {
                ...(pending.command.label !== undefined ? { label: pending.command.label } : {}),
                ...(producerEpoch !== undefined ? { producerEpoch } : {}),
                source: pending.command.source.resource,
                after: submitted,
                range: pending.command.range,
                retain: pending.command.retain,
                id: pending.claim.operationId,
                commandId: pending.claim.commandId,
                stepIndex: pending.claim.stepIndex,
                stagingAllocationOperationId: pending.claim.stagingAllocationOperationId,
                staging: {
                    buffer: readbackCommandClaimBuffer(pending.claim),
                    markMapping: () => markReadbackCommandClaimMapping(pending.claim),
                    release: options => releaseReadbackCommandClaim(pending.claim, options),
                },
                contentEpoch: pending.contentEpoch,
                allocationVersion: pending.allocationVersion,
            })
            markReadbackCommandClaimAdopted(pending.claim)
            registerReadbackCommandResult(pending.command, submitted, operation)
        }

        return submitted
    }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

function createSubmissionNativeIssuePlan(
    submissionId: string,
    steps: readonly ResolvedSubmissionStep[]
): SubmissionNativeIssue[] {

    const encoding: SubmissionNativeIssue[] = []
    const queueActions: ScratchSubmissionQueueActionKind[] = []
    let nextSegmentIndex = 0
    let activeSegmentIndex: number | undefined

    const ensureEncoder = () => {

        if (activeSegmentIndex !== undefined) return
        activeSegmentIndex = nextSegmentIndex++
        encoding.push({
            stage: 'encoder-create',
            location: encoderSegmentLocation(submissionId, activeSegmentIndex),
        })
    }
    const finishEncoder = () => {

        if (activeSegmentIndex === undefined) return
        encoding.push({
            stage: 'encoder-finish',
            location: encoderSegmentLocation(submissionId, activeSegmentIndex),
        })
        queueActions.push('command-buffer')
        activeSegmentIndex = undefined
    }

    for (const [ stepIndex, step ] of steps.entries()) {
        if (step.kind === 'upload') {
            finishEncoder()
            queueActions.push(uploadQueueActionKind(step.command))
            continue
        }
        if (step.kind === 'copy' || step.kind === 'readback' || step.kind === 'resolve') {
            ensureEncoder()
            encoding.push({
                stage: 'command-encode',
                location: standaloneCommandLocation(
                    submissionId,
                    stepIndex,
                    step.command
                ),
            })
            continue
        }
        if (
            step.disposition === 'skip-pass' ||
            (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects())
        ) continue

        ensureEncoder()
        const passLocation = submissionPassLocation(submissionId, stepIndex, step.passSpec)
        encoding.push({ stage: 'pass-begin', location: passLocation })
        for (const command of step.commands) {
            encoding.push({
                stage: 'command-encode',
                location: passCommandLocation(
                    submissionId,
                    stepIndex,
                    step.passSpec,
                    command
                ),
            })
        }
        encoding.push({ stage: 'pass-end', location: passLocation })
    }
    finishEncoder()

    return [
        ...encoding,
        ...queueActions.map((actionKind, actionIndex): SubmissionNativeIssue => ({
            stage: actionKind === 'command-buffer' ? 'queue-submit' : 'queue-action',
            location: submissionQueueActionLocation(
                submissionId,
                actionIndex,
                actionKind
            ),
        })),
    ]
}

function issueStandaloneCommandEncoding(
    observation: SubmissionNativeObservation,
    submissionId: string,
    stepIndex: number,
    command: { id: string, label?: string | undefined, commandKind: string },
    encoder: GPUCommandEncoder,
    issue: () => void
): void {

    issueCommandEncoding(
        observation,
        standaloneCommandLocation(submissionId, stepIndex, command),
        encoder,
        command,
        issue
    )
}

function issuePassCommandEncoding(
    observation: SubmissionNativeObservation,
    submissionId: string,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    command: { id: string, label?: string | undefined, commandKind: string },
    encoder: GPURenderPassEncoder | GPUComputePassEncoder,
    issue: () => void
): void {

    issueCommandEncoding(
        observation,
        passCommandLocation(submissionId, stepIndex, passSpec, command),
        encoder,
        command,
        issue
    )
}

function issueCommandEncoding(
    observation: SubmissionNativeObservation,
    location: ScratchSubmissionNativeLocation,
    encoder: Readonly<{
        pushDebugGroup?: (groupLabel: string) => void
        popDebugGroup?: () => void
    }>,
    command: { id: string, label?: string | undefined, commandKind: string },
    issue: () => void
): void {

    observation.issue('command-encode', location, () => {
        const detailedDebugGroup = observation.mode === 'detailed' &&
            typeof encoder.pushDebugGroup === 'function' &&
            typeof encoder.popDebugGroup === 'function'
        if (detailedDebugGroup) {
            encoder.pushDebugGroup!(submissionDebugLabel(command))
        }
        try {
            issue()
        } finally {
            if (detailedDebugGroup) encoder.popDebugGroup!()
        }
    })
}

function encoderSegmentLocation(
    submissionId: string,
    segmentIndex: number
): ScratchSubmissionNativeLocation {

    return {
        kind: 'encoder-segment',
        submissionId,
        segmentIndex,
    }
}

function submissionPassLocation(
    submissionId: string,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec
): ScratchSubmissionNativeLocation {

    return {
        kind: 'pass',
        submissionId,
        stepIndex,
        passId: passSpec.id,
        passKind: passSpec.passKind,
    }
}

function standaloneCommandLocation(
    submissionId: string,
    stepIndex: number,
    command: { id: string, commandKind: string }
): ScratchSubmissionNativeLocation {

    return {
        kind: 'standalone-command',
        submissionId,
        stepIndex,
        commandId: command.id,
        commandKind: command.commandKind,
    }
}

function passCommandLocation(
    submissionId: string,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    command: { id: string, commandKind: string }
): ScratchSubmissionNativeLocation {

    return {
        kind: 'pass-command',
        submissionId,
        stepIndex,
        passId: passSpec.id,
        passKind: passSpec.passKind,
        commandId: command.id,
        commandKind: command.commandKind,
    }
}

function submissionQueueActionLocation(
    submissionId: string,
    actionIndex: number,
    actionKind: ScratchSubmissionQueueActionKind
): ScratchSubmissionNativeLocation {

    return {
        kind: 'queue-action',
        submissionId,
        actionIndex,
        actionKind,
    }
}

function uploadQueueActionKind(
    command: UploadCommand | TextureUploadCommand | ExternalImageUploadCommand
): ScratchSubmissionQueueActionKind {

    if (command.uploadKind === 'buffer') return 'buffer-upload'
    if (command.uploadKind === 'texture') return 'texture-upload'
    return 'external-image-upload'
}

function submissionDebugLabel(
    command: { id: string, label?: string | undefined, commandKind: string }
): string {

    const suffix = ` [scratch:${command.id}]`
    const prefix = command.label ?? command.commandKind
    const maximumPrefixLength = Math.max(0, 256 - suffix.length)
    return `${prefix.slice(0, maximumPrefixLength)}${suffix}`
}

function resolveSubmissionBeforeEncoding(builder: SubmissionBuilder): ResolvedSubmissionPlan {

    const diagnostics: ScratchDiagnostic[] = []
    const steps: ResolvedSubmissionStep[] = []
    const executionOutcomes: SubmissionExecutionOutcome[] = []
    let readiness: ReadinessSimulation = new Map()
    let querySlots: QuerySlotSimulation = new Map()
    const readbackSteps = new Map<ReadbackCommand, number>()

    for (const [stepIndex, step] of builder.steps.entries()) {
        if (step.kind === 'upload') {
            validateUploadStep(builder, step)
            if (uploadCommandHasContentEffect(step.command)) markSimulatedReady(readiness, step.command.target)
            steps.push(step)
            continue
        }

        if (step.kind === 'copy') {
            validateCopyStep(builder, step)
            validateCopyReadiness(builder, step, stepIndex, readiness, diagnostics)
            markSimulatedReady(readiness, step.command.target)
            steps.push(step)
            continue
        }

        if (step.kind === 'readback') {
            validateReadbackStep(builder, step)
            validateReadbackUniqueness(builder, step, stepIndex, readbackSteps)
            validateReadbackReadiness(builder, step, stepIndex, readiness, diagnostics)
            steps.push(step)
            continue
        }

        if (step.kind === 'resolve') {
            validateResolveStep(builder, step)
            validateResolveReadiness(builder, step, stepIndex, querySlots, diagnostics)
            markSimulatedReady(readiness, step.command.destination)
            steps.push(step)
            continue
        }

        if (step.kind === 'compute') {
            validateComputeStep(builder, step)
            const passReadiness = new Map(readiness)
            const passQuerySlots = new Map(querySlots)
            const passDiagnostics: ScratchDiagnostic[] = []
            const resolution = resolveComputeReadiness(
                builder,
                step,
                stepIndex,
                passReadiness,
                passDiagnostics
            )
            if (resolution.disposition === 'skip-pass') {
                appendPassExecutionOutcomes(executionOutcomes, stepIndex, step, resolution)
                steps.push({
                    ...step,
                    commands: [],
                    disposition: 'skip-pass',
                    triggerCommandId: resolution.triggerCommandId,
                })
                continue
            }

            markSimulatedTimestampWrites(passQuerySlots, step.passSpec.timestampWrites)
            readiness = passReadiness
            querySlots = passQuerySlots
            diagnostics.push(...passDiagnostics)
            appendPassExecutionOutcomes(executionOutcomes, stepIndex, step, resolution)
            steps.push({ ...step, commands: resolution.commands, disposition: 'execute' })
            continue
        }

        validateRenderStep(builder, step)
        const passReadiness = new Map(readiness)
        const passQuerySlots = new Map(querySlots)
        const passDiagnostics: ScratchDiagnostic[] = []
        const resolution = resolveRenderReadiness(
            builder,
            step,
            stepIndex,
            passReadiness,
            passDiagnostics
        )
        if (resolution.disposition === 'skip-pass') {
            appendPassExecutionOutcomes(executionOutcomes, stepIndex, step, resolution)
            steps.push({
                ...step,
                commands: [],
                disposition: 'skip-pass',
                triggerCommandId: resolution.triggerCommandId,
            })
            continue
        }

        const resolvedStep: RenderStep = { ...step, commands: resolution.commands }
        if (builder.validation !== 'off') {
            passDiagnostics.push(...collectRenderPassResourceConflictDiagnostics(
                builder,
                step,
                resolvedStep,
                stepIndex,
                resolution.commandOutcomes
            ))
        }
        markSimulatedRenderQueryWrites(passQuerySlots, resolvedStep)
        readiness = passReadiness
        querySlots = passQuerySlots
        diagnostics.push(...passDiagnostics)
        appendPassExecutionOutcomes(executionOutcomes, stepIndex, step, resolution)
        steps.push({ ...resolvedStep, disposition: 'execute' })
    }

    return {
        report: createScratchDiagnosticReport(diagnostics),
        steps,
        readiness,
        querySlots,
        executionOutcomes,
    }
}

function applySubmissionValidationDisposition(builder: SubmissionBuilder, report: ScratchDiagnosticReport): void {

    if (builder.validation !== 'throw' || !report.hasErrors) return

    const diagnostic = report.diagnostics.find(candidate => candidate.severity === 'error')
    if (diagnostic !== undefined) throw new ScratchDiagnosticError(diagnostic, report)
}

function validateUploadStep(builder: SubmissionBuilder, step: UploadStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'upload') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission upload step requires an upload command.',
            expected: { command: 'UploadCommand, TextureUploadCommand, or ExternalImageUploadCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

function validateCopyStep(builder: SubmissionBuilder, step: CopyStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'copy') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission copy step requires a CopyCommand.',
            expected: { command: 'CopyCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
    command.validateCurrentRange()
}

function validateCopyReadiness(
    builder: SubmissionBuilder,
    step: CopyStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    validateThrowOnlyCommandReadiness(builder, stepIndex, step.command, [ step.command.source ], readiness, diagnostics, 'source')
}

function validateReadbackStep(builder: SubmissionBuilder, step: ReadbackStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'readback') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission readback step requires a ReadbackCommand.',
            expected: { command: 'ReadbackCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

function validateReadbackReadiness(
    builder: SubmissionBuilder,
    step: ReadbackStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    validateThrowOnlyCommandReadiness(builder, stepIndex, step.command, [ step.command.source ], readiness, diagnostics, 'source')
}

function validateReadbackUniqueness(
    builder: SubmissionBuilder,
    step: ReadbackStep,
    stepIndex: number,
    readbackSteps: Map<ReadbackCommand, number>
): void {

    const firstStepIndex = readbackSteps.get(step.command)
    if (firstStepIndex === undefined) {
        readbackSteps.set(step.command, stepIndex)
        return
    }

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_COMMAND_DUPLICATE_IN_SUBMISSION',
        severity: 'error',
        phase: 'submission',
        subject: step.command.subject,
        related: [ builder.subject ],
        message: 'ReadbackCommand may appear only once in a SubmissionBuilder.',
        expected: { commandOccurrences: 1 },
        actual: {
            commandId: step.command.id,
            firstStepIndex,
            duplicateStepIndex: stepIndex,
            commandOccurrences: 2,
        },
    })
}

function validateResolveStep(builder: SubmissionBuilder, step: ResolveStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'resolve-query-set') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission resolve step requires a ResolveQuerySetCommand.',
            expected: { command: 'ResolveQuerySetCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

function validateResolveReadiness(
    builder: SubmissionBuilder,
    step: ResolveStep,
    stepIndex: number,
    querySlots: QuerySlotSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    const command = step.command

    for (const slot of command.source.slots) {
        const simulated = simulatedQuerySlotState(querySlots, command.source.querySet, slot.index)

        if (simulated.state === 'indeterminate') {
            throwQuerySlotIndeterminateDiagnostic(builder, stepIndex, command, slot, simulated)
        }

        if (command.whenMissing === 'throw' && simulated.state !== 'ready') {
            throwQuerySlotNotReadyDiagnostic(builder, stepIndex, command, slot, simulated)
        }

        if (builder.validation === 'off' || simulated.state !== 'ready') continue

        if (slot.contentEpoch > simulated.contentEpoch) {
            diagnostics.push(createQuerySlotEpochDiagnostic(
                builder,
                stepIndex,
                command,
                slot,
                simulated,
                'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
            ))
            continue
        }

        if (slot.contentEpoch < simulated.contentEpoch) {
            diagnostics.push(createQuerySlotEpochDiagnostic(
                builder,
                stepIndex,
                command,
                slot,
                simulated,
                'SCRATCH_SUBMISSION_STALE_READ'
            ))
        }
    }
}

function resolveComputeReadiness(
    builder: SubmissionBuilder,
    step: ComputeStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): ResolvedPassCommands<DispatchCommand> {

    const commands: DispatchCommand[] = []
    const commandOutcomes: SubmissionCommandExecutionOutcome[] = []
    for (const [commandIndex, command] of step.commands.entries()) {
        const resolution = resolveExecutableCommand(
            builder,
            stepIndex,
            command,
            readiness,
            diagnostics,
            step.passSpec
        )
        commandOutcomes.push(resolution.outcome)
        if (resolution.disposition === 'skip-command') continue
        if (resolution.disposition === 'skip-pass') {
            markCommandOutcomesSkippedPass(commandOutcomes)
            for (const remaining of step.commands.slice(commandIndex + 1)) {
                commandOutcomes.push(createUnattemptedSkippedPassOutcome(stepIndex, step.passSpec, remaining))
            }
            return {
                disposition: 'skip-pass',
                commands: [],
                commandOutcomes,
                triggerCommandId: resolution.triggerCommandId,
            }
        }

        commands.push(resolution.command)
        if (resolution.command._producesDeclaredWrites) {
            for (const resource of resolution.command.resources.write) {
                markSimulatedReady(readiness, resource)
            }
        }
    }

    return { disposition: 'execute', commands, commandOutcomes }
}

function resolveRenderReadiness(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): ResolvedPassCommands<RenderCommand> {

    assertNoIndeterminateRenderAttachmentLoads(builder, step, stepIndex, readiness)
    const commands: RenderCommand[] = []
    const commandOutcomes: SubmissionCommandExecutionOutcome[] = []
    for (const [commandIndex, command] of step.commands.entries()) {
        if (command.commandKind !== 'draw') {
            commands.push(command)
            continue
        }

        const resolution = resolveExecutableCommand(
            builder,
            stepIndex,
            command,
            readiness,
            diagnostics,
            step.passSpec
        )
        commandOutcomes.push(resolution.outcome)
        if (resolution.disposition === 'skip-command') continue
        if (resolution.disposition === 'skip-pass') {
            markCommandOutcomesSkippedPass(commandOutcomes)
            for (const remaining of step.commands.slice(commandIndex + 1)) {
                if (remaining.commandKind !== 'draw') continue
                commandOutcomes.push(createUnattemptedSkippedPassOutcome(stepIndex, step.passSpec, remaining))
            }
            return {
                disposition: 'skip-pass',
                commands: [],
                commandOutcomes,
                triggerCommandId: resolution.triggerCommandId,
            }
        }

        commands.push(resolution.command)
        if (resolution.command._producesDeclaredWrites) {
            for (const resource of resolution.command.resources.write) {
                markSimulatedReady(readiness, resource)
            }
        }
    }

    for (const attachment of step.passSpec.color) {
        if (attachment.target instanceof TextureResource) {
            markSimulatedReady(readiness, attachment.target)
        }
    }

    if (step.passSpec.depth !== undefined) {
        markSimulatedReady(readiness, step.passSpec.depth.target)
    }

    return { disposition: 'execute', commands, commandOutcomes }
}

function assertNoIndeterminateRenderAttachmentLoads(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    readiness: ReadinessSimulation
): void {

    for (const [ attachmentIndex, attachment ] of step.passSpec.color.entries()) {
        if (attachment.load !== 'load' || !(attachment.target instanceof TextureResource)) continue
        const simulated = simulatedResourceState(readiness, attachment.target)
        if (simulated.state === 'indeterminate') {
            throwIndeterminateAttachmentLoadDiagnostic(
                builder,
                step,
                stepIndex,
                attachment.target,
                simulated,
                `color:${attachmentIndex}`
            )
        }
    }

    const depth = step.passSpec.depth
    if (depth === undefined) return
    const simulated = simulatedResourceState(readiness, depth.target)
    if (simulated.state !== 'indeterminate') return
    if (depth.depthLoad === 'load') {
        throwIndeterminateAttachmentLoadDiagnostic(
            builder,
            step,
            stepIndex,
            depth.target,
            simulated,
            'depth'
        )
    }
    if (depth.stencilLoad === 'load') {
        throwIndeterminateAttachmentLoadDiagnostic(
            builder,
            step,
            stepIndex,
            depth.target,
            simulated,
            'stencil'
        )
    }
}

function appendPassExecutionOutcomes(
    outcomes: SubmissionExecutionOutcome[],
    stepIndex: number,
    step: RenderStep | ComputeStep,
    resolution: ResolvedPassCommands<RenderCommand> | ResolvedPassCommands<DispatchCommand>
): void {

    outcomes.push(
        createPassExecutionOutcome(stepIndex, step, resolution),
        ...resolution.commandOutcomes
    )
}

function createPassExecutionOutcome(
    stepIndex: number,
    step: RenderStep | ComputeStep,
    resolution: ResolvedPassCommands<RenderCommand> | ResolvedPassCommands<DispatchCommand>
): SubmissionPassExecutionOutcome {

    const stepKind = step.kind
    const requestedCommandIds = step.commands.map(command => command.id)
    if (resolution.disposition === 'skip-pass') {
        return {
            outcomeKind: 'pass',
            stepIndex,
            stepKind,
            passId: step.passSpec.id,
            status: 'skipped-pass',
            triggerCommandId: resolution.triggerCommandId,
            requestedCommandIds,
            encodedCommandIds: [],
        }
    }

    const hasEncoderWork = resolution.commands.length > 0 || step.passSpec.hasEncoderSideEffects()
    return {
        outcomeKind: 'pass',
        stepIndex,
        stepKind,
        passId: step.passSpec.id,
        status: hasEncoderWork ? 'executed' : 'skipped-empty',
        requestedCommandIds,
        encodedCommandIds: hasEncoderWork ? resolution.commands.map(command => command.id) : [],
    }
}

function resolveExecutableCommand<Command extends ExecutableCommand>(
    builder: SubmissionBuilder,
    stepIndex: number,
    requestedCommand: Command,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[],
    passSpec: RenderPassSpec | ComputePassSpec
): ResolvedExecutableCommand<Command> {

    const attempts: SubmissionCommandReadinessAttempt[] = []
    const attemptedCommands: ExecutableCommand[] = []
    const visited = new Set<ExecutableCommand>()
    const visitedIds = new Set<string>()
    let command: ExecutableCommand = requestedCommand

    while (true) {
        if (visited.has(command)) {
            throwFallbackResolutionDiagnostic(
                builder,
                stepIndex,
                passSpec,
                requestedCommand,
                attemptedCommands,
                attempts,
                command,
                'cycle'
            )
        }
        if (visitedIds.has(command.id)) {
            throwFallbackResolutionDiagnostic(
                builder,
                stepIndex,
                passSpec,
                requestedCommand,
                attemptedCommands,
                attempts,
                command,
                'repeated-id'
            )
        }
        visited.add(command)
        visitedIds.add(command.id)
        attemptedCommands.push(command)

        assertNoIndeterminateResourceReads(
            builder,
            stepIndex,
            command,
            command.resources.read,
            readiness,
            passSpec,
            { requestedCommand, attemptedCommands, attempts }
        )

        const missingRequirements = collectMissingReadRequirements(command.resources.read, readiness)
        attempts.push({
            commandId: command.id,
            commandKind: command.commandKind,
            policy: command.whenMissing,
            missing: missingRequirements.map(missing => createMissingResourceFact(missing)),
        })

        if (command !== requestedCommand) {
            validateFallbackCommandForPass(
                builder,
                stepIndex,
                passSpec,
                requestedCommand,
                attemptedCommands,
                attempts,
                command
            )
        }

        if (missingRequirements.length === 0) {
            const context = { requestedCommand, attemptedCommands, attempts }
            validateCommandReadEpochs(
                builder,
                stepIndex,
                command,
                command.resources.read,
                readiness,
                diagnostics,
                passSpec,
                undefined,
                context
            )
            return {
                disposition: 'execute',
                command: command as Command,
                outcome: createCommandExecutionOutcome(
                    stepIndex,
                    passSpec,
                    requestedCommand,
                    command === requestedCommand ? 'executed' : 'fallback-executed',
                    attempts,
                    command.id
                ),
            }
        }

        if (command.whenMissing === 'throw') {
            const first = missingRequirements[0]!
            throwCommandResourceNotReadyDiagnostic(
                builder,
                stepIndex,
                command,
                first.readRequirement,
                first.simulated,
                passSpec,
                undefined,
                { requestedCommand, attemptedCommands, attempts }
            )
        }

        if (command.whenMissing === 'skip-command') {
            return {
                disposition: 'skip-command',
                outcome: createCommandExecutionOutcome(
                    stepIndex,
                    passSpec,
                    requestedCommand,
                    'skipped-command',
                    attempts
                ),
            }
        }

        if (command.whenMissing === 'skip-pass') {
            return {
                disposition: 'skip-pass',
                triggerCommandId: command.id,
                outcome: createCommandExecutionOutcome(
                    stepIndex,
                    passSpec,
                    requestedCommand,
                    'skipped-pass',
                    attempts
                ),
            }
        }

        const fallback = command.fallback
        if (fallback === undefined) {
            throwFallbackResolutionDiagnostic(
                builder,
                stepIndex,
                passSpec,
                requestedCommand,
                attemptedCommands,
                attempts,
                command,
                'missing-fallback'
            )
        }
        command = fallback
    }
}

function createCommandExecutionOutcome(
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    requestedCommand: ExecutableCommand,
    status: SubmissionCommandExecutionOutcome['status'],
    attempts: SubmissionCommandReadinessAttempt[],
    executedCommandId?: string
): SubmissionCommandExecutionOutcome {

    const outcome: SubmissionCommandExecutionOutcome = {
        outcomeKind: 'command',
        stepIndex,
        stepKind: passSpec.passKind,
        passId: passSpec.id,
        requestedCommandId: requestedCommand.id,
        requestedCommandKind: requestedCommand.commandKind,
        status,
        attempts,
    }
    if (executedCommandId !== undefined) outcome.executedCommandId = executedCommandId

    return outcome
}

function createUnattemptedSkippedPassOutcome(
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    requestedCommand: ExecutableCommand
): SubmissionCommandExecutionOutcome {

    return createCommandExecutionOutcome(stepIndex, passSpec, requestedCommand, 'skipped-pass', [])
}

function markCommandOutcomesSkippedPass(outcomes: SubmissionCommandExecutionOutcome[]): void {

    for (const outcome of outcomes) {
        outcome.status = 'skipped-pass'
        delete outcome.executedCommandId
    }
}

function collectMissingReadRequirements(
    readRequirements: readonly CommandResourceReadDescriptor[],
    readiness: ReadinessSimulation
): MissingReadRequirement[] {

    return readRequirements
        .map(readRequirement => ({
            readRequirement,
            simulated: simulatedResourceState(readiness, readRequirement.resource),
        }))
        .filter(({ simulated }) => simulated.state !== 'ready')
}

function assertNoIndeterminateResourceReads(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirements: readonly CommandResourceReadDescriptor[],
    readiness: ReadinessSimulation,
    passSpec?: RenderPassSpec | ComputePassSpec,
    context?: CommandExecutionDiagnosticContext,
    role?: string
): void {

    for (const readRequirement of readRequirements) {
        const simulated = simulatedResourceState(readiness, readRequirement.resource)
        if (simulated.state !== 'indeterminate') continue
        throwIndeterminateResourceReadDiagnostic(
            builder,
            stepIndex,
            command,
            readRequirement,
            simulated,
            passSpec,
            role,
            context
        )
    }
}

function createMissingResourceFact(missing: MissingReadRequirement, role?: string): SubmissionMissingResource {

    const resource = missing.readRequirement.resource
    const fact: SubmissionMissingResource = {
        resourceId: resource.id,
        resourceKind: resource.resourceKind,
        subject: resource.subject,
        requiredContentEpoch: missing.readRequirement.contentEpoch,
        simulatedState: missing.simulated.state,
        simulatedContentEpoch: missing.simulated.contentEpoch,
        allocationVersion: resource.allocationVersion,
    }
    if (resource.label !== undefined) fact.label = resource.label
    if (role !== undefined) fact.role = role

    return fact
}

function snapshotReadinessAttempts(
    attempts: readonly SubmissionCommandReadinessAttempt[]
): SubmissionCommandReadinessAttempt[] {

    return attempts.map(attempt => ({
        commandId: attempt.commandId,
        commandKind: attempt.commandKind,
        policy: attempt.policy,
        missing: attempt.missing.map(missing => ({
            ...missing,
            subject: { ...missing.subject },
        })),
    }))
}

function readinessAttemptSubjects(
    attempts: readonly SubmissionCommandReadinessAttempt[]
): DiagnosticSubject[] {

    const subjects: DiagnosticSubject[] = []
    const seen = new Set<string>()

    for (const attempt of attempts) {
        for (const missing of attempt.missing) {
            const subject = missing.subject
            const key = `${subject.kind}\u0000${subject.id ?? ''}\u0000${subject.label ?? ''}`
            if (seen.has(key)) continue
            seen.add(key)
            subjects.push(subject)
        }
    }

    return subjects
}

function readinessAttemptCommandSubjects(
    requestedCommand: DrawCommand,
    attempts: readonly SubmissionCommandReadinessAttempt[]
): DiagnosticSubject[] {

    const attemptedIds = new Set(attempts.map(attempt => attempt.commandId))
    const subjects: DiagnosticSubject[] = []
    let command: DrawCommand | undefined = requestedCommand

    while (command !== undefined && attemptedIds.has(command.id)) {
        subjects.push(command.subject)
        command = command.fallback
    }

    return subjects
}

function validateFallbackCommandForPass(
    builder: SubmissionBuilder,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    requestedCommand: ExecutableCommand,
    attemptedCommands: readonly ExecutableCommand[],
    attempts: readonly SubmissionCommandReadinessAttempt[],
    fallback: ExecutableCommand
): void {

    if (
        !isRecord(fallback) ||
        typeof fallback.assertRuntime !== 'function' ||
        typeof fallback.validateForPass !== 'function' ||
        typeof fallback.encode !== 'function'
    ) {
        throwFallbackPassIncompatibleDiagnostic(
            builder,
            stepIndex,
            passSpec,
            requestedCommand,
            attemptedCommands,
            attempts,
            fallback,
            'invalid-fallback-command'
        )
    }

    if (fallback.isDisposed) {
        throwFallbackResolutionDiagnostic(
            builder,
            stepIndex,
            passSpec,
            requestedCommand,
            attemptedCommands,
            attempts,
            fallback,
            'disposed'
        )
    }

    try {
        fallback.assertRuntime(builder.runtime)
    } catch (error) {
        if (error instanceof ScratchDiagnosticError) {
            throwFallbackResolutionDiagnostic(
                builder,
                stepIndex,
                passSpec,
                requestedCommand,
                attemptedCommands,
                attempts,
                fallback,
                error.diagnostic.code,
                error.diagnostic
            )
        }
        throw error
    }

    try {
        if (fallback.commandKind === 'draw' && passSpec.passKind === 'render') {
            fallback.validateForPass(passSpec)
            validatePipelineTargets(fallback, passSpec)
            return
        }

        if (fallback.commandKind === 'dispatch' && passSpec.passKind === 'compute') {
            fallback.validateForPass(passSpec)
            return
        }

        throwFallbackPassIncompatibleDiagnostic(
            builder,
            stepIndex,
            passSpec,
            requestedCommand,
            attemptedCommands,
            attempts,
            fallback,
            'pass-kind'
        )
    } catch (error) {
        if (error instanceof ScratchDiagnosticError && error.diagnostic.code === 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE') {
            throw error
        }

        throwFallbackPassIncompatibleDiagnostic(
            builder,
            stepIndex,
            passSpec,
            requestedCommand,
            attemptedCommands,
            attempts,
            fallback,
            error instanceof ScratchDiagnosticError ? error.diagnostic.code : 'pass-validation'
        )
    }
}

function throwFallbackPassIncompatibleDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    requestedCommand: ExecutableCommand,
    attemptedCommands: readonly ExecutableCommand[],
    attempts: readonly SubmissionCommandReadinessAttempt[],
    fallback: unknown,
    reason: string
): never {

    const fallbackRecord = isRecord(fallback) ? fallback : {}

    throwScratchDiagnostic({
        code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
        severity: 'error',
        phase: 'submission',
        subject: diagnosticSubjectOf(fallback) ?? requestedCommand.subject,
        related: [
            requestedCommand.subject,
            ...attemptedCommands.map(command => command.subject),
            ...readinessAttemptSubjects(attempts),
            passSpec.subject,
            builder.subject,
        ],
        message: 'Selected fallback command is incompatible with the current submission pass.',
        expected: {
            commandKind: requestedCommand.commandKind,
            passKind: passSpec.passKind,
            pipeline: 'compatible with the current pass attachments and state',
        },
        actual: {
            reason,
            stepIndex,
            passId: passSpec.id,
            requestedCommandId: requestedCommand.id,
            fallbackCommandId: fallbackRecord.id,
            fallbackCommandKind: fallbackRecord.commandKind,
            attemptedCommandIds: attemptedCommands.map(command => command.id),
            attempts: snapshotReadinessAttempts(attempts),
            validation: builder.validation,
        },
    })
}

function throwFallbackResolutionDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    passSpec: RenderPassSpec | ComputePassSpec,
    requestedCommand: ExecutableCommand,
    attemptedCommands: readonly ExecutableCommand[],
    attempts: readonly SubmissionCommandReadinessAttempt[],
    fallback: ExecutableCommand,
    reason: string,
    cause?: ScratchDiagnostic
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_FALLBACK_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: fallback.subject,
        related: [
            requestedCommand.subject,
            ...attemptedCommands.map(command => command.subject),
            ...readinessAttemptSubjects(attempts),
            ...(cause !== undefined ? [ cause.subject, ...(cause.related ?? []) ] : []),
            passSpec.subject,
            builder.subject,
        ],
        message: 'Fallback resolution encountered an unusable, missing, or repeated command.',
        expected: { fallbackChain: 'finite acyclic command chain with unique ids', disposed: false },
        actual: {
            reason,
            stepIndex,
            passId: passSpec.id,
            requestedCommandId: requestedCommand.id,
            fallbackCommandId: fallback.id,
            attemptedCommandIds: attemptedCommands.map(command => command.id),
            attempts: snapshotReadinessAttempts(attempts),
            ...(cause !== undefined ? {
                cause: {
                    code: cause.code,
                    severity: cause.severity,
                    phase: cause.phase,
                    subject: cause.subject,
                    expected: cause.expected,
                    actual: cause.actual,
                },
            } : {}),
            validation: builder.validation,
        },
    })
}

function markSimulatedTimestampWrites(querySlots: QuerySlotSimulation, timestampWrites: ComputePassSpec['timestampWrites']): void {

    if (timestampWrites === undefined) return

    const indices = [ timestampWrites.begin, timestampWrites.end ].filter((value): value is number => value !== undefined)
    for (const index of new Set(indices)) {
        markSimulatedQuerySlotReady(querySlots, timestampWrites.querySet, index)
    }
}

function markSimulatedRenderQueryWrites(querySlots: QuerySlotSimulation, step: RenderStep): void {

    markSimulatedTimestampWrites(querySlots, step.passSpec.timestampWrites)

    let activeCommand: BeginOcclusionQueryCommand | undefined
    for (const command of step.commands) {
        if (command.commandKind === 'begin-occlusion-query') {
            activeCommand = command
            continue
        }

        if (command.commandKind !== 'end-occlusion-query') continue

        if (activeCommand !== undefined) {
            markSimulatedQuerySlotReady(querySlots, activeCommand.querySet, activeCommand.index)
            activeCommand = undefined
        }
    }
}

function validateThrowOnlyCommandReadiness(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: CopyCommand | ReadbackCommand,
    readRequirements: readonly CommandResourceReadDescriptor[],
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[],
    role?: string
): void {

    assertNoIndeterminateResourceReads(
        builder,
        stepIndex,
        command,
        readRequirements,
        readiness,
        undefined,
        undefined,
        role
    )
    const missing = collectMissingReadRequirements(readRequirements, readiness)

    if (missing.length > 0) {
        const first = missing[0]!
        throwCommandResourceNotReadyDiagnostic(
            builder,
            stepIndex,
            command,
            first.readRequirement,
            first.simulated,
            undefined,
            role
        )
    }

    validateCommandReadEpochs(builder, stepIndex, command, readRequirements, readiness, diagnostics, undefined, role)
}

function validateCommandReadEpochs(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirements: readonly CommandResourceReadDescriptor[],
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[],
    passSpec?: RenderPassSpec | ComputePassSpec,
    role?: string,
    context?: CommandExecutionDiagnosticContext
): void {

    for (const readRequirement of readRequirements) {
        const resource = readRequirement.resource
        const simulated = simulatedResourceState(readiness, resource)

        if (builder.validation === 'off' || simulated.state !== 'ready') continue

        if (readRequirement.contentEpoch > simulated.contentEpoch) {
            diagnostics.push(createCommandReadEpochDiagnostic(
                builder,
                stepIndex,
                command,
                readRequirement,
                simulated,
                passSpec,
                role,
                'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                context
            ))
            continue
        }

        if (readRequirement.contentEpoch < simulated.contentEpoch) {
            diagnostics.push(createCommandReadEpochDiagnostic(
                builder,
                stepIndex,
                command,
                readRequirement,
                simulated,
                passSpec,
                role,
                'SCRATCH_SUBMISSION_STALE_READ',
                context
            ))
        }
    }
}

function simulatedResourceState(readiness: ReadinessSimulation, resource: Resource): ResourceSimulationState {

    return readiness.get(resource.id) ?? {
        state: resource.state,
        contentEpoch: resource.contentEpoch,
    }
}

function markSimulatedReady(readiness: ReadinessSimulation, resource: Resource): void {

    const simulated = simulatedResourceState(readiness, resource)
    readiness.set(resource.id, {
        state: 'ready',
        contentEpoch: simulated.contentEpoch + 1,
    })
}

function simulatedQuerySlotState(
    querySlots: QuerySlotSimulation,
    querySet: QuerySetResource,
    index: number
): QuerySlotSimulationState {

    return querySlots.get(querySlotKey(querySet, index)) ?? {
        state: querySet.slotStates[index] ?? 'empty',
        contentEpoch: querySet.slotContentEpochs[index] ?? 0,
    }
}

function markSimulatedQuerySlotReady(querySlots: QuerySlotSimulation, querySet: QuerySetResource, index: number): void {

    const simulated = simulatedQuerySlotState(querySlots, querySet, index)
    querySlots.set(querySlotKey(querySet, index), {
        state: 'ready',
        contentEpoch: simulated.contentEpoch + 1,
    })
}

function querySlotKey(querySet: QuerySetResource, index: number): string {

    return `${querySet.id}:${index}`
}

function throwQuerySlotNotReadyDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ResolveQuerySetCommand,
    slot: QuerySetSlotReadDescriptor,
    simulated: QuerySlotSimulationState
): never {

    const querySet = command.source.querySet

    throwScratchDiagnostic({
        code: 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE',
        severity: 'error',
        phase: 'query',
        subject: command.subject,
        related: [
            querySet.subject,
            builder.subject,
        ],
        message: 'ResolveQuerySetCommand source query slot is not ready.',
        expected: { slotState: 'ready' },
        actual: {
            submissionId: builder.id,
            stepIndex,
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            role: 'source',
            querySetId: querySet.id,
            queryType: querySet.type,
            slotIndex: slot.index,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            requiredContentEpoch: slot.contentEpoch,
            simulatedContentEpoch: simulated.contentEpoch,
            currentContentEpoch: querySet.slotContentEpochs[slot.index] ?? 0,
            simulatedSlotState: simulated.state,
            whenMissing: command.whenMissing,
        },
    })
}

function throwQuerySlotIndeterminateDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ResolveQuerySetCommand,
    slot: QuerySetSlotReadDescriptor,
    simulated: QuerySlotSimulationState
): never {

    const querySet = command.source.querySet
    throwScratchDiagnostic({
        code: 'SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE',
        severity: 'error',
        phase: 'query',
        subject: command.subject,
        related: [ querySet.subject, builder.subject ],
        message: 'ResolveQuerySetCommand cannot read a query slot whose current content is indeterminate.',
        expected: {
            slotState: 'ready',
            recovery: 'explicit later query producer before this resolve',
        },
        actual: {
            submissionId: builder.id,
            stepIndex,
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            role: 'source',
            querySetId: querySet.id,
            queryType: querySet.type,
            slotIndex: slot.index,
            requiredContentEpoch: slot.contentEpoch,
            simulatedContentEpoch: simulated.contentEpoch,
            currentContentEpoch: querySet.slotContentEpochs[slot.index] ?? 0,
            simulatedSlotState: simulated.state,
            whenMissing: command.whenMissing,
            validation: builder.validation,
        },
    })
}

function createQuerySlotEpochDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ResolveQuerySetCommand,
    slot: QuerySetSlotReadDescriptor,
    simulated: QuerySlotSimulationState,
    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE' | 'SCRATCH_SUBMISSION_STALE_READ'
): ScratchDiagnostic {

    const querySet = command.source.querySet
    const isFutureRead = code === 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'

    return createScratchDiagnostic({
        code,
        severity: 'error',
        phase: 'submission',
        subject: command.subject,
        related: [
            querySet.subject,
            builder.subject,
        ],
        message: isFutureRead
            ? 'ResolveQuerySetCommand requires a query slot content epoch that has not been produced at its read point.'
            : 'ResolveQuerySetCommand requires an older query slot content epoch than the one available at its read point.',
        expected: { contentEpoch: slot.contentEpoch },
        actual: {
            submissionId: builder.id,
            stepIndex,
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            role: 'source',
            querySetId: querySet.id,
            queryType: querySet.type,
            slotIndex: slot.index,
            firstQuery: command.firstQuery,
            queryCount: command.queryCount,
            requiredContentEpoch: slot.contentEpoch,
            simulatedContentEpoch: simulated.contentEpoch,
            currentContentEpoch: querySet.slotContentEpochs[slot.index] ?? 0,
            simulatedSlotState: simulated.state,
            whenMissing: command.whenMissing,
        },
    })
}

function throwCommandResourceNotReadyDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirement: CommandResourceReadDescriptor,
    simulated: ResourceSimulationState,
    passSpec?: RenderPassSpec | ComputePassSpec,
    role?: string,
    context?: CommandExecutionDiagnosticContext
): never {

    const resource = readRequirement.resource

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            resource.subject,
            ...(context?.attemptedCommands.map(attempted => attempted.subject) ?? []),
            ...(context !== undefined ? readinessAttemptSubjects(context.attempts) : []),
            passSpec?.subject,
            builder.subject,
        ].filter(isDefined),
        message: 'Command read resource is not ready.',
        expected: { resourceState: 'ready' },
        actual: {
            stepIndex,
            ...(passSpec !== undefined ? { passId: passSpec.id } : {}),
            ...(context !== undefined ? {
                requestedCommandId: context.requestedCommand.id,
                attemptedCommandIds: context.attemptedCommands.map(attempted => attempted.id),
                attempts: snapshotReadinessAttempts(context.attempts),
            } : {}),
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            ...(role !== undefined ? { role } : {}),
            resourceId: resource.id,
            resourceKind: resource.resourceKind,
            resourceState: simulated.state,
            contentEpoch: simulated.contentEpoch,
            requiredContentEpoch: readRequirement.contentEpoch,
            simulatedContentEpoch: simulated.contentEpoch,
            currentContentEpoch: resource.contentEpoch,
            allocationVersion: resource.allocationVersion,
            whenMissing: command.whenMissing,
            validation: builder.validation,
        },
    })
}

function throwIndeterminateResourceReadDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirement: CommandResourceReadDescriptor,
    simulated: ResourceSimulationState,
    passSpec?: RenderPassSpec | ComputePassSpec,
    role?: string,
    context?: CommandExecutionDiagnosticContext
): never {

    const resource = readRequirement.resource
    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            resource.subject,
            ...(context?.attemptedCommands.map(attempted => attempted.subject) ?? []),
            passSpec?.subject,
            builder.subject,
        ].filter(isDefined),
        message: 'Command cannot read resource content that a failed submission left indeterminate.',
        expected: {
            resourceState: 'ready',
            recovery: 'explicit later content producer before this read',
        },
        actual: {
            stepIndex,
            ...(passSpec !== undefined ? { passId: passSpec.id } : {}),
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            ...(role !== undefined ? { role } : {}),
            resourceId: resource.id,
            resourceKind: resource.resourceKind,
            resourceState: simulated.state,
            contentEpoch: simulated.contentEpoch,
            requiredContentEpoch: readRequirement.contentEpoch,
            currentContentEpoch: resource.contentEpoch,
            allocationVersion: resource.allocationVersion,
            whenMissing: command.whenMissing,
            validation: builder.validation,
        },
    })
}

function throwIndeterminateAttachmentLoadDiagnostic(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    target: TextureResource,
    simulated: ResourceSimulationState,
    attachmentRole: string
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE',
        severity: 'error',
        phase: 'submission',
        subject: step.passSpec.subject,
        related: [ target.subject, builder.subject ],
        message: 'Render pass load cannot consume indeterminate persistent attachment content.',
        expected: {
            attachmentState: 'ready',
            recovery: 'clear or explicitly produce the attachment before loading it',
        },
        actual: {
            stepIndex,
            passId: step.passSpec.id,
            passKind: step.passSpec.passKind,
            attachmentRole,
            resourceId: target.id,
            resourceKind: target.resourceKind,
            resourceState: simulated.state,
            contentEpoch: simulated.contentEpoch,
            currentContentEpoch: target.contentEpoch,
            allocationVersion: target.allocationVersion,
            validation: builder.validation,
        },
    })
}

function createCommandReadEpochDiagnostic(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirement: CommandResourceReadDescriptor,
    simulated: ResourceSimulationState,
    passSpec: RenderPassSpec | ComputePassSpec | undefined,
    role: string | undefined,
    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE' | 'SCRATCH_SUBMISSION_STALE_READ',
    context?: CommandExecutionDiagnosticContext
): ScratchDiagnostic {

    const resource = readRequirement.resource
    const isFutureRead = code === 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'

    return createScratchDiagnostic({
        code,
        severity: 'error',
        phase: 'submission',
        subject: command.subject,
        related: [
            resource.subject,
            ...(context?.attemptedCommands.map(attempted => attempted.subject) ?? []),
            ...(context !== undefined ? readinessAttemptSubjects(context.attempts) : []),
            passSpec?.subject,
            builder.subject,
        ].filter(isDefined),
        message: isFutureRead
            ? 'Command requires a resource content epoch that has not been produced at its read point.'
            : 'Command requires an older resource content epoch than the one available at its read point.',
        expected: { contentEpoch: readRequirement.contentEpoch },
        actual: {
            stepIndex,
            ...(passSpec !== undefined ? { passId: passSpec.id } : {}),
            ...(context !== undefined ? {
                requestedCommandId: context.requestedCommand.id,
                attemptedCommandIds: context.attemptedCommands.map(attempted => attempted.id),
                attempts: snapshotReadinessAttempts(context.attempts),
            } : {}),
            commandId: command.id,
            commandKind: command.commandKind,
            access: 'read',
            ...(role !== undefined ? { role } : {}),
            resourceId: resource.id,
            resourceKind: resource.resourceKind,
            resourceState: simulated.state,
            requiredContentEpoch: readRequirement.contentEpoch,
            simulatedContentEpoch: simulated.contentEpoch,
            currentContentEpoch: resource.contentEpoch,
            allocationVersion: resource.allocationVersion,
            whenMissing: command.whenMissing,
            validation: builder.validation,
        },
    })
}

export class SubmittedWork {

    #runtime: ScratchRuntime
    #id: string
    #commandBuffers: readonly GPUCommandBuffer[]
    #report: ScratchDiagnosticReport
    #diagnostics: readonly ScratchDiagnostic[]
    #resourceAccesses: readonly SubmissionResourceAccess[]
    #producerEpochs: readonly SubmittedResourceEpoch[]
    #executionOutcomes: readonly SubmissionExecutionOutcome[]
    #readbacks: readonly SubmittedReadbackLink[]
    #potentialWrites: readonly SubmittedPotentialWrite[]
    #nativeOutcome: Promise<ScratchSubmissionNativeOutcome>
    #done: Promise<unknown>

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        options: SubmittedWorkOptions
    ) {

        if (token !== submittedWorkToken || new.target !== SubmittedWork) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMITTED_WORK_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'submission',
                subject: { kind: 'Submission' },
                message: 'SubmittedWork must be created by SubmissionBuilder.submit().',
                hints: [ 'Use runtime.submission().submit().' ],
            })
        }

        this.#runtime = runtime
        this.#id = options.id
        this.#commandBuffers = Object.freeze([ ...options.commandBuffers ])
        this.#report = freezeSubmittedDiagnosticReport(options.report)
        this.#diagnostics = this.#report.diagnostics
        this.#resourceAccesses = freezeResourceAccesses(options.resourceAccesses)
        this.#producerEpochs = freezeProducerEpochs(createProducerEpochs(this.#resourceAccesses))
        this.#executionOutcomes = freezeExecutionOutcomes(options.executionOutcomes)
        this.#readbacks = freezeSubmittedReadbackLinks(options.readbacks)
        this.#potentialWrites = freezeSubmittedPotentialWriteFacts(options.potentialWrites)
        this.#nativeOutcome = options.nativeOutcome
        this.#done = options.done
        Object.preventExtensions(this)
    }

    get runtime(): ScratchRuntime { return this.#runtime }
    get id(): string { return this.#id }
    get commandBuffers(): readonly GPUCommandBuffer[] { return this.#commandBuffers }
    get report(): ReadonlySubmittedFact<ScratchDiagnosticReport> { return this.#report }
    get diagnostics(): readonly ReadonlySubmittedFact<ScratchDiagnostic>[] { return this.#diagnostics }
    get resourceAccesses(): readonly ReadonlySubmittedFact<SubmissionResourceAccess>[] {

        return this.#resourceAccesses
    }
    get producerEpochs(): readonly ReadonlySubmittedFact<SubmittedResourceEpoch>[] {

        return this.#producerEpochs
    }
    get executionOutcomes(): readonly ReadonlySubmittedFact<SubmissionExecutionOutcome>[] {

        return this.#executionOutcomes
    }
    get readbacks(): readonly ReadonlySubmittedFact<SubmittedReadbackLink>[] { return this.#readbacks }
    get potentialWrites(): readonly ReadonlySubmittedFact<SubmittedPotentialWrite>[] {

        return this.#potentialWrites
    }
    get nativeOutcome(): Promise<ScratchSubmissionNativeOutcome> { return this.#nativeOutcome }
    get done(): Promise<unknown> { return this.#done }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

type SubmittedWorkOptions = Readonly<{
    id: string
    commandBuffers: readonly GPUCommandBuffer[]
    report: ScratchDiagnosticReport
    resourceAccesses: SubmissionResourceAccess[]
    executionOutcomes: SubmissionExecutionOutcome[]
    readbacks: readonly SubmittedReadbackLink[]
    potentialWrites: readonly SubmittedPotentialWrite[]
    nativeOutcome: Promise<ScratchSubmissionNativeOutcome>
    done: Promise<unknown>
}>

const submittedWorkToken = Symbol('SubmittedWork')

function createSubmittedWork(
    runtime: ScratchRuntime,
    options: SubmittedWorkOptions
): SubmittedWork {

    const Constructor = SubmittedWork as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        options: SubmittedWorkOptions
    ) => SubmittedWork
    return new Constructor(submittedWorkToken, runtime, options)
}

Object.freeze(SubmittedWork.prototype)

function commandAccessOrigin(
    stepIndex: number,
    stepKind: SubmissionStepKind,
    command: { id: string, commandKind: string },
    passSpec?: RenderPassSpec | ComputePassSpec
): SubmissionAccessOrigin {

    const origin: SubmissionAccessOrigin = {
        stepIndex,
        stepKind,
        commandKind: command.commandKind,
        commandId: command.id,
    }
    if (passSpec !== undefined) origin.passId = passSpec.id

    return origin
}

function passAccessOrigin(stepIndex: number, stepKind: SubmissionStepKind, passSpec: RenderPassSpec | ComputePassSpec): SubmissionAccessOrigin {

    return {
        stepIndex,
        stepKind,
        passId: passSpec.id,
    }
}

function captureResourceAccess(
    resource: Resource,
    access: SubmissionResourceAccessKind,
    origin: SubmissionAccessOrigin
): PendingSubmissionResourceAccess {

    return {
        origin,
        resource,
        access,
        contentEpochBefore: resource.contentEpoch,
    }
}

function completeResourceAccesses(
    resourceAccesses: SubmissionResourceAccess[],
    pendingAccesses: PendingSubmissionResourceAccess[]
): void {

    for (const pendingAccess of pendingAccesses) {
        resourceAccesses.push(createResourceAccess(pendingAccess))
    }
}

function createResourceAccess(pendingAccess: PendingSubmissionResourceAccess): SubmissionResourceAccess {

    const resource = pendingAccess.resource
    const access: SubmissionResourceAccess = {
        ...pendingAccess.origin,
        resourceId: resource.id,
        resourceKind: resource.resourceKind,
        subject: resource.subject,
        access: pendingAccess.access,
        contentEpochBefore: pendingAccess.contentEpochBefore,
        contentEpochAfter: pendingAccess.access === 'write' ? resource.contentEpoch : pendingAccess.contentEpochBefore,
        allocationVersion: resource.allocationVersion,
    }
    if (resource.label !== undefined) access.label = resource.label

    return access
}

function captureRenderAttachmentWrites(stepIndex: number, passSpec: RenderPassSpec): PendingSubmissionResourceAccess[] {

    const origin = passAccessOrigin(stepIndex, 'render', passSpec)
    const writes: PendingSubmissionResourceAccess[] = []
    const writtenTargets = new Set<TextureResource>()

    for (const attachment of passSpec.color) {
        const target = attachment.target
        if (!(target instanceof TextureResource) || writtenTargets.has(target)) continue

        writes.push(captureResourceAccess(target, 'write', origin))
        writtenTargets.add(target)
    }

    if (passSpec.depth !== undefined && !writtenTargets.has(passSpec.depth.target)) {
        writes.push(captureResourceAccess(passSpec.depth.target, 'write', origin))
        writtenTargets.add(passSpec.depth.target)
    }

    return writes
}

function createProducerEpochs(resourceAccesses: readonly SubmissionResourceAccess[]): SubmittedResourceEpoch[] {

    const producerEpochs: SubmittedResourceEpoch[] = []

    for (const access of resourceAccesses) {
        if (access.access !== 'write') continue

        producerEpochs.push(createProducerEpoch(access))
    }

    return producerEpochs
}

function createProducerEpoch(access: SubmissionResourceAccess): SubmittedResourceEpoch {

    const producerEpoch: SubmittedResourceEpoch = {
        resourceId: access.resourceId,
        resourceKind: access.resourceKind,
        subject: access.subject,
        contentEpoch: access.contentEpochAfter,
        allocationVersion: access.allocationVersion,
        producedBy: accessOriginFromAccess(access),
    }
    if (access.label !== undefined) producerEpoch.label = access.label

    return producerEpoch
}

function findReadbackProducerEpoch(
    submitted: SubmittedWork,
    pending: PendingReadback
): SubmittedResourceEpoch | undefined {

    for (let index = submitted.producerEpochs.length - 1; index >= 0; index--) {
        const producerEpoch = submitted.producerEpochs[index]
        if (
            producerEpoch.resourceId === pending.command.source.resource.id &&
            producerEpoch.contentEpoch === pending.contentEpoch &&
            producerEpoch.allocationVersion === pending.allocationVersion &&
            producerEpoch.producedBy.stepIndex < pending.stepIndex
        ) {
            return producerEpoch
        }
    }

    return undefined
}

function accessOriginFromAccess(access: SubmissionResourceAccess): SubmissionAccessOrigin {

    const origin: SubmissionAccessOrigin = {
        stepIndex: access.stepIndex,
        stepKind: access.stepKind,
    }
    if (access.commandKind !== undefined) origin.commandKind = access.commandKind
    if (access.commandId !== undefined) origin.commandId = access.commandId
    if (access.passId !== undefined) origin.passId = access.passId

    return origin
}

function freezeResourceAccesses(resourceAccesses: SubmissionResourceAccess[]): readonly SubmissionResourceAccess[] {

    return Object.freeze(resourceAccesses.map((access) => Object.freeze({
        ...access,
        subject: freezeDiagnosticSubject(access.subject),
    } as SubmissionResourceAccess)))
}

function freezeProducerEpochs(producerEpochs: SubmittedResourceEpoch[]): readonly SubmittedResourceEpoch[] {

    return Object.freeze(producerEpochs.map((producerEpoch) => Object.freeze({
        ...producerEpoch,
        subject: freezeDiagnosticSubject(producerEpoch.subject),
        producedBy: Object.freeze({ ...producerEpoch.producedBy }) as SubmissionAccessOrigin,
    } as SubmittedResourceEpoch)))
}

function freezeSubmittedReadbackLinks(
    readbacks: readonly SubmittedReadbackLink[]
): readonly SubmittedReadbackLink[] {

    return Object.freeze(readbacks.map(link => Object.freeze({ ...link })))
}

function freezeSubmittedPotentialWriteFacts(
    writes: readonly (SubmissionPotentialWrite | SubmittedPotentialWrite)[]
): readonly SubmittedPotentialWrite[] {

    return Object.freeze(writes.map(write => {
        if (write.kind === 'resource' && 'resource' in write) {
            return Object.freeze({
                kind: 'resource' as const,
                resourceId: write.resource.id,
                resourceKind: write.resource.resourceKind,
                ...(write.resource.label !== undefined ? { label: write.resource.label } : {}),
                subject: freezeDiagnosticSubject(write.resource.subject),
                allocationVersion: write.allocationVersion,
                contentEpoch: write.contentEpoch,
            })
        }
        if (write.kind === 'query-slot' && 'querySet' in write) {
            return Object.freeze({
                kind: 'query-slot' as const,
                querySetId: write.querySet.id,
                queryType: write.querySet.type,
                ...(write.querySet.label !== undefined ? { label: write.querySet.label } : {}),
                subject: freezeDiagnosticSubject(write.querySet.subject),
                index: write.index,
                allocationVersion: write.querySet.allocationVersion,
                contentEpoch: write.contentEpoch,
            })
        }
        return Object.freeze({
            ...write,
            subject: freezeDiagnosticSubject(write.subject),
        } as SubmittedPotentialWrite)
    }))
}

function freezeExecutionOutcomes(outcomes: SubmissionExecutionOutcome[]): readonly SubmissionExecutionOutcome[] {

    return Object.freeze(outcomes.map((outcome) => {
        if (outcome.outcomeKind === 'pass') {
            return Object.freeze({
                ...outcome,
                requestedCommandIds: Object.freeze([ ...outcome.requestedCommandIds ]),
                encodedCommandIds: Object.freeze([ ...outcome.encodedCommandIds ]),
            } as SubmissionPassExecutionOutcome)
        }

        const attempts = outcome.attempts.map((attempt) => Object.freeze({
            ...attempt,
            missing: Object.freeze(attempt.missing.map((missing) => Object.freeze({
                ...missing,
                subject: freezeDiagnosticSubject(missing.subject),
            } as SubmissionMissingResource))),
        } as SubmissionCommandReadinessAttempt))

        return Object.freeze({
            ...outcome,
            attempts: Object.freeze(attempts),
        } as SubmissionCommandExecutionOutcome)
    }))
}

function freezeSubmittedDiagnosticReport(report: ScratchDiagnosticReport): ScratchDiagnosticReport {

    const diagnostics = Object.freeze(report.diagnostics.map(diagnostic =>
        cloneAndFreezeSubmittedDiagnosticValue(diagnostic) as ScratchDiagnostic
    )) as ScratchDiagnostic[]

    return Object.freeze({
        ...report,
        diagnostics,
    })
}

function cloneAndFreezeSubmittedDiagnosticValue(
    value: unknown,
    ancestors = new Set<object>()
): unknown {

    if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint'
    ) return value
    if (typeof value === 'symbol' || typeof value === 'function') return String(value)
    if (ancestors.has(value)) return '[Circular]'

    const nextAncestors = new Set(ancestors)
    nextAncestors.add(value)
    if (Array.isArray(value)) {
        return Object.freeze(value.map(item =>
            cloneAndFreezeSubmittedDiagnosticValue(item, nextAncestors)
        ))
    }

    const snapshot: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
        try {
            snapshot[key] = cloneAndFreezeSubmittedDiagnosticValue(
                (value as Record<string, unknown>)[key],
                nextAncestors
            )
        } catch {
            snapshot[key] = '[Unavailable]'
        }
    }
    return Object.freeze(snapshot)
}

function freezeDiagnosticSubject(subject: DiagnosticSubject): DiagnosticSubject {

    return Object.freeze({ ...subject }) as DiagnosticSubject
}

function validateRenderStep(builder: SubmissionBuilder, step: RenderStep) {

    const passSpec = step.passSpec

    if (!passSpec || typeof passSpec.assertRuntime !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission render step requires a PassSpec.',
            expected: { passSpec: 'RenderPassSpec' },
            actual: { passSpec: passSpec === undefined || passSpec === null ? String(passSpec) : typeof passSpec },
        })
    }

    passSpec.assertRuntime(builder.runtime)

    if (passSpec.passKind !== 'render') {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
            severity: 'error',
            phase: 'command',
            subject: step.commands[0]?.subject ?? builder.subject,
            related: [ passSpec.subject ].filter(Boolean),
            message: 'Render submission step requires a render pass.',
            expected: { passKind: 'render' },
            actual: { passKind: passSpec.passKind },
        })
    }

    validateRenderPassAttachments(passSpec)

    for (const command of step.commands) {
        if (!isRenderCommand(command)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
                severity: 'error',
                phase: 'submission',
                subject: builder.subject,
                message: 'Submission render step requires render commands.',
                expected: { command: 'DrawCommand, BeginOcclusionQueryCommand, or EndOcclusionQueryCommand' },
                actual: { command: command === undefined || command === null ? String(command) : typeof command },
            })
        }

        command.assertRuntime(builder.runtime)
        command.validateForPass(passSpec)
        if (command.commandKind === 'draw') {
            validatePipelineTargets(command, passSpec)
        }
    }

    validateRenderOcclusionQueryOrder(builder, step)
}

function validateComputeStep(builder: SubmissionBuilder, step: ComputeStep) {

    const passSpec = step.passSpec

    if (!passSpec || typeof passSpec.assertRuntime !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission compute step requires a PassSpec.',
            expected: { passSpec: 'ComputePassSpec' },
            actual: { passSpec: passSpec === undefined || passSpec === null ? String(passSpec) : typeof passSpec },
        })
    }

    passSpec.assertRuntime(builder.runtime)

    if (passSpec.passKind !== 'compute') {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
            severity: 'error',
            phase: 'command',
            subject: step.commands[0]?.subject ?? builder.subject,
            related: [ passSpec.subject ].filter(Boolean),
            message: 'Compute submission step requires a compute pass.',
            expected: { passKind: 'compute' },
            actual: { passKind: passSpec.passKind },
        })
    }

    for (const command of step.commands) {
        command.assertRuntime(builder.runtime)
        command.validateForPass(passSpec)
    }
}

function collectRenderPassResourceConflictDiagnostics(
    builder: SubmissionBuilder,
    requestedStep: RenderStep,
    resolvedStep: RenderStep,
    stepIndex: number,
    commandOutcomes: readonly SubmissionCommandExecutionOutcome[]
): ScratchDiagnostic[] {

    const diagnostics: ScratchDiagnostic[] = []
    const attachmentTargets = collectRenderAttachmentTargets(resolvedStep.passSpec)
    if (attachmentTargets.size === 0) return diagnostics

    const requestedCommands = new Map<string, DrawCommand>()
    for (const command of requestedStep.commands) {
        if (command.commandKind === 'draw') requestedCommands.set(command.id, command)
    }
    const executedOutcomes = commandOutcomes.filter(outcome => outcome.executedCommandId !== undefined)
    let executedOutcomeIndex = 0

    for (const command of resolvedStep.commands) {
        if (command.commandKind !== 'draw') continue

        const candidateOutcome = executedOutcomes[executedOutcomeIndex++]
        const outcome = candidateOutcome?.executedCommandId === command.id ? candidateOutcome : undefined
        const requestedCommand = outcome === undefined
            ? undefined
            : requestedCommands.get(outcome.requestedCommandId)

        collectRenderCommandResourceConflictDiagnostics(
            builder,
            resolvedStep,
            stepIndex,
            command,
            attachmentTargets,
            'read',
            diagnostics,
            outcome,
            requestedCommand
        )
        collectRenderCommandResourceConflictDiagnostics(
            builder,
            resolvedStep,
            stepIndex,
            command,
            attachmentTargets,
            'write',
            diagnostics,
            outcome,
            requestedCommand
        )
    }

    return diagnostics
}

function collectRenderCommandResourceConflictDiagnostics(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    command: DrawCommand,
    attachmentTargets: Map<TextureResource, RenderAttachmentKind>,
    access: SubmissionResourceAccessKind,
    diagnostics: ScratchDiagnostic[],
    outcome?: SubmissionCommandExecutionOutcome,
    requestedCommand?: DrawCommand
): void {

    const resources = access === 'read'
        ? command.resources.read.map(read => read.resource)
        : command.resources.write

    for (const resource of resources) {
        if (!(resource instanceof TextureResource)) continue

        const attachmentKind = attachmentTargets.get(resource)
        if (attachmentKind === undefined) continue

        const actual = {
            stepIndex,
            passId: step.passSpec.id,
            ...(attachmentKind === 'depth-stencil' ? {
                commandKind: command.commandKind,
                attachmentKind,
            } : {}),
            commandId: command.id,
            access,
            resourceId: resource.id,
            resourceKind: resource.resourceKind,
            contentEpoch: resource.contentEpoch,
            allocationVersion: resource.allocationVersion,
            ...(outcome !== undefined ? {
                requestedCommandId: outcome.requestedCommandId,
                attemptedCommandIds: outcome.attempts.map(attempt => attempt.commandId),
                attempts: snapshotReadinessAttempts(outcome.attempts),
            } : {}),
        }

        const commandSubjects = outcome !== undefined && requestedCommand !== undefined
            ? readinessAttemptCommandSubjects(requestedCommand, outcome.attempts)
            : [ command.subject ]

        diagnostics.push(createScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
            subject: command.subject,
            related: [
                ...commandSubjects,
                ...(outcome !== undefined ? readinessAttemptSubjects(outcome.attempts) : []),
                step.passSpec.subject,
                resource.subject,
                builder.subject,
            ],
            message: attachmentKind === 'depth-stencil'
                ? 'DrawCommand resources must not include the current render pass depth/stencil attachment target.'
                : 'DrawCommand resources must not include the current render pass color attachment target.',
            expected: attachmentKind === 'depth-stencil'
                ? {
                    attachment: 'pass-level write only',
                    drawResources: 'must exclude current render pass depth/stencil attachment target',
                }
                : {
                    attachment: 'pass-level write only',
                    drawResources: 'must exclude current render pass color attachment targets',
                },
            actual,
        }))
    }
}

function collectRenderAttachmentTargets(passSpec: RenderPassSpec): Map<TextureResource, RenderAttachmentKind> {

    const attachmentTargets = new Map<TextureResource, RenderAttachmentKind>()
    for (const attachment of passSpec.color) {
        const target = attachment.target
        if (target instanceof TextureResource) attachmentTargets.set(target, 'color')
    }

    if (passSpec.depth !== undefined && !attachmentTargets.has(passSpec.depth.target)) {
        attachmentTargets.set(passSpec.depth.target, 'depth-stencil')
    }

    return attachmentTargets
}

function validatePipelineTargets(command: DrawCommand, passSpec: RenderPassSpec) {

    const targetFormats = command.pipeline.targetFormats
    if (targetFormats.length !== passSpec.color.length) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [
                command.subject,
                passSpec.subject,
            ],
            message: 'RenderPipeline color target count does not match RenderPassSpec attachment count.',
            expected: { targetCount: passSpec.color.length },
            actual: { targetCount: targetFormats.length },
        })
    }

    for (let index = 0; index < passSpec.color.length; index++) {
        const expected = passSpec.color[index]?.format
        const actual = targetFormats[index]

        if (expected !== actual) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [
                    command.subject,
                    passSpec.subject,
                ],
                message: 'RenderPipeline target format does not match RenderPassSpec attachment format.',
                expected: { format: expected },
                actual: { format: actual },
            })
        }
    }

    validatePipelineDepthStencil(command, passSpec)
}

function validatePipelineDepthStencil(command: DrawCommand, passSpec: RenderPassSpec) {

    const pipelineDepthStencil = command.pipeline.depthStencil
    if (pipelineDepthStencil === undefined) return

    const pipelineFormat = pipelineDepthStencil.format
    const passFormat = passSpec.depth?.target.format

    if (passFormat === undefined) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [
                command.subject,
                passSpec.subject,
            ],
            message: 'RenderPipeline depthStencil state requires a matching RenderPassSpec depth/stencil attachment.',
            expected: { depthStencilAttachment: 'RenderPassSpec.depth with matching format' },
            actual: {
                pipelineDepthStencilFormat: pipelineFormat,
                passDepthStencilFormat: passFormat,
            },
        })
    }

    if (pipelineFormat !== passFormat) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: command.pipeline.subject,
            related: [
                command.subject,
                passSpec.subject,
                passSpec.depth?.target.subject,
            ].filter(isDefined),
            message: 'RenderPipeline depthStencil format does not match RenderPassSpec depth/stencil attachment format.',
            expected: { format: passFormat },
            actual: { format: pipelineFormat },
        })
    }
}

function validateRenderOcclusionQueryOrder(builder: SubmissionBuilder, step: RenderStep) {

    const passSpec = step.passSpec
    const writtenIndices = new Set<number>()
    let activeCommand: BeginOcclusionQueryCommand | undefined

    for (const command of step.commands) {
        if (command.commandKind === 'begin-occlusion-query') {
            if (passSpec.occlusionQuerySet === undefined) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'missingPassQuerySet')
            }

            if (command.querySet !== passSpec.occlusionQuerySet) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'querySetMismatch')
            }

            if (activeCommand !== undefined) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'nestedBegin', activeCommand)
            }

            if (writtenIndices.has(command.index)) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'queryIndexAlreadyWritten')
            }

            activeCommand = command
            continue
        }

        if (command.commandKind !== 'end-occlusion-query') continue

        if (activeCommand === undefined) {
            throwOcclusionQueryStateDiagnostic(builder, step, command, 'endWithoutBegin')
        }

        writtenIndices.add(activeCommand!.index)
        activeCommand = undefined
    }

    if (activeCommand !== undefined) {
        throwOcclusionQueryStateDiagnostic(builder, step, activeCommand, 'unclosedBegin', activeCommand)
    }
}

function isRenderCommand(command: unknown): command is RenderCommand {

    if (!isRecord(command)) return false

    return Boolean(
        typeof command.assertRuntime === 'function' &&
        typeof command.validateForPass === 'function' &&
        new Set([ 'draw', 'begin-occlusion-query', 'end-occlusion-query' ]).has(String(command.commandKind))
    )
}

function throwOcclusionQueryStateDiagnostic(
    builder: SubmissionBuilder,
    step: RenderStep,
    command: unknown,
    reason: string,
    activeCommand?: BeginOcclusionQueryCommand
) {

    const commandRecord = isRecord(command) ? command : {}
    const querySet = commandRecord.querySet

    throwScratchDiagnostic({
        code: 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: diagnosticSubjectOf(command) ?? builder.subject,
        related: [
            builder.subject,
            step.passSpec?.subject,
            diagnosticSubjectOf(querySet),
            step.passSpec?.occlusionQuerySet?.subject,
            activeCommand?.subject,
        ].filter(isDefined),
        message: 'Render submission occlusion query commands must form non-nested begin/end pairs against the pass occlusionQuerySet.',
        expected: {
            pass: 'RenderPassSpec with matching occlusionQuerySet',
            commands: 'begin/end pairs in explicit order with one active query at a time',
        },
        actual: {
            reason,
            commandKind: commandRecord.commandKind,
            queryIndex: commandRecord.index,
            hasPassQuerySet: step.passSpec?.occlusionQuerySet !== undefined,
            passQuerySetId: step.passSpec?.occlusionQuerySet?.id,
            commandQuerySetId: isRecord(querySet) ? querySet.id : undefined,
            activeQueryIndex: activeCommand?.index,
        },
    })
}

function advanceRenderAttachmentEpochs(passSpec: RenderPassSpec) {

    const writtenTargets = new Set<TextureResource>()

    for (const attachment of passSpec.color) {
        const target = attachment.target
        if (!(target instanceof TextureResource) || writtenTargets.has(target)) continue

        advanceResourceContentEpoch(target)
        writtenTargets.add(target)
    }

    if (passSpec.depth !== undefined && !writtenTargets.has(passSpec.depth.target)) {
        advanceResourceContentEpoch(passSpec.depth.target)
        writtenTargets.add(passSpec.depth.target)
    }
}

function captureResourceContentSnapshot(
    snapshots: Map<Resource, ResourceContentSnapshot>,
    resource: Resource
): void {

    if (snapshots.has(resource)) return

    snapshots.set(resource, {
        state: resource.state,
        contentEpoch: resource.contentEpoch,
    })
}

function captureQuerySlotContentSnapshot(
    snapshots: Map<QuerySetResource, Map<number, QuerySlotContentSnapshot>>,
    querySet: QuerySetResource,
    index: number
): void {

    let slots = snapshots.get(querySet)
    if (slots === undefined) {
        slots = new Map()
        snapshots.set(querySet, slots)
    }
    if (slots.has(index)) return

    slots.set(index, {
        state: querySet.slotStates[index],
        contentEpoch: querySet.slotContentEpochs[index],
    })
}

function createPreparedResourceContentEffect(resource: Resource): PreparedResourceContentEffect {

    return {
        kind: 'resource-content',
        resource,
        state: resource.state,
        contentEpoch: resource.contentEpoch,
    }
}

function createPreparedQueueEffects(
    resources: ReadonlySet<Resource>,
    querySlots: ReadonlyMap<QuerySetResource, ReadonlySet<number>>
): PreparedQueueEffect[] {

    const effects: PreparedQueueEffect[] = []
    for (const resource of resources) {
        effects.push(createPreparedResourceContentEffect(resource))
    }
    for (const [querySet, indices] of querySlots) {
        for (const index of indices) {
            effects.push({
                kind: 'query-slot-content',
                querySet,
                index,
                state: querySet.slotStates[index],
                contentEpoch: querySet.slotContentEpochs[index],
            })
        }
    }

    return effects
}

function restorePreparedContentState(
    resourceSnapshots: ReadonlyMap<Resource, ResourceContentSnapshot>,
    querySlotSnapshots: ReadonlyMap<QuerySetResource, ReadonlyMap<number, QuerySlotContentSnapshot>>
): void {

    for (const [resource, snapshot] of resourceSnapshots) {
        setResourceContentState(resource, snapshot.state, snapshot.contentEpoch)
    }
    for (const [querySet, slots] of querySlotSnapshots) {
        for (const [index, snapshot] of slots) {
            querySet.slotStates[index] = snapshot.state
            querySet.slotContentEpochs[index] = snapshot.contentEpoch
        }
    }
}

function applyPreparedQueueEffects(effects: readonly PreparedQueueEffect[]): void {

    for (const effect of effects) {
        if (effect.kind === 'resource-content') {
            setResourceContentState(effect.resource, effect.state, effect.contentEpoch)
            continue
        }

        effect.querySet.slotStates[effect.index] = effect.state
        effect.querySet.slotContentEpochs[effect.index] = effect.contentEpoch
    }
}

function snapshotSubmissionPotentialWrites(
    queueTimeline: readonly PreparedQueueAction[]
): readonly SubmissionPotentialWrite[] {

    const resourceWrites = new Map<Resource, SubmissionPotentialWrite & { kind: 'resource' }>()
    const querySlotWrites = new Map<string, SubmissionPotentialWrite & { kind: 'query-slot' }>()
    for (const action of queueTimeline) {
        for (const effect of action.effects) {
            if (effect.kind === 'resource-content') {
                resourceWrites.set(effect.resource, Object.freeze({
                    kind: 'resource',
                    resource: effect.resource,
                    allocationVersion: effect.resource.allocationVersion,
                    contentEpoch: effect.contentEpoch,
                }))
                continue
            }
            querySlotWrites.set(querySlotKey(effect.querySet, effect.index), Object.freeze({
                kind: 'query-slot',
                querySet: effect.querySet,
                index: effect.index,
                contentEpoch: effect.contentEpoch,
            }))
        }
    }

    return Object.freeze([
        ...resourceWrites.values(),
        ...querySlotWrites.values(),
    ])
}

function observeSubmissionPotentialWriteFailures(
    nativeSettlement: Promise<SubmissionNativeSettlement>,
    queueCompletion: Promise<SubmissionQueueCompletionOutcome>,
    lifecycle: Promise<SubmissionLifecycleOutcome>,
    potentialWrites: readonly SubmissionPotentialWrite[]
): void {

    observeSubmissionPotentialWriteNativeFailures(nativeSettlement, potentialWrites)
    void queueCompletion.then(completion => {
        if (completion.status === 'failed') {
            markSubmissionPotentialWritesIndeterminate(potentialWrites)
        }
    })
    void lifecycle.then(outcome => {
        if (outcome.status === 'failed') {
            markSubmissionPotentialWritesIndeterminate(potentialWrites)
        }
    })
}

function observeSubmissionPotentialWriteNativeFailures(
    nativeSettlement: Promise<SubmissionNativeSettlement>,
    potentialWrites: readonly SubmissionPotentialWrite[]
): void {

    void nativeSettlement.then(settlement => {
        if (settlement.primaryFailure !== undefined) {
            markSubmissionPotentialWritesIndeterminate(potentialWrites)
        }
    })
}

function markSubmissionPotentialWritesIndeterminate(
    potentialWrites: readonly SubmissionPotentialWrite[]
): void {

    for (const write of potentialWrites) {
        if (write.kind === 'resource') {
            if (
                write.resource.isDisposed ||
                write.resource.allocationVersion !== write.allocationVersion ||
                write.resource.contentEpoch !== write.contentEpoch ||
                write.resource.state === 'indeterminate'
            ) continue
            setResourceContentState(write.resource, 'indeterminate', write.contentEpoch)
            continue
        }
        if (
            write.querySet.isDisposed ||
            write.querySet.slotContentEpochs[write.index] !== write.contentEpoch ||
            write.querySet.slotStates[write.index] === 'indeterminate'
        ) continue
        setQuerySlotContentState(
            write.querySet,
            write.index,
            'indeterminate',
            write.contentEpoch
        )
    }
}

function createDonePromise(queue: GPUQueue): Promise<unknown> {

    if (queue && typeof queue.onSubmittedWorkDone === 'function') {
        return queue.onSubmittedWorkDone()
    }

    return Promise.resolve()
}

function createSubmittedWorkDone(
    runtime: ScratchRuntime,
    submissionId: string,
    nativeDone: Promise<unknown>,
    nativeSettlement: Promise<SubmissionNativeSettlement>,
    readbacks: readonly SubmittedReadbackLink[],
    potentialWrites: readonly SubmissionPotentialWrite[],
    reservation?: ScratchEffectfulSubmittedWorkReservation
): Promise<unknown> {

    const queueCompletion = observeSubmissionQueueCompletion(
        runtime,
        submissionId,
        nativeDone,
        readbacks
    )
    const lifecycle = reservation === undefined
        ? Promise.resolve(Object.freeze({ status: 'succeeded' as const }))
        : observeSubmissionLifecycleUntilQueueCompletion(
            runtime,
            submissionId,
            queueCompletion
        )
    observeSubmissionPotentialWriteFailures(
        nativeSettlement,
        queueCompletion,
        lifecycle,
        potentialWrites
    )
    const done = Promise.all([
        nativeSettlement,
        queueCompletion,
        lifecycle,
    ]).then(([ settlement, completion, lifecycleOutcome ]) => {
        const completedLifecycle = completeSubmissionLifecycleOutcome(
            runtime,
            submissionId,
            readbacks,
            settlement,
            lifecycleOutcome
        )
        const primary = selectSubmissionDoneFailure(
            submissionId,
            settlement,
            completion,
            completedLifecycle
        )
        if (primary === undefined) return

        throwScratchDiagnostic({
            code: primary.diagnosticCode,
            severity: 'error',
            phase: 'submission',
            subject: { kind: 'Submission', id: submissionId },
            related: [
                runtime.subject,
                ...readbacks.flatMap(link => [
                    { kind: 'Command', id: link.commandId, commandKind: 'readback' },
                    { kind: 'ReadbackOperation', id: link.operationId },
                    { kind: 'Resource', id: link.sourceResourceId },
                ]),
            ],
            message: primary.stage === 'queue-completion'
                ? 'Submitted queue work did not complete successfully.'
                : primary.stage === 'lifecycle-recheck'
                    ? 'Submitted work lost its runtime or device lifecycle before queue completion.'
                    : 'Submitted work produced a captured native failure.',
            actual: {
                submissionId,
                primary: {
                    stage: primary.stage,
                    nativeErrorCategory: primary.nativeErrorCategory,
                    ...(primary.location !== undefined ? { location: primary.location } : {}),
                    ...(primary.nativeError !== undefined ? { nativeError: primary.nativeError } : {}),
                },
                nativeOutcome: settlement.outcome,
                ...(completion.status === 'failed'
                    ? { queueCompletionError: serializeNativeGpuError(completion.cause) }
                    : {}),
                ...(completedLifecycle.status === 'failed'
                    ? { lifecycleOutcome: completedLifecycle.fact }
                    : {}),
            },
        }, {
            ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
            ...(primary.incident !== undefined ? { incident: primary.incident } : {}),
        })
    })

    void done.catch(() => {})
    if (reservation !== undefined) {
        void done.then(
            () => reservation.release(),
            () => reservation.release()
        )
    }
    return done
}

type SubmissionQueueCompletionOutcome =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{
        status: 'failed'
        cause: unknown
        incident: ScratchGpuIncidentReport
    }>

type SubmissionLifecycleOutcome =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{
        status: 'failed'
        fact: Readonly<{
            stage: 'lifecycle-recheck'
            diagnosticCode: string
            nativeErrorCategory: 'device-lost' | 'none'
            location: ScratchSubmissionNativeLocation
            nativeError?: ReturnType<typeof serializeNativeGpuError>
        }>
        cause?: unknown
        incident?: ScratchGpuIncidentReport
    }>

type SubmissionDoneFailure = Readonly<{
    stage: ScratchSubmissionNativeStage
    diagnosticCode: string
    nativeErrorCategory: GpuNativeErrorCategory
    location?: ScratchSubmissionNativeLocation
    nativeError?: ReturnType<typeof serializeNativeGpuError>
    cause?: unknown
    incident?: ScratchGpuIncidentReport
}>

function observeSubmissionQueueCompletion(
    runtime: ScratchRuntime,
    submissionId: string,
    nativeDone: Promise<unknown>,
    readbacks: readonly SubmittedReadbackLink[]
): Promise<SubmissionQueueCompletionOutcome> {

    return Promise.resolve(nativeDone).then(
        () => Object.freeze({ status: 'succeeded' as const }),
        (cause: unknown) => {
            recordReadbackQueueCompletionIncidents(runtime, submissionId, readbacks, cause)
            const incident = recordSubmissionQueueCompletionIncident(runtime, submissionId, readbacks, cause)
            return Object.freeze({ status: 'failed' as const, cause, incident })
        }
    )
}

function observeSubmissionLifecycleUntilQueueCompletion(
    runtime: ScratchRuntime,
    submissionId: string,
    queueCompletion: Promise<SubmissionQueueCompletionOutcome>
): Promise<SubmissionLifecycleOutcome> {

    let isSettled = false
    let unsubscribe = () => {}
    let resolveOutcome!: (outcome: SubmissionLifecycleOutcome) => void
    const outcome = new Promise<SubmissionLifecycleOutcome>(resolve => {
        resolveOutcome = resolve
    })
    const complete = (value: SubmissionLifecycleOutcome) => {

        if (isSettled) return
        isSettled = true
        unsubscribe()
        resolveOutcome(value)
    }
    unsubscribe = diagnosticsControllerFor(runtime).subscribeLifecycle(change => {
        complete(createSubmissionLifecycleFailure(runtime, submissionId, change))
    })
    if (isSettled) unsubscribe()
    void queueCompletion.then(() => complete(Object.freeze({ status: 'succeeded' as const })))
    return outcome
}

function createSubmissionLifecycleFailure(
    runtime: ScratchRuntime,
    submissionId: string,
    change: ScratchRuntimeLifecycleChange
): SubmissionLifecycleOutcome & Readonly<{ status: 'failed' }> {

    const deviceLost = change.kind === 'device-lost'
    const diagnosticCode = deviceLost
        ? 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
        : 'SCRATCH_RUNTIME_DISPOSED'
    const nativeErrorCategory = deviceLost ? 'device-lost' as const : 'none' as const
    const location = Object.freeze({ kind: 'submission' as const, submissionId })
    const nativeError = deviceLost
        ? serializeNativeGpuError(runtime.deviceLostInfo ?? change.info)
        : undefined
    const fact = Object.freeze({
        stage: 'lifecycle-recheck' as const,
        diagnosticCode,
        nativeErrorCategory,
        location,
        ...(nativeError !== undefined ? { nativeError } : {}),
    })
    return Object.freeze({
        status: 'failed' as const,
        fact,
        ...(deviceLost ? { cause: change.info } : {}),
    })
}

function completeSubmissionLifecycleOutcome(
    runtime: ScratchRuntime,
    submissionId: string,
    readbacks: readonly SubmittedReadbackLink[],
    settlement: SubmissionNativeSettlement,
    lifecycle: SubmissionLifecycleOutcome
): SubmissionLifecycleOutcome {

    if (lifecycle.status === 'succeeded') return lifecycle
    const alreadyObserved = settlement.outcome.outcomes.some(outcome =>
        outcome.stage === lifecycle.fact.stage &&
        outcome.nativeErrorCategory === lifecycle.fact.nativeErrorCategory
    )
    if (alreadyObserved) return lifecycle

    const incident = diagnosticsControllerFor(runtime).recordIncident({
        kind: 'submission-failure',
        diagnosticCode: lifecycle.fact.diagnosticCode,
        nativeErrorCategory: lifecycle.fact.nativeErrorCategory,
        attribution: 'temporal-correlation',
        target: { kind: 'submission', submissionId },
        related: [
            runtime.subject,
            ...readbacks.flatMap(link => [
                { kind: 'Command' as const, id: link.commandId, commandKind: 'readback' },
                { kind: 'ReadbackOperation' as const, id: link.operationId },
                { kind: 'Resource' as const, id: link.sourceResourceId },
            ]),
        ],
        failureStage: 'lifecycle-recheck',
        ...(lifecycle.fact.nativeError !== undefined
            ? { nativeError: lifecycle.fact.nativeError }
            : {}),
        outcomes: [ lifecycle.fact ],
    })
    return Object.freeze({
        ...lifecycle,
        incident,
    })
}

function selectSubmissionDoneFailure(
    submissionId: string,
    settlement: SubmissionNativeSettlement,
    completion: SubmissionQueueCompletionOutcome,
    lifecycle: SubmissionLifecycleOutcome
): SubmissionDoneFailure | undefined {

    const primary = settlement.primaryFailure
    const nativeFailure: SubmissionDoneFailure | undefined = primary === undefined
        ? undefined
        : {
            stage: primary.fact.stage,
            diagnosticCode: primary.fact.diagnosticCode,
            nativeErrorCategory: primary.fact.nativeErrorCategory,
            location: primary.fact.location,
            ...(primary.fact.nativeError !== undefined
                ? { nativeError: primary.fact.nativeError }
                : {}),
            ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
            ...(primary.incident !== undefined ? { incident: primary.incident } : {}),
        }
    let queueFailure: SubmissionDoneFailure | undefined
    if (completion.status === 'failed') {
        queueFailure = {
            stage: 'queue-completion',
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            nativeErrorCategory: 'native-exception',
            location: Object.freeze({ kind: 'submission', submissionId }),
            nativeError: serializeNativeGpuError(completion.cause),
            cause: completion.cause,
            incident: completion.incident,
        }
    }

    const lifecycleFailure: SubmissionDoneFailure | undefined = lifecycle.status === 'failed'
        ? {
            stage: lifecycle.fact.stage,
            diagnosticCode: lifecycle.fact.diagnosticCode,
            nativeErrorCategory: lifecycle.fact.nativeErrorCategory,
            location: lifecycle.fact.location,
            ...(lifecycle.fact.nativeError !== undefined
                ? { nativeError: lifecycle.fact.nativeError }
                : {}),
            ...(lifecycle.cause !== undefined ? { cause: lifecycle.cause } : {}),
            ...(lifecycle.incident !== undefined ? { incident: lifecycle.incident } : {}),
        }
        : undefined

    const failures = [ nativeFailure, queueFailure, lifecycleFailure ]
        .filter((failure): failure is SubmissionDoneFailure => failure !== undefined)
        .sort((left, right) => compareSubmissionNativeStages(left.stage, right.stage))
    return failures[0]
}

function recordSubmissionQueueCompletionIncident(
    runtime: ScratchRuntime,
    submissionId: string,
    readbacks: readonly SubmittedReadbackLink[],
    cause: unknown
): ScratchGpuIncidentReport {

    const nativeError = serializeNativeGpuError(cause)
    return diagnosticsControllerFor(runtime).recordIncident({
        kind: 'submission-failure',
        diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
        nativeErrorCategory: 'native-exception',
        attribution: 'enclosing-operation-family',
        target: { kind: 'submission', submissionId },
        related: [
            runtime.subject,
            ...readbacks.flatMap(link => [
                { kind: 'Command', id: link.commandId, commandKind: 'readback' },
                { kind: 'ReadbackOperation', id: link.operationId },
                { kind: 'Resource', id: link.sourceResourceId },
            ]),
        ],
        nativeError,
        failureStage: 'queue-completion',
        outcomes: [ Object.freeze({
            stage: 'queue-completion' as const,
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            nativeErrorCategory: 'native-exception' as const,
            location: Object.freeze({ kind: 'submission' as const, submissionId }),
            nativeError,
        }) ],
    })
}

function recordReadbackQueueCompletionIncidents(
    runtime: ScratchRuntime,
    submissionId: string,
    readbacks: readonly SubmittedReadbackLink[],
    cause: unknown
) {

    const controller = diagnosticsControllerFor(runtime)
    const nativeError = serializeNativeGpuError(cause)
    return readbacks.map(link => controller.recordIncident({
        kind: 'readback-failure',
        diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
        nativeErrorCategory: 'native-exception',
        attribution: 'enclosing-operation-family',
        target: {
            kind: 'command',
            commandId: link.commandId,
            commandKind: 'readback',
        },
        related: [
            runtime.subject,
            { kind: 'Submission', id: submissionId },
            { kind: 'ReadbackOperation', id: link.operationId },
            { kind: 'Resource', id: link.sourceResourceId },
        ],
        nativeError,
        failureStage: 'queue-completion',
        outcomes: [ Object.freeze({
            stage: 'queue-completion' as const,
            diagnosticCode: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            nativeErrorCategory: 'native-exception' as const,
            nativeError,
        }) ],
    }))
}

function releaseFailedSubmissionReadbacks(
    queue: GPUQueue,
    pendingReadbacks: readonly PendingReadback[],
    submittedReadbacks: ReadonlySet<PendingReadback>,
    barrierFailure?: unknown
): void {

    let done: Promise<unknown> | undefined
    for (const pending of pendingReadbacks) {
        if (!submittedReadbacks.has(pending)) {
            releaseReadbackCommandClaim(pending.claim, { unmap: false, gpuUseComplete: true })
            continue
        }
        if (done === undefined) {
            if (barrierFailure !== undefined) done = Promise.reject(barrierFailure)
            else {
                try {
                    done = createDonePromise(queue)
                } catch (cause) {
                    done = Promise.reject(cause)
                }
            }
        }
        markReadbackCommandClaimSubmitted(pending.claim, done)
        releaseReadbackCommandClaim(pending.claim, { unmap: false, gpuUseComplete: false })
    }
}

function releaseUnsubmittedReadbackClaims(claims: Iterable<ReadbackCommandClaim>): void {

    for (const claim of claims) {
        releaseReadbackCommandClaim(claim, { unmap: false, gpuUseComplete: true })
    }
}
