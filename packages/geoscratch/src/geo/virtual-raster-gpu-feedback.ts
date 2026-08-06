import type {
    GPUReadbackCommandState,
    ReadbackCommand,
    SubmissionAuthority,
    SubmissionBuilder,
    SubmittedWork,
} from '../scratch/index.js'
import { createGeoDiagnostic, throwGeoDiagnostic, type GeoDiagnostic } from './diagnostics.js'
import {
    compareGpuTileFrontierPathOrder,
    gpuTileFrontierDemandCodec,
    gpuTileFrontierDiagnosticsCodec,
    gpuTileFrontierEntryCodec,
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
import { virtualRasterGpuAcknowledgedSnapshot } from './virtual-raster-gpu.js'
import type {
    VirtualRasterAddressSpace,
    VirtualRasterPageIdentity,
    VirtualRasterSnapshot,
} from './virtual-raster.js'

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
    page: VirtualRasterPageIdentity
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
        const snapshot = virtualRasterGpuAcknowledgedSnapshot(frontierAccess.gpuState)
        if (snapshot?.epoch !== frameAccess.residencySnapshotEpoch) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_STALE',
                phase: 'selection',
                subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
                message: 'GPU feedback belongs to an older acknowledged residency snapshot.',
                expected: { residencySnapshotEpoch: snapshot?.epoch },
                actual: { residencySnapshotEpoch: frameAccess.residencySnapshotEpoch },
            })
        }
        const decoded = decodeFeedback(
            bytes,
            frontierAccess.output,
            frame,
            snapshot
        )
        return Object.freeze({
            kind: 'virtual-raster-gpu-feedback-batch',
            ringId: this.id,
            frontierId: this.frontier.id,
            submissionId: submitted.id,
            frameEpoch: frame.frameEpoch,
            residencySnapshotEpoch: frameAccess.residencySnapshotEpoch,
            demands: decoded.demands,
            retirements: decoded.retirements,
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

type DecodedFeedback = Readonly<{
    demands: readonly GpuTileFrontierDemand[]
    retirements: readonly GpuTileFrontierRetirement[]
    facts: GpuTileFrontierFacts
    counters: VirtualRasterGpuFeedbackCounters
    diagnostics: readonly GeoDiagnostic[]
}>

function decodeFeedback(
    bytes: Uint8Array,
    output: ReturnType<typeof gpuTileFrontierFeedbackAccess>['output'],
    frame: GpuTileFrontierFrame,
    snapshot: VirtualRasterSnapshot
): DecodedFeedback {

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
    const recordFrameEpoch = numberField(record, 'frameEpoch')
    const recordSnapshotEpoch = numberField(record, 'residencySnapshotEpoch')
    if (recordFrameEpoch !== frame.frameEpoch ||
        recordSnapshotEpoch !== snapshot.epoch ||
        counters[17] !== frame.frameEpoch ||
        counters[18] !== snapshot.epoch) {
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_FEEDBACK_STALE',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'Packed GPU feedback decision epochs do not match the requested frame.',
            expected: { frameEpoch: frame.frameEpoch, residencySnapshotEpoch: snapshot.epoch },
            actual: {
                frameEpoch: recordFrameEpoch,
                residencySnapshotEpoch: recordSnapshotEpoch,
                counterFrameEpoch: counters[17],
                counterSnapshotEpoch: counters[18],
            },
        })
    }
    assertCounterMatches(record, 'activeFrontierCount', counters[0]!)
    assertCounterMatches(record, 'visibleInstanceCount', counters[2]!)
    assertCounterMatches(record, 'refineCandidateCount', counters[3]!)
    assertCounterMatches(record, 'coarsenCandidateCount', counters[4]!)
    assertCounterMatches(record, 'demandCount', counters[5]!)
    assertCounterMatches(record, 'staleGenerationCount', counters[7]!)
    assertCounterMatches(record, 'budgetLimitedCount', counters[8]!)
    assertCounterMatches(record, 'fallbackCount', counters[19]!)
    assertCounterMatches(record, 'reserved0', counters[15]!)
    assertCounterMatches(record, 'reserved1', counters[16]!)
    assertCounterMatches(record, 'reserved2', counters[6]!)
    const frontierOverflow = booleanField(record, 'frontierOverflow')
    const demandOverflow = booleanField(record, 'demandOverflow')
    const visibleOverflow = booleanField(record, 'visibleOverflow')
    if (frontierOverflow !== counterBoolean(counters[12]!, 'frontierOverflow') ||
        demandOverflow !== counterBoolean(counters[13]!, 'demandOverflow') ||
        visibleOverflow !== counterBoolean(counters[14]!, 'visibleOverflow')) {
        return invalidFeedback('GPU feedback overflow facts disagree with packed counters.', {
            overflowFacts: 'matching diagnostics and counters',
        }, {
            diagnostics: { frontierOverflow, demandOverflow, visibleOverflow },
            counters: {
                frontierOverflow: counters[12],
                demandOverflow: counters[13],
                visibleOverflow: counters[14],
            },
        })
    }
    if (demandOverflow || counters[5]! > layout.demands.capacity) {
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_DEMAND_CAPACITY_EXCEEDED',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile demand feedback exceeded its fixed capacity.',
            expected: { maximumDemands: layout.demands.capacity, overflow: false },
            actual: { demandCount: counters[5], overflow: demandOverflow },
        })
    }
    if (frontierOverflow || visibleOverflow ||
        counters[6]! > layout.retirements.capacity) {
        return throwGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_CAPACITY_EXCEEDED',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile frontier feedback exceeded a fixed output capacity.',
            expected: {
                maximumRetirements: layout.retirements.capacity,
                frontierOverflow: false,
                visibleOverflow: false,
            },
            actual: {
                retirementCount: counters[6],
                frontierOverflow,
                visibleOverflow,
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
        frontierOverflow,
        demandOverflow,
        visibleOverflow,
        convergenceState,
    }
    const minimumLevel = numberField(record, 'minimumSelectedMatrixLevel')
    const maximumLevel = numberField(record, 'maximumSelectedMatrixLevel')
    if (minimumLevel !== U32_MAX) facts.minimumSelectedMatrixLevel = minimumLevel
    if (maximumLevel !== U32_MAX) facts.maximumSelectedMatrixLevel = maximumLevel
    const demands = decodeDemands(
        bytes.subarray(
            layout.demands.offset,
            layout.demands.offset + layout.demands.byteLength
        ),
        counters[5]!,
        snapshot,
        frame.frameEpoch
    )
    const decodedRetirements = decodeRetirements(
        bytes.subarray(
            layout.retirements.offset,
            layout.retirements.offset + layout.retirements.byteLength
        ),
        counters[6]!,
        snapshot,
        frame.frameEpoch
    )
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
        discardedStaleRetirementCount: decodedRetirements.discarded,
    })
    const diagnostics: GeoDiagnostic[] = []
    if (decodedCounters.lookupDuplicateCount > 0) {
        diagnostics.push(createGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_LOOKUP_DUPLICATE',
            severity: 'error',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile frontier reported duplicate lookup identities.',
            actual: { count: decodedCounters.lookupDuplicateCount },
        }))
    }
    if (decodedCounters.balanceRejectedCount > 0) {
        diagnostics.push(createGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_BALANCE_REJECTED',
            severity: 'warn',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile frontier rejected neighbor balance transitions.',
            actual: { count: decodedCounters.balanceRejectedCount },
        }))
    }
    if (decodedCounters.staleGenerationCount > 0) {
        diagnostics.push(createGeoDiagnostic({
            code: 'GEO_GPU_TILE_FRONTIER_STALE_GENERATION',
            severity: 'warn',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'GPU tile frontier discarded stale slot generations.',
            actual: { count: decodedCounters.staleGenerationCount },
        }))
    }
    if (decodedRetirements.discarded > 0) {
        diagnostics.push(createGeoDiagnostic({
            code: 'GEO_GPU_TILE_FEEDBACK_STALE_RETIREMENT',
            severity: 'warn',
            phase: 'selection',
            subject: { kind: 'gpu-tile-frontier-frame', id: String(frame.frameEpoch) },
            message: 'Generation-stale GPU retirement records were discarded.',
            actual: { count: decodedRetirements.discarded },
        }))
    }
    return Object.freeze({
        demands,
        retirements: decodedRetirements.retirements,
        facts: Object.freeze(facts),
        counters: decodedCounters,
        diagnostics: Object.freeze(diagnostics),
    })
}

