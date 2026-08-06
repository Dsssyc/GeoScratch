import type {
    GPUReadbackCommandState,
    ReadbackCommand,
    SubmissionAuthority,
    SubmissionBuilder,
    SubmittedWork,
} from '../scratch/index.js'
import { createGeoDiagnostic, throwGeoDiagnostic, type GeoDiagnostic } from './diagnostics.js'
import {
    gpuTileFrontierDiagnosticsCodec,
    type GpuTileFrontierDemand,
    type GpuTileFrontierFacts,
} from './gpu-tile-frontier-layout.js'
import {
    GpuTileFrontier,
    gpuTileFrontierFeedbackAccess,
    gpuTileFrontierFeedbackFrameAccess,
    registerGpuTileFrontierFeedbackOwner,
    unregisterGpuTileFrontierFeedbackOwner,
    type GpuTileFrontierFrame,
} from './gpu-tile-frontier.js'

const FEEDBACK_SLOT_COUNT = 3

let nextFeedbackRingId = 1

const U32_MAX = 0xffff_ffff

export type VirtualRasterGpuFeedbackSlotFacts = Readonly<{
    index: number
    commandId: string
    state: GPUReadbackCommandState
}>

export type VirtualRasterGpuFeedbackRingFacts = Readonly<{
    id: string
    frontierId: string
    runtimeId: string
    slotCount: 3
    issuedCount: number
    disposed: boolean
    slots: readonly VirtualRasterGpuFeedbackSlotFacts[]
}>

export type GpuTileFrontierRetirement = Readonly<{
    pageKey: string
    physicalSlot: number
    generation: number
    contentEpoch: number
    decisionFrameEpoch: number
    residencySnapshotEpoch: number
}>

export type VirtualRasterGpuFeedbackCounters = Readonly<{
    currentFrontierCount: number
    nextFrontierCount: number
    visibleInstanceCount: number
    refineCandidateCount: number
    coarsenCandidateCount: number
    demandCount: number
    retirementCount: number
    staleGenerationCount: number
    budgetLimitedCount: number
    lookupDuplicateCount: number
    balanceRejectedCount: number
    fallbackCount: number
    acceptedRefineCount: number
    acceptedCoarsenCount: number
    discardedStaleRetirementCount: number
}>

export type VirtualRasterGpuFeedbackBatch = Readonly<{
    kind: 'virtual-raster-gpu-feedback-batch'
    ringId: string
    frontierId: string
    submissionId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    demands: readonly GpuTileFrontierDemand[]
    retirements: readonly GpuTileFrontierRetirement[]
    facts: GpuTileFrontierFacts
    counters: VirtualRasterGpuFeedbackCounters
    diagnostics: readonly GeoDiagnostic[]
}>

export class VirtualRasterGpuFeedbackRing {

    readonly id: string
    readonly frontier: GpuTileFrontier
    readonly #commands: readonly [ReadbackCommand, ReadbackCommand, ReadbackCommand]
    readonly #authority: SubmissionAuthority
    readonly #encodedBuilders = new WeakSet<SubmissionBuilder>()
    #disposed = false

