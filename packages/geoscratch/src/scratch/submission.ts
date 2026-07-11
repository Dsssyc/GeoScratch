import { UUID } from '../core/utils/uuid.js'
import {
    commitUploadCommandLogicalWrite,
    registerReadbackCommandResult,
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
import { createScheduledReadbackOperation } from './readback.js'
import { TextureResource } from './texture.js'
import { diagnosticSubjectOf, isDefined, isRecord } from './type-utils.js'
import type { BeginOcclusionQueryCommand, CommandResourceReadDescriptor, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, ExternalImageUploadCommand, QuerySetSlotReadDescriptor, ReadbackCommand, ResolveQuerySetCommand, ResourceReadinessPolicy, TextureUploadCommand, UploadCommand } from './command.js'
import type { DiagnosticSubject, ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { QuerySetResource, QuerySetSlotState } from './query-set.js'
import type { Resource, ResourceState } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

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
    stagingBuffer: GPUBuffer
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
        const commandBuffers: GPUCommandBuffer[] = []
        const queueTimeline: PreparedQueueAction[] = []
        const resourceAccesses: SubmissionResourceAccess[] = []
        const pendingReadbacks: PendingReadback[] = []
        const commandBufferReadbacks = new Map<GPUCommandBuffer, PendingReadback[]>()
        const resourceSnapshots = new Map<Resource, ResourceContentSnapshot>()
        const querySlotSnapshots = new Map<QuerySetResource, Map<number, QuerySlotContentSnapshot>>()
        let encoder: GPUCommandEncoder | undefined
        let encoderSegmentIndex = 0
        let segmentResources = new Set<Resource>()
        let segmentQuerySlots = new Map<QuerySetResource, Set<number>>()
        let segmentReadbacks: PendingReadback[] = []

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
                encoder = this.runtime.device.createCommandEncoder({
                    label: encoderSegmentIndex === 0
                        ? submittedId
                        : `${submittedId}:segment-${encoderSegmentIndex}`,
                })
                encoderSegmentIndex++
            }

            return encoder
        }

        const finishEncoderSegment = () => {

            if (encoder === undefined) return

            const commandBuffer = encoder.finish()
            commandBuffers.push(commandBuffer)
            queueTimeline.push({
                kind: 'command-buffer',
                commandBuffer,
                effects: createPreparedQueueEffects(segmentResources, segmentQuerySlots),
            })
            commandBufferReadbacks.set(commandBuffer, segmentReadbacks)
            encoder = undefined
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
                    step.command.encode(encoder)
                    completeResourceAccesses(resourceAccesses, accesses)
                    continue
                }

                if (step.kind === 'readback') {
                    const encoder = getEncoder()
                    const origin = commandAccessOrigin(stepIndex, 'readback', step.command)
                    const readAccess = captureResourceAccess(step.command.source.resource, 'read', origin)
                    const pendingReadback = {
                        command: step.command,
                        stagingBuffer: step.command.encode(encoder),
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
                    step.command.encode(encoder)
                    completeResourceAccesses(resourceAccesses, writes)
                    continue
                }

                if (step.kind === 'compute') {
                    if (step.disposition === 'skip-pass') continue
                    if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                    const encoder = getEncoder()
                    const passEncoder = encoder.beginComputePass(step.passSpec.createComputePassDescriptor())
                    for (const command of step.commands) {
                        const origin = commandAccessOrigin(stepIndex, 'compute', command, step.passSpec)
                        const declaredWrites = command._producesDeclaredWrites ? command.resources.write : []
                        for (const resource of declaredWrites) trackSegmentResourceWrite(resource)
                        const accesses = [
                            ...command.resources.read.map(read => captureResourceAccess(read.resource, 'read', origin)),
                            ...declaredWrites.map(resource => captureResourceAccess(resource, 'write', origin)),
                        ]
                        command.encode(passEncoder)
                        completeResourceAccesses(resourceAccesses, accesses)
                    }
                    passEncoder.end()
                    trackTimestampWrites(step.passSpec)
                    step.passSpec.advanceTimestampWriteEpochs()
                    continue
                }

                if (step.disposition === 'skip-pass') continue
                if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                const encoder = getEncoder()
                const colorWrites = captureRenderAttachmentWrites(stepIndex, step.passSpec)
                const passEncoder = encoder.beginRenderPass(step.passSpec.createRenderPassDescriptor())
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
                    command.encode(passEncoder)
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
                passEncoder.end()
                trackTimestampWrites(step.passSpec)
                step.passSpec.advanceTimestampWriteEpochs()
                for (const write of colorWrites) trackSegmentResourceWrite(write.resource)
                advanceRenderAttachmentEpochs(step.passSpec)
                completeResourceAccesses(resourceAccesses, colorWrites)
            }

            finishEncoderSegment()
        } finally {
            restorePreparedContentState(resourceSnapshots, querySlotSnapshots)
        }
        this.isSubmitted = true
        const submittedReadbacks = new Set<PendingReadback>()
        try {
            for (const action of queueTimeline) {
                switch (action.kind) {
                    case 'command-buffer':
                        this.runtime.queue.submit([ action.commandBuffer ])
                        for (const pending of commandBufferReadbacks.get(action.commandBuffer) ?? []) {
                            submittedReadbacks.add(pending)
                        }
                        break
                    case 'buffer-upload':
                    case 'texture-upload':
                    case 'external-image-upload':
                        writeUploadCommandQueueAction(action.command, this.runtime.queue)
                        break
                    default:
                        assertNeverPreparedQueueAction(action)
                }

                applyPreparedQueueEffects(action.effects)
            }
        } catch (cause) {
            releaseFailedSubmissionReadbacks(this.runtime.queue, pendingReadbacks, submittedReadbacks)
            throw cause
        }

        const submitted = new SubmittedWork(this.runtime, {
            id: submittedId,
            commandBuffers,
            report: resolvedPlan.report,
            resourceAccesses,
            executionOutcomes: resolvedPlan.executionOutcomes,
            done: queueTimeline.length === 0
                ? Promise.resolve()
                : createDonePromise(this.runtime.queue),
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
                stagingBuffer: pending.stagingBuffer,
                contentEpoch: pending.contentEpoch,
                allocationVersion: pending.allocationVersion,
            })
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

    runtime: ScratchRuntime
    id: string
    commandBuffers: GPUCommandBuffer[]
    report: ScratchDiagnosticReport
    diagnostics: ScratchDiagnostic[]
    resourceAccesses: readonly SubmissionResourceAccess[]
    producerEpochs: readonly SubmittedResourceEpoch[]
    readonly executionOutcomes: readonly SubmissionExecutionOutcome[]
    done: Promise<unknown>

    constructor(runtime: ScratchRuntime, options: {
        id?: string
        commandBuffers?: GPUCommandBuffer[]
        report?: ScratchDiagnosticReport
        resourceAccesses?: SubmissionResourceAccess[]
        executionOutcomes?: SubmissionExecutionOutcome[]
        done?: Promise<unknown>
    } = {}) {

        this.runtime = runtime
        this.id = options.id ?? `scratch-submitted-${UUID()}`
        this.commandBuffers = options.commandBuffers ?? []
        this.report = options.report ?? createScratchDiagnosticReport([])
        this.diagnostics = this.report.diagnostics
        this.resourceAccesses = freezeResourceAccesses(options.resourceAccesses ?? [])
        this.producerEpochs = freezeProducerEpochs(createProducerEpochs(this.resourceAccesses))
        this.executionOutcomes = freezeExecutionOutcomes(options.executionOutcomes ?? [])
        Object.defineProperty(this, 'executionOutcomes', {
            value: this.executionOutcomes,
            enumerable: true,
            configurable: false,
            writable: false,
        })
        this.done = options.done ?? Promise.resolve()
    }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

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

        target._advanceContentEpoch()
        writtenTargets.add(target)
    }

    if (passSpec.depth !== undefined && !writtenTargets.has(passSpec.depth.target)) {
        passSpec.depth.target._advanceContentEpoch()
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
        resource.state = snapshot.state
        resource.contentEpoch = snapshot.contentEpoch
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
            effect.resource.state = effect.state
            effect.resource.contentEpoch = effect.contentEpoch
            continue
        }

        effect.querySet.slotStates[effect.index] = effect.state
        effect.querySet.slotContentEpochs[effect.index] = effect.contentEpoch
    }
}