function decodeDemands(
    bytes: Uint8Array,
    count: number,
    snapshot: VirtualRasterSnapshot,
    frameEpoch: number
): readonly GpuTileFrontierDemand[] {

    const records = gpuTileFrontierDemandCodec.createReadbackView(bytes).toArray()
    const canonical = new Map<string, GpuTileFrontierDemand>()
    for (const record of records.slice(0, count)) {
        const page = pageFromFeedbackRecord(snapshot.addressSpace, record)
        const parent = snapshot.addressSpace.parent(page)
        if (parent === undefined) {
            return invalidFeedback('GPU demand page has no covered parent.', {
                page: 'non-root virtual raster page',
            }, { page: page.key })
        }
        const parentCompactIndex = u32Field(record, 'parentCompactIndex')
        const parentPhysicalSlot = u32Field(record, 'parentPhysicalSlot')
        const parentGeneration = u32Field(record, 'parentGeneration')
        const priority = u32Field(record, 'priority')
        const decisionFrameEpoch = u32Field(record, 'decisionFrameEpoch')
        const residencySnapshotEpoch = u32Field(record, 'residencySnapshotEpoch')
        const childMask = u32Field(record, 'childMask')
        const tile = page.tile!
        const expectedChildMask = 1 << ((tile.tileRow % 2) * 2 + tile.tileCol % 2)
        const parentEntry = snapshot.resolve(parent)
        if (parentCompactIndex !== snapshot.addressSpace.tableIndex(parent) ||
            childMask !== expectedChildMask) {
            return invalidFeedback('GPU demand parent identity or child mask is inconsistent.', {
                parentCompactIndex: snapshot.addressSpace.tableIndex(parent),
                childMask: expectedChildMask,
            }, { parentCompactIndex, childMask, page: page.key })
        }
        if (decisionFrameEpoch !== frameEpoch ||
            residencySnapshotEpoch !== snapshot.epoch ||
            parentEntry.physicalSlot !== parentPhysicalSlot ||
            parentEntry.generation !== parentGeneration) {
            return throwGeoDiagnostic({
                code: 'GEO_GPU_TILE_FEEDBACK_STALE',
                phase: 'selection',
                subject: { kind: 'virtual-raster-page', id: page.key },
                message: 'GPU demand parent authority no longer matches the acknowledged snapshot.',
                expected: {
                    decisionFrameEpoch: frameEpoch,
                    residencySnapshotEpoch: snapshot.epoch,
                    parentPhysicalSlot: parentEntry.physicalSlot,
                    parentGeneration: parentEntry.generation,
                },
                actual: {
                    decisionFrameEpoch,
                    residencySnapshotEpoch,
                    parentPhysicalSlot,
                    parentGeneration,
                },
            })
        }
        const demand = Object.freeze({
            page,
            parent,
            parentCompactIndex,
            parentPhysicalSlot,
            parentGeneration,
            priority,
            decisionFrameEpoch,
            residencySnapshotEpoch,
            childMask,
        })
        const previous = canonical.get(page.key)
        if (previous === undefined || demand.priority > previous.priority) {
            canonical.set(page.key, demand)
        }
    }
    return Object.freeze([ ...canonical.values() ].sort((left, right) =>
        compareGpuTileFrontierPathOrder(left.page, right.page)
    ))
}