    private constructor(
        frontier: GpuTileFrontier,
        commands: readonly [ReadbackCommand, ReadbackCommand, ReadbackCommand]
    ) {

        this.id = `geo-virtual-raster-feedback-ring-${nextFeedbackRingId++}`
        this.frontier = frontier
        this.#commands = commands
        this.#authority = frontier.runtime.createSubmissionAuthority({
            label: `${this.id} issue`,
        })
        registerGpuTileFrontierFeedbackOwner(frontier, this)
        Object.preventExtensions(this)
    }

    static async create(
        frontier: GpuTileFrontier
    ): Promise<VirtualRasterGpuFeedbackRing> {

        if (!(frontier instanceof GpuTileFrontier)) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_RING_INVALID',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring' },
                message: 'Virtual Raster GPU feedback requires an active GPU tile frontier.',
                expected: { frontier: 'GpuTileFrontier' },
                actual: { frontier: typeof frontier },
            })
        }
        const access = gpuTileFrontierFeedbackAccess(frontier)
        const commands: ReadbackCommand[] = []
        try {
            for (let index = 0; index < FEEDBACK_SLOT_COUNT; index++) {
                commands.push(await frontier.runtime.createReadbackCommand({
                    label: `Read GPU tile frontier feedback slot ${index}`,
                    source: {
                        region: access.region,
                        contentEpoch: 'current-at-step',
                    },
                    retain: 'consume-on-read',
                    whenMissing: 'throw',
                }))
            }
            return new VirtualRasterGpuFeedbackRing(frontier, commands as [
                ReadbackCommand,
                ReadbackCommand,
                ReadbackCommand,
            ])
        } catch (error) {
            for (let index = commands.length - 1; index >= 0; index--) {
                commands[index]!.dispose()
            }
            throw error
        }
    }

    facts(): VirtualRasterGpuFeedbackRingFacts {

        return Object.freeze({
            id: this.id,
            frontierId: this.frontier.id,
            runtimeId: this.frontier.runtime.id,
            slotCount: FEEDBACK_SLOT_COUNT,
            issuedCount: this.#authority.revision,
            disposed: this.#disposed,
            slots: Object.freeze(this.#commands.map((command, index) => Object.freeze({
                index,
                commandId: command.id,
                state: command.state,
            }))),
        })
    }

    encode(
        builder: SubmissionBuilder,
        frame: GpuTileFrontierFrame
    ): SubmissionBuilder {

        this.#assertActive()
        const access = gpuTileFrontierFeedbackFrameAccess(this.frontier, frame)
        const steps = builder?.steps
        const uploadIndex = Array.isArray(steps)
            ? steps.findIndex(step =>
                step.kind === 'upload' && step.command === access.viewCommand
            )
            : -1
        const computeIndex = Array.isArray(steps)
            ? steps.findIndex(step =>
                step.kind === 'compute' &&
                step.passSpec === access.pass &&
                step.commands.length === access.commands.length &&
                step.commands.every((command, index) => command === access.commands[index])
            )
            : -1
        if (builder?.runtime !== this.frontier.runtime || builder.isSubmitted ||
            uploadIndex < 0 || computeIndex <= uploadIndex ||
            this.#encodedBuilders.has(builder)) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_FRAME_INVALID',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'GPU feedback encoding requires one current frontier frame already encoded in the same open submission.',
                expected: {
                    runtimeId: this.frontier.runtime.id,
                    frontierId: this.frontier.id,
                    encodedOnce: false,
                },
                actual: {
                    runtimeId: builder?.runtime?.id,
                    frontierId: frame?.frontierId,
                    submitted: builder?.isSubmitted,
                    uploadIndex,
                    computeIndex,
                    encoded: builder === undefined
                        ? false
                        : this.#encodedBuilders.has(builder),
                },
            })
        }
        const start = this.#authority.revision % FEEDBACK_SLOT_COUNT
        let command: ReadbackCommand | undefined
        for (let offset = 0; offset < FEEDBACK_SLOT_COUNT; offset++) {
            const candidate = this.#commands[(start + offset) % FEEDBACK_SLOT_COUNT]!
            if (candidate.state === 'idle') {
                command = candidate
                break
            }
        }
        if (command === undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_BACKPRESSURE',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'All bounded GPU feedback readback slots are busy.',
                expected: { idleSlots: 'at least one', slotCount: FEEDBACK_SLOT_COUNT },
                actual: {
                    states: this.#commands.map(candidate => candidate.state),
                    issuedCount: this.#authority.revision,
                },
            })
        }
        this.#encodedBuilders.add(builder)
        return builder
            .readback(command)
            .consume(this.#authority.stamp())
    }

    async feedback(
        frame: GpuTileFrontierFrame,
        submitted: SubmittedWork
    ): Promise<VirtualRasterGpuFeedbackBatch> {

        this.#assertActive()
        const frameAccess = gpuTileFrontierFeedbackFrameAccess(this.frontier, frame)
        if (submitted?.runtime !== this.frontier.runtime ||
            !submitted.resourceAccesses.some(access =>
                access.commandId === frameAccess.viewCommand.id
            )) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_FRAME_INVALID',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'GPU feedback requires SubmittedWork produced by the exact frontier frame.',
                expected: {
                    runtimeId: this.frontier.runtime.id,
                    viewCommandId: frameAccess.viewCommand.id,
                },
                actual: {
                    runtimeId: submitted?.runtime?.id,
                    submissionId: submitted?.id,
                },
            })
        }
        const commandIds = new Set(this.#commands.map(command => command.id))
        const links = submitted.readbacks.filter(link => commandIds.has(link.commandId))
        if (links.length !== 1) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_FRAME_INVALID',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'SubmittedWork must contain exactly one readback from this feedback ring.',
                expected: { readbackCount: 1 },
                actual: { submissionId: submitted.id, readbackCount: links.length },
            })
        }
        const frontierAccess = gpuTileFrontierFeedbackAccess(this.frontier)
        if (frontierAccess.sequenceRevision < frameAccess.sequenceRevision + 2) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_TOO_RECENT',
                phase: 'selection',
                subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
                message: 'GPU feedback is consumable only after a later frontier issue.',
                expected: { minimumSequenceRevision: frameAccess.sequenceRevision + 2 },
                actual: { sequenceRevision: frontierAccess.sequenceRevision },
            })
        }
        const link = links[0]!
        const command = this.#commands.find(candidate => candidate.id === link.commandId)!
        const operation = command.result({ after: submitted })
        if (operation.state === 'consumed') {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_CONSUMED',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'GPU feedback is a consume-on-read result and was already consumed.',
                actual: { submissionId: submitted.id, operationId: operation.id },
            })
        }
        if (operation.state === 'cancelled' || operation.state === 'disposed' ||
            operation.state === 'failed') {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_UNAVAILABLE',
                phase: 'selection',
                subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
                message: 'GPU feedback readback is no longer available.',
                actual: { submissionId: submitted.id, state: operation.state },
            })
        }
        const bytes = await operation.toBytes()
        const currentSnapshotEpoch = frontierAccess.gpuState.facts().snapshotEpoch
        const decoded = decodeEmptyFeedback(
            bytes,
            frontierAccess.output,
            frame,
            frameAccess.residencySnapshotEpoch
        )
        if (currentSnapshotEpoch !== frameAccess.residencySnapshotEpoch) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_STALE',
                phase: 'selection',
                subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
                message: 'GPU feedback belongs to an older acknowledged residency snapshot.',
                expected: { residencySnapshotEpoch: currentSnapshotEpoch },
                actual: { residencySnapshotEpoch: frameAccess.residencySnapshotEpoch },
            })
        }
        return Object.freeze({
            kind: 'virtual-raster-gpu-feedback-batch',
            ringId: this.id,
            frontierId: this.frontier.id,
            submissionId: submitted.id,
            frameEpoch: frame.frameEpoch,
            residencySnapshotEpoch: frameAccess.residencySnapshotEpoch,
            demands: Object.freeze([]),
            retirements: Object.freeze([]),
            facts: decoded.facts,
            counters: decoded.counters,
            diagnostics: decoded.diagnostics,
        })
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        unregisterGpuTileFrontierFeedbackOwner(this.frontier, this)
        this.#authority.dispose()
        for (const command of this.#commands) command.dispose()
    }

    #assertActive(): void {

        if (!this.#disposed) return
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_FEEDBACK_RING_DISPOSED',
            phase: 'selection',
            subject: { kind: 'virtual-raster-gpu-feedback-ring', id: this.id },
            message: 'Virtual Raster GPU feedback ring is disposed.',
        })
    }
}