function createDonePromise(queue: GPUQueue): Promise<unknown> {

    if (queue && typeof queue.onSubmittedWorkDone === 'function') {
        return queue.onSubmittedWorkDone()
    }

    return Promise.resolve()
}

function releaseFailedSubmissionReadbacks(
    queue: GPUQueue,
    pendingReadbacks: readonly PendingReadback[],
    submittedReadbacks: ReadonlySet<PendingReadback>
): void {

    const submitted: PendingReadback[] = []
    for (const pending of pendingReadbacks) {
        if (submittedReadbacks.has(pending)) {
            submitted.push(pending)
        } else {
            destroyPendingReadbackStaging(pending)
        }
    }
    if (submitted.length === 0) return

    let done: Promise<unknown>
    try {
        done = createDonePromise(queue)
    } catch {
        for (const pending of submitted) destroyPendingReadbackStaging(pending)
        return
    }

    void done.then(
        () => {
            for (const pending of submitted) destroyPendingReadbackStaging(pending)
        },
        () => {
            for (const pending of submitted) destroyPendingReadbackStaging(pending)
        }
    )
}

function destroyPendingReadbackStaging(pending: PendingReadback): void {

    if (typeof pending.stagingBuffer.destroy !== 'function') return
    try {
        pending.stagingBuffer.destroy()
    } catch {}
}