type DecodedRetirements = Readonly<{
    retirements: readonly GpuTileFrontierRetirement[]
    discarded: number
}>

function decodeRetirements(
    bytes: Uint8Array,
    count: number,
    snapshot: VirtualRasterSnapshot,
    frameEpoch: number
): DecodedRetirements {

    const records = gpuTileFrontierEntryCodec.createReadbackView(bytes).toArray()
    const canonical = new Map<string, GpuTileFrontierRetirement>()
    let discarded = 0
    for (const record of records.slice(0, count)) {
        const page = pageFromFeedbackRecord(snapshot.addressSpace, record)
        const physicalSlot = u32Field(record, 'physicalSlot')
        const generation = u32Field(record, 'expectedGeneration')
        const contentEpoch = u32Field(record, 'expectedContentEpoch')
        const residencySnapshotEpoch = u32Field(record, 'residencySnapshotEpoch')
        const resolved = snapshot.resolve(page)
        if (residencySnapshotEpoch !== snapshot.epoch ||
            resolved.physicalSlot !== physicalSlot ||
            resolved.generation !== generation ||
            resolved.contentEpoch !== contentEpoch) {
            discarded++
            continue
        }
        const retirement = Object.freeze({
            page,
            physicalSlot,
            generation,
            contentEpoch,
            decisionFrameEpoch: frameEpoch,
            residencySnapshotEpoch,
        })
        canonical.set(`${page.key}@${generation}`, retirement)
    }
    return Object.freeze({
        retirements: Object.freeze(
            [ ...canonical.values() ].sort((left, right) =>
                compareGpuTileFrontierPathOrder(left.page, right.page)
            )
        ),
        discarded,
    })
}