Object.freeze(VirtualRasterGpuFeedbackRing.prototype)

type EmptyDecodedFeedback = Readonly<{
    facts: GpuTileFrontierFacts
    counters: VirtualRasterGpuFeedbackCounters
    diagnostics: readonly GeoDiagnostic[]
}>

function decodeEmptyFeedback(
    bytes: Uint8Array,
    output: ReturnType<typeof gpuTileFrontierFeedbackAccess>['output'],
    frame: GpuTileFrontierFrame,
    residencySnapshotEpoch: number
): EmptyDecodedFeedback {

    const layout = output.layout
    if (bytes.byteLength !== layout.byteLength) {
        return invalidFeedback('GPU feedback byte length does not match its fixed layout.', {
            byteLength: layout.byteLength,
        }, { byteLength: bytes.byteLength })
    }
    const counters = new Uint32Array(
        bytes.buffer,
        bytes.byteOffset + layout.counters.offset,
        layout.counters.byteLength / 4
    )
    const diagnosticBytes = bytes.subarray(
        layout.diagnostics.offset,
        layout.diagnostics.offset + layout.diagnostics.byteLength
    )
    const record = gpuTileFrontierDiagnosticsCodec
        .createReadbackView(diagnosticBytes)
        .toObject()
    if (counters[5] !== 0 || counters[6] !== 0) {
        return invalidFeedback('GPU feedback contains records without a decoder.', {
            demandCount: 0,
            retirementCount: 0,
        }, { demandCount: counters[5], retirementCount: counters[6] })
    }
    const recordFrameEpoch = numberField(record, 'frameEpoch')
    const recordSnapshotEpoch = numberField(record, 'residencySnapshotEpoch')
    if (recordFrameEpoch !== frame.frameEpoch ||
        recordSnapshotEpoch !== residencySnapshotEpoch ||
        counters[17] !== frame.frameEpoch ||
        counters[18] !== residencySnapshotEpoch) {
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_FEEDBACK_STALE',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'Packed GPU feedback decision epochs do not match the requested frame.',
            expected: { frameEpoch: frame.frameEpoch, residencySnapshotEpoch },
            actual: {
                frameEpoch: recordFrameEpoch,
                residencySnapshotEpoch: recordSnapshotEpoch,
                counterFrameEpoch: counters[17],
                counterSnapshotEpoch: counters[18],
            },
        })
    }
    const convergenceState = convergence(numberField(record, 'convergenceState'))
    const facts: {
        frameEpoch: number
        residencySnapshotEpoch: number
        activeFrontierCount: number
        visibleInstanceCount: number
        refineCandidateCount: number
        coarsenCandidateCount: number
        demandCount: number
        fallbackCount: number
        staleGenerationCount: number
        budgetLimitedCount: number
        maximumObservedSse: number
        minimumSelectedMatrixLevel?: number
        maximumSelectedMatrixLevel?: number
        frontierOverflow: boolean
        demandOverflow: boolean
        visibleOverflow: boolean
        convergenceState: GpuTileFrontierFacts['convergenceState']
    } = {
        frameEpoch: recordFrameEpoch,
        residencySnapshotEpoch: recordSnapshotEpoch,
        activeFrontierCount: numberField(record, 'activeFrontierCount'),
        visibleInstanceCount: numberField(record, 'visibleInstanceCount'),
        refineCandidateCount: numberField(record, 'refineCandidateCount'),
        coarsenCandidateCount: numberField(record, 'coarsenCandidateCount'),
        demandCount: numberField(record, 'demandCount'),
        fallbackCount: numberField(record, 'fallbackCount'),
        staleGenerationCount: numberField(record, 'staleGenerationCount'),
        budgetLimitedCount: numberField(record, 'budgetLimitedCount'),
        maximumObservedSse: numberField(record, 'maximumObservedSse'),
        frontierOverflow: booleanField(record, 'frontierOverflow'),
        demandOverflow: booleanField(record, 'demandOverflow'),
        visibleOverflow: booleanField(record, 'visibleOverflow'),
        convergenceState,
    }
    const minimumLevel = numberField(record, 'minimumSelectedMatrixLevel')
    const maximumLevel = numberField(record, 'maximumSelectedMatrixLevel')
    if (minimumLevel !== U32_MAX) facts.minimumSelectedMatrixLevel = minimumLevel
    if (maximumLevel !== U32_MAX) facts.maximumSelectedMatrixLevel = maximumLevel
    const decodedCounters = Object.freeze({
        currentFrontierCount: counters[0]!,
        nextFrontierCount: counters[1]!,
        visibleInstanceCount: counters[2]!,
        refineCandidateCount: counters[3]!,
        coarsenCandidateCount: counters[4]!,
        demandCount: counters[5]!,
        retirementCount: counters[6]!,
        staleGenerationCount: counters[7]!,
        budgetLimitedCount: counters[8]!,
        lookupDuplicateCount: counters[15]!,
        balanceRejectedCount: counters[16]!,
        fallbackCount: counters[19]!,
        acceptedRefineCount: counters[20]!,
        acceptedCoarsenCount: counters[21]!,
        discardedStaleRetirementCount: 0,
    })
    const diagnostics = decodedCounters.lookupDuplicateCount === 0
        ? Object.freeze([])
        : Object.freeze([ createGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_LOOKUP_DUPLICATE',
            severity: 'error',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile frontier reported duplicate lookup identities.',
            actual: { count: decodedCounters.lookupDuplicateCount },
        }) ])
    return Object.freeze({
        facts: Object.freeze(facts),
        counters: decodedCounters,
        diagnostics,
    })
}

function numberField(record: Record<string, unknown>, name: string): number {

    const value = record[name]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return invalidFeedback('GPU feedback contains an invalid numeric field.', {
            field: name,
            value: 'finite number',
        }, { field: name, value })
    }
    return value
}

function booleanField(record: Record<string, unknown>, name: string): boolean {

    const value = numberField(record, name)
    if (value !== 0 && value !== 1) {
        return invalidFeedback('GPU feedback contains an invalid boolean field.', {
            field: name,
            value: [ 0, 1 ],
        }, { field: name, value })
    }
    return value === 1
}

function convergence(value: number): GpuTileFrontierFacts['convergenceState'] {

    if (value === 0) return 'converged'
    if (value === 1) return 'transitioning'
    if (value === 2) return 'budget-limited'
    return invalidFeedback('GPU feedback contains an invalid convergence state.', {
        convergenceState: [ 0, 1, 2 ],
    }, { convergenceState: value })
}

function invalidFeedback(message: string, expected?: unknown, actual?: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FEEDBACK_INVALID',
        phase: 'selection',
        subject: { kind: 'virtual-raster-gpu-feedback-batch' },
        message,
        ...(expected !== undefined ? { expected } : {}),
        ...(actual !== undefined ? { actual } : {}),
    })
}
