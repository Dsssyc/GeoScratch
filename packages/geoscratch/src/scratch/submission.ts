import { UUID } from '../core/utils/uuid.js'
import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    throwScratchDiagnostic,
} from './diagnostics.js'
import { TextureResource } from './texture.js'
import { diagnosticSubjectOf, isDefined, isRecord } from './type-utils.js'
import type { BeginOcclusionQueryCommand, CommandResourceReadDescriptor, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, QuerySetSlotReadDescriptor, ResolveQuerySetCommand, TextureUploadCommand, UploadCommand } from './command.js'
import type { DiagnosticSubject, ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { QuerySetResource, QuerySetSlotState } from './query-set.js'
import type { Resource, ResourceState } from './resource.js'
import type { ScratchRuntime } from './runtime.js'

export type SubmissionValidationMode = 'off' | 'warn' | 'throw'

export type SubmissionStepKind = 'upload' | 'copy' | 'resolve' | 'compute' | 'render'

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
    command: UploadCommand | TextureUploadCommand
}

type CopyStep = {
    kind: 'copy'
    command: CopyCommand
}

type ResolveStep = {
    kind: 'resolve'
    command: ResolveQuerySetCommand
}

type SubmissionStep = RenderStep | ComputeStep | UploadStep | CopyStep | ResolveStep

type ReadCommand = CopyCommand | DispatchCommand | DrawCommand

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

    upload(command: UploadCommand | TextureUploadCommand) {

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

        const validationReport = validateSubmissionBeforeEncoding(this)
        applySubmissionValidationDisposition(this, validationReport)

        const submittedId = `scratch-submitted-${UUID()}`
        const commandBuffers: GPUCommandBuffer[] = []
        const resourceAccesses: SubmissionResourceAccess[] = []
        const encoder = this.runtime.device.createCommandEncoder({
            label: submittedId,
        })

        for (const [stepIndex, step] of this.steps.entries()) {
            if (step.kind === 'upload') {
                const writes = [
                    captureResourceAccess(step.command.target, 'write', commandAccessOrigin(stepIndex, 'upload', step.command)),
                ]
                step.command.execute(this.runtime.queue)
                completeResourceAccesses(resourceAccesses, writes)
                continue
            }

            if (step.kind === 'copy') {
                const origin = commandAccessOrigin(stepIndex, 'copy', step.command)
                const accesses = [
                    captureResourceAccess(step.command.source.resource, 'read', origin),
                    captureResourceAccess(step.command.target, 'write', origin),
                ]
                step.command.encode(encoder)
                completeResourceAccesses(resourceAccesses, accesses)
                continue
            }

            if (step.kind === 'resolve') {
                const writes = [
                    captureResourceAccess(step.command.destination, 'write', commandAccessOrigin(stepIndex, 'resolve', step.command)),
                ]
                step.command.encode(encoder)
                completeResourceAccesses(resourceAccesses, writes)
                continue
            }

            if (step.kind === 'compute') {
                if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                const passEncoder = encoder.beginComputePass(step.passSpec.createComputePassDescriptor())
                for (const command of step.commands) {
                    const origin = commandAccessOrigin(stepIndex, 'compute', command, step.passSpec)
                    const accesses = [
                        ...command.resources.read.map(read => captureResourceAccess(read.resource, 'read', origin)),
                        ...command.resources.write.map(resource => captureResourceAccess(resource, 'write', origin)),
                    ]
                    command.encode(passEncoder)
                    completeResourceAccesses(resourceAccesses, accesses)
                }
                passEncoder.end()
                step.passSpec.advanceTimestampWriteEpochs()
                continue
            }

            if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

            const colorWrites = captureRenderAttachmentWrites(stepIndex, step.passSpec)
            const passEncoder = encoder.beginRenderPass(step.passSpec.createRenderPassDescriptor())
            let activeOcclusionQueryCommand: BeginOcclusionQueryCommand | undefined
            for (const command of step.commands) {
                const origin = commandAccessOrigin(stepIndex, 'render', command, step.passSpec)
                const accesses = command.commandKind === 'draw'
                    ? [
                        ...command.resources.read.map(read => captureResourceAccess(read.resource, 'read', origin)),
                        ...command.resources.write.map(resource => captureResourceAccess(resource, 'write', origin)),
                    ]
                    : []
                command.encode(passEncoder)
                if (command.commandKind === 'begin-occlusion-query') {
                    activeOcclusionQueryCommand = command
                } else if (command.commandKind === 'end-occlusion-query') {
                    activeOcclusionQueryCommand?.querySet._advanceSlotContentEpoch(activeOcclusionQueryCommand.index)
                    activeOcclusionQueryCommand = undefined
                }
                completeResourceAccesses(resourceAccesses, accesses)
            }
            passEncoder.end()
            step.passSpec.advanceTimestampWriteEpochs()
            advanceRenderAttachmentEpochs(step.passSpec)
            completeResourceAccesses(resourceAccesses, colorWrites)
        }

        const commandBuffer = encoder.finish()
        commandBuffers.push(commandBuffer)
        this.runtime.queue.submit(commandBuffers)
        this.isSubmitted = true

        return new SubmittedWork(this.runtime, {
            id: submittedId,
            commandBuffers,
            report: validationReport,
            resourceAccesses,
            done: createDonePromise(this.runtime.queue),
        })
    }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