function pageFromFeedbackRecord(
    addressSpace: VirtualRasterAddressSpace,
    record: Record<string, unknown>
): VirtualRasterPageIdentity {

    const samplingLevel = u32Field(record, 'samplingLevel')
    const matrixLevel = u32Field(record, 'matrixLevel')
    const tileRow = u32Field(record, 'tileRow')
    const tileCol = u32Field(record, 'tileCol')
    const compactIndex = u32Field(record, 'compactIndex')
    let page: VirtualRasterPageIdentity
    try {
        page = addressSpace.pageFromTile({
            matrixId: String(matrixLevel),
            tileRow,
            tileCol,
        })
    } catch (error) {
        return invalidFeedback('GPU feedback references a page outside finite coverage.', {
            addressSpaceId: addressSpace.id,
        }, { matrixLevel, tileRow, tileCol, cause: String(error) })
    }
    if (page.level !== samplingLevel || addressSpace.tableIndex(page) !== compactIndex) {
        return invalidFeedback('GPU feedback page address fields are inconsistent.', {
            samplingLevel: page.level,
            compactIndex: addressSpace.tableIndex(page),
        }, { samplingLevel, compactIndex, page: page.key })
    }
    return page
}

function assertCounterMatches(
    record: Record<string, unknown>,
    name: string,
    counter: number
): void {

    const value = u32Field(record, name)
    if (value === counter) return
    return invalidFeedback('GPU feedback diagnostics disagree with packed counters.', {
        field: name,
        value: counter,
    }, { field: name, value })
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

function u32Field(record: Record<string, unknown>, name: string): number {

    const value = numberField(record, name)
    if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
        return invalidFeedback('GPU feedback contains a field outside u32.', {
            field: name,
            value: 'u32',
        }, { field: name, value })
    }
    return value
}

function counterBoolean(value: number, name: string): boolean {

    if (value !== 0 && value !== 1) {
        return invalidFeedback('GPU feedback contains an invalid boolean counter.', {
            field: name,
            value: [ 0, 1 ],
        }, { field: name, value })
    }
    return value === 1
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
