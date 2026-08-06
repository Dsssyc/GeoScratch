import type {
    GPUReadbackCommandState,
    ReadbackCommand,
    SubmissionAuthority,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    GpuTileFrontier,
    gpuTileFrontierFeedbackAccess,
    registerGpuTileFrontierFeedbackOwner,
    unregisterGpuTileFrontierFeedbackOwner,
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

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        unregisterGpuTileFrontierFeedbackOwner(this.frontier, this)
        this.#authority.dispose()
        for (const command of this.#commands) command.dispose()
    }
}

Object.freeze(VirtualRasterGpuFeedbackRing.prototype)