function validateSubmissionBeforeEncoding(builder: SubmissionBuilder): ScratchDiagnosticReport {

    const diagnostics: ScratchDiagnostic[] = []
    const readiness: ReadinessSimulation = new Map()
    const querySlots: QuerySlotSimulation = new Map()

    for (const [stepIndex, step] of builder.steps.entries()) {
        if (step.kind === 'upload') {
            validateUploadStep(builder, step)
            markSimulatedReady(readiness, step.command.target)
            continue
        }

        if (step.kind === 'copy') {
            validateCopyStep(builder, step)
            validateCopyReadiness(builder, step, stepIndex, readiness, diagnostics)
            markSimulatedReady(readiness, step.command.target)
            continue
        }

        if (step.kind === 'resolve') {
            validateResolveStep(builder, step)
            validateResolveReadiness(builder, step, stepIndex, querySlots, diagnostics)
            markSimulatedReady(readiness, step.command.destination)
            continue
        }

        if (step.kind === 'compute') {
            validateComputeStep(builder, step)
            validateComputeReadiness(builder, step, stepIndex, readiness, diagnostics)
            markSimulatedTimestampWrites(querySlots, step.passSpec.timestampWrites)
            continue
        }

        validateRenderStep(builder, step)
        if (builder.validation !== 'off') {
            diagnostics.push(...collectRenderPassResourceConflictDiagnostics(builder, step, stepIndex))
        }
        validateRenderReadiness(builder, step, stepIndex, readiness, diagnostics)
        markSimulatedRenderQueryWrites(querySlots, step)
    }

    return createScratchDiagnosticReport(diagnostics)
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
            expected: { command: 'UploadCommand or TextureUploadCommand' },
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
}

