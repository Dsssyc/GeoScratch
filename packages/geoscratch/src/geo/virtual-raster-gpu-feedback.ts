import type {
    GPUReadbackCommandState,
    ReadbackCommand,
    SubmissionAuthority,
    SubmissionBuilder,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
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
