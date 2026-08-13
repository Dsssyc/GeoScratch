import type { WorkerTaskPriority, WorkerTaskPriorityClass } from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import {
    virtualRasterDemandSet,
    type VirtualRasterDemandSet,
} from './virtual-raster-demand.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'

export type ViewTileDemandIntent = 'coverage' | 'refinement' | 'prefetch'

export type ViewTileDemandDescriptor = Readonly<{
    page: VirtualRasterPageIdentity
    priority: WorkerTaskPriority
    intent: ViewTileDemandIntent
    reason: string
    deadlineMs?: number
}>

export type ViewTileDemand = Readonly<{
    page: VirtualRasterPageIdentity
    generation: number
    priority: WorkerTaskPriority
    intent: ViewTileDemandIntent
    reason: string
    deadlineMs?: number
    source: Readonly<{
        kind: 'view'
        producerId: string
        viewId: string
        frameEpoch: number
        residencySnapshotEpoch: number
    }>
}>

export type ViewTileDemandSet = Readonly<{
    kind: 'view-tile-demand-set'
    generation: number
    demands: readonly ViewTileDemand[]
}>

export type ViewDemandProducerDescriptor = Readonly<{
    id: string
    maxDemands: number
}>

export type ViewDemandProduction = Readonly<{
    view: GeoViewSnapshot
    generation: number
    demands: readonly ViewTileDemandDescriptor[]
}>

const priorityClasses = new Set<WorkerTaskPriorityClass>([
    'background',
    'user-visible',
    'critical',
])

/** Converts view-derived candidates into bounded prioritized tile-demand intent. */
export class ViewDemandProducer {

    readonly kind = 'view-demand-producer'
    readonly id!: string
    readonly maxDemands!: number

    constructor(descriptor: ViewDemandProducerDescriptor) {

        if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
            !Number.isSafeInteger(descriptor.maxDemands) || descriptor.maxDemands <= 0) {
            return invalidViewDemand(
                'A view demand producer requires an id and a positive finite demand budget.',
                { id: 'non-empty string', maxDemands: 'positive safe integer' },
                descriptor
            )
        }
        this.id = descriptor.id
        this.maxDemands = descriptor.maxDemands
        Object.freeze(this)
    }

    produce(input: ViewDemandProduction): ViewTileDemandSet {

        if (input?.view?.kind !== 'geo-view-snapshot' ||
            !Number.isSafeInteger(input.generation) || input.generation < 0 ||
            !Array.isArray(input.demands)) {
            return invalidViewDemand(
                'View demand production requires one snapshot, generation, and finite demand list.',
                { view: 'GeoViewSnapshot', generation: 'non-negative safe integer' },
                input
            )
        }
        const source = Object.freeze({
            kind: 'view' as const,
            producerId: this.id,
            viewId: input.view.id,
            frameEpoch: input.view.frameEpoch,
            residencySnapshotEpoch: input.view.residencySnapshotEpoch,
        })
        const byPage = new Map<string, ViewTileDemand>()
        for (const descriptor of input.demands) {
            validateDemandDescriptor(descriptor)
            const demand = Object.freeze({
                page: descriptor.page,
                generation: input.generation,
                priority: Object.freeze({ ...descriptor.priority }),
                intent: descriptor.intent,
                reason: descriptor.reason,
                ...(descriptor.deadlineMs === undefined ? {} : {
                    deadlineMs: descriptor.deadlineMs,
                }),
                source,
            })
            const existing = byPage.get(demand.page.key)
            if (existing === undefined || compareViewDemand(demand, existing) < 0) {
                byPage.set(demand.page.key, demand)
            }
        }
        const demands = [ ...byPage.values() ]
            .sort(compareViewDemand)
            .slice(0, this.maxDemands)
        return Object.freeze({
            kind: 'view-tile-demand-set' as const,
            generation: input.generation,
            demands: Object.freeze(demands),
        })
    }
}

/** Lowers one view-demand generation into Virtual Raster request semantics. */
export function virtualRasterDemandSetFromViewDemands(
    demandSet: ViewTileDemandSet
): VirtualRasterDemandSet {

    if (demandSet?.kind !== 'view-tile-demand-set') {
        return invalidViewDemand(
            'Virtual Raster lowering requires one ViewTileDemandSet.',
            { kind: 'view-tile-demand-set' },
            demandSet
        )
    }
    return virtualRasterDemandSet({
        generation: demandSet.generation,
        demands: demandSet.demands.map(demand => Object.freeze({
            page: demand.page,
            generation: demand.generation,
            priority: demand.priority,
            reason: demand.reason,
            usage: demand.intent === 'prefetch' ? 'prefetch' as const : 'required' as const,
            ...(demand.deadlineMs === undefined ? {} : { deadlineMs: demand.deadlineMs }),
        })),
    })
}

function validateDemandDescriptor(descriptor: ViewTileDemandDescriptor): void {

    if (descriptor?.page?.kind !== 'virtual-raster-page' ||
        !priorityClasses.has(descriptor.priority?.class) ||
        !Number.isFinite(descriptor.priority?.score) ||
        (descriptor.intent !== 'coverage' && descriptor.intent !== 'refinement' &&
            descriptor.intent !== 'prefetch') ||
        typeof descriptor.reason !== 'string' || descriptor.reason.length === 0 ||
        (descriptor.deadlineMs !== undefined &&
            (!Number.isFinite(descriptor.deadlineMs) || descriptor.deadlineMs < 0))) {
        return invalidViewDemand(
            'Each view demand requires page, priority, intent, and reason facts.',
            {
                page: 'VirtualRasterPageIdentity',
                priority: 'WorkerTaskPriority',
                intent: [ 'coverage', 'refinement', 'prefetch' ],
                reason: 'non-empty string',
            },
            descriptor
        )
    }
}

function compareViewDemand(left: ViewTileDemand, right: ViewTileDemand): number {

    return priorityRank(right.priority.class) - priorityRank(left.priority.class) ||
        intentRank(right.intent) - intentRank(left.intent) ||
        right.priority.score - left.priority.score ||
        (left.deadlineMs ?? Number.POSITIVE_INFINITY) -
            (right.deadlineMs ?? Number.POSITIVE_INFINITY) ||
        left.page.key.localeCompare(right.page.key)
}

function priorityRank(value: WorkerTaskPriorityClass): number {

    switch (value) {
        case 'critical': return 3
        case 'user-visible': return 2
        case 'background': return 1
    }
}

function intentRank(value: ViewTileDemandIntent): number {

    switch (value) {
        case 'coverage': return 3
        case 'refinement': return 2
        case 'prefetch': return 1
    }
}

function invalidViewDemand(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIEW_DEMAND_INVALID',
        phase: 'demand',
        subject: { kind: 'view-demand' },
        message,
        expected,
        actual,
    })
}