function validateCopyReadiness(
    builder: SubmissionBuilder,
    step: CopyStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    validateCommandReadiness(builder, stepIndex, step.command, [ step.command.source ], readiness, diagnostics, undefined, 'source')
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

function validateComputeReadiness(
    builder: SubmissionBuilder,
    step: ComputeStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    for (const command of step.commands) {
        validateCommandReadiness(builder, stepIndex, command, command.resources.read, readiness, diagnostics, step.passSpec)
        for (const resource of command.resources.write) {
            markSimulatedReady(readiness, resource)
        }
    }
}

function validateRenderReadiness(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[]
): void {

    for (const command of step.commands) {
        if (command.commandKind !== 'draw') continue

        validateCommandReadiness(builder, stepIndex, command, command.resources.read, readiness, diagnostics, step.passSpec)
        for (const resource of command.resources.write) {
            markSimulatedReady(readiness, resource)
        }
    }

    for (const attachment of step.passSpec.color) {
        if (attachment.target instanceof TextureResource) {
            markSimulatedReady(readiness, attachment.target)
        }
    }
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

function validateCommandReadiness(
    builder: SubmissionBuilder,
    stepIndex: number,
    command: ReadCommand,
    readRequirements: CommandResourceReadDescriptor[],
    readiness: ReadinessSimulation,
    diagnostics: ScratchDiagnostic[],
    passSpec?: RenderPassSpec | ComputePassSpec,
    role?: string
): void {

    for (const readRequirement of readRequirements) {
        const resource = readRequirement.resource
        const simulated = simulatedResourceState(readiness, resource)

        if (command.whenMissing === 'throw' && simulated.state !== 'ready') {
            throwCommandResourceNotReadyDiagnostic(builder, stepIndex, command, readRequirement, simulated, passSpec, role)
        }

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
                'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
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
                'SCRATCH_SUBMISSION_STALE_READ'
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
    role?: string
): never {

    const resource = readRequirement.resource

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        related: [
            resource.subject,
            passSpec?.subject,
            builder.subject,
        ].filter(isDefined),
        message: 'Command read resource is not ready.',
        expected: { resourceState: 'ready' },
        actual: {
            stepIndex,
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
    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE' | 'SCRATCH_SUBMISSION_STALE_READ'
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
            passSpec?.subject,
            builder.subject,
        ].filter(isDefined),
        message: isFutureRead
            ? 'Command requires a resource content epoch that has not been produced at its read point.'
            : 'Command requires an older resource content epoch than the one available at its read point.',
        expected: { contentEpoch: readRequirement.contentEpoch },
        actual: {
            stepIndex,
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
    done: Promise<unknown>

    constructor(runtime: ScratchRuntime, options: {
        id?: string
        commandBuffers?: GPUCommandBuffer[]
        report?: ScratchDiagnosticReport
        resourceAccesses?: SubmissionResourceAccess[]
        done?: Promise<unknown>
    } = {}) {

        this.runtime = runtime
        this.id = options.id ?? `scratch-submitted-${UUID()}`
        this.commandBuffers = options.commandBuffers ?? []
        this.report = options.report ?? createScratchDiagnosticReport([])
        this.diagnostics = this.report.diagnostics
        this.resourceAccesses = freezeResourceAccesses(options.resourceAccesses ?? [])
        this.producerEpochs = freezeProducerEpochs(createProducerEpochs(this.resourceAccesses))
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

function collectRenderPassResourceConflictDiagnostics(builder: SubmissionBuilder, step: RenderStep, stepIndex: number): ScratchDiagnostic[] {

    const diagnostics: ScratchDiagnostic[] = []
    const attachmentTargets = collectRenderAttachmentTargets(step.passSpec)
    if (attachmentTargets.size === 0) return diagnostics

    for (const command of step.commands) {
        if (command.commandKind !== 'draw') continue

        collectRenderCommandResourceConflictDiagnostics(builder, step, stepIndex, command, attachmentTargets, 'read', diagnostics)
        collectRenderCommandResourceConflictDiagnostics(builder, step, stepIndex, command, attachmentTargets, 'write', diagnostics)
    }

    return diagnostics
}

function collectRenderCommandResourceConflictDiagnostics(
    builder: SubmissionBuilder,
    step: RenderStep,
    stepIndex: number,
    command: DrawCommand,
    attachmentTargets: Set<TextureResource>,
    access: SubmissionResourceAccessKind,
    diagnostics: ScratchDiagnostic[]
): void {

    const resources = access === 'read'
        ? command.resources.read.map(read => read.resource)
        : command.resources.write

    for (const resource of resources) {
        if (!(resource instanceof TextureResource) || !attachmentTargets.has(resource)) continue

        diagnostics.push(createScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            severity: 'error',
            phase: 'submission',
            subject: command.subject,
            related: [
                step.passSpec.subject,
                resource.subject,
                builder.subject,
            ],
            message: 'DrawCommand resources must not include the current render pass color attachment target.',
            expected: {
                attachment: 'pass-level write only',
                drawResources: 'must exclude current render pass color attachment targets',
            },
            actual: {
                stepIndex,
                passId: step.passSpec.id,
                commandId: command.id,
                access,
                resourceId: resource.id,
                resourceKind: resource.resourceKind,
                contentEpoch: resource.contentEpoch,
                allocationVersion: resource.allocationVersion,
            },
        }))
    }
}

function collectRenderAttachmentTargets(passSpec: RenderPassSpec): Set<TextureResource> {

    const attachmentTargets = new Set<TextureResource>()
    for (const attachment of passSpec.color) {
        const target = attachment.target
        if (target instanceof TextureResource) attachmentTargets.add(target)
    }

    return attachmentTargets
}

function validatePipelineTargets(command: DrawCommand, passSpec: RenderPassSpec) {

    const targetFormats = command.pipeline.targetFormats
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
}

function createDonePromise(queue: GPUQueue): Promise<unknown> {

    if (queue && typeof queue.onSubmittedWorkDone === 'function') {
        return queue.onSubmittedWorkDone()
    }

    return Promise.resolve()
}
