import { layoutCodec, type LayoutCodec } from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { WebMercatorQuadAddressCodec } from './web-mercator-quad.js'
import type { VirtualRasterGpuState } from './virtual-raster-gpu.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'

export type GpuTileFrontierPolicy = Readonly<{
    refineErrorPixels: number
    coarsenErrorPixels: number
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    maximumActiveTiles: number
    maximumDemands: number
    transitionReservePages: number
    invisibleGraceFrames: number
}>

export type GpuTileFrontierView = Readonly<{
    clipFromRelativeWorld: ArrayLike<number>
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    viewport: readonly [number, number]
    verticalFovRadians: number
    cameraLatitudeRadians: number
    zoomHint: number
    frameEpoch: number
    residencySnapshotEpoch: number
}>

export type GpuTileFrontierLevelMetric = Readonly<{
    matrixLevel: number
    minimumElevationMeters: number
    maximumElevationMeters: number
    geometricErrorMeters: number
}>

export type GpuTileFrontierDrawTemplate = Readonly<{
    id: string
    vertexCount: number
    firstVertex?: number
    firstInstance?: number
}>

export type GpuTileFrontierDescriptor = Readonly<{
    gpuState: VirtualRasterGpuState
    addressCodec: WebMercatorQuadAddressCodec
    policy: GpuTileFrontierPolicy
    levelMetrics: readonly GpuTileFrontierLevelMetric[]
    roots: readonly VirtualRasterPageIdentity[]
    drawTemplates: readonly GpuTileFrontierDrawTemplate[]
}>

export type GpuTileFrontierDemand = Readonly<{
    page: VirtualRasterPageIdentity
    parent: VirtualRasterPageIdentity
    parentCompactIndex: number
    parentPhysicalSlot: number
    parentGeneration: number
    priority: number
    decisionFrameEpoch: number
    residencySnapshotEpoch: number
    childMask: number
}>

export type GpuTileFrontierConvergenceState =
    | 'converged'
    | 'transitioning'
    | 'budget-limited'

export type GpuTileFrontierFacts = Readonly<{
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
    convergenceState: GpuTileFrontierConvergenceState
}>

type FrontierLayout = Readonly<{
    codec: LayoutCodec
    byteSize: number
    fieldOffsets: Readonly<Record<string, number>>
}>

export const gpuTileFrontierMapMetaCodec = layoutCodec({
    name: 'GpuTileFrontierMapMeta',
    fields: [
        { name: 'clipFromRelativeWorld', type: 'mat4x4f' },
        { name: 'cameraHigh', type: 'vec3f' },
        { name: 'cameraLow', type: 'vec3f' },
        { name: 'viewport', type: 'vec2f' },
        { name: 'verticalFovRadians', type: 'f32' },
        { name: 'cameraLatitudeRadians', type: 'f32' },
        { name: 'zoomHint', type: 'f32' },
        { name: 'frameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

export const gpuTileFrontierPolicyCodec = layoutCodec({
    name: 'GpuTileFrontierPolicy',
    fields: [
        { name: 'refineErrorPixels', type: 'f32' },
        { name: 'coarsenErrorPixels', type: 'f32' },
        { name: 'minimumMatrixLevel', type: 'u32' },
        { name: 'maximumMatrixLevel', type: 'u32' },
        { name: 'maximumActiveTiles', type: 'u32' },
        { name: 'maximumDemands', type: 'u32' },
        { name: 'transitionReservePages', type: 'u32' },
        { name: 'invisibleGraceFrames', type: 'u32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

export const gpuTileFrontierLevelMetricCodec = layoutCodec({
    name: 'GpuTileFrontierLevelMetric',
    fields: [
        { name: 'matrixLevel', type: 'u32' },
        { name: 'minimumElevationMeters', type: 'f32' },
        { name: 'maximumElevationMeters', type: 'f32' },
        { name: 'geometricErrorMeters', type: 'f32' },
    ],
})

export const gpuTileFrontierEntryCodec = layoutCodec({
    name: 'GpuTileFrontierEntry',
    fields: [
        { name: 'physicalSlot', type: 'u32' },
        { name: 'expectedGeneration', type: 'u32' },
        { name: 'samplingLevel', type: 'u32' },
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'compactIndex', type: 'u32' },
        { name: 'previousLodState', type: 'u32' },
        { name: 'transitionState', type: 'u32' },
        { name: 'lastDemandEpoch', type: 'u32' },
        { name: 'childDemandMask', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
    ],
})

export const gpuTileFrontierVisibleInstanceCodec = layoutCodec({
    name: 'GpuTileFrontierVisibleInstance',
    fields: [
        { name: 'physicalSlot', type: 'u32' },
        { name: 'expectedGeneration', type: 'u32' },
        { name: 'samplingLevel', type: 'u32' },
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'compactIndex', type: 'u32' },
        { name: 'contentEpoch', type: 'u32' },
    ],
})

export const gpuTileFrontierDemandCodec = layoutCodec({
    name: 'GpuTileFrontierDemand',
    fields: [
        { name: 'samplingLevel', type: 'u32' },
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'compactIndex', type: 'u32' },
        { name: 'parentCompactIndex', type: 'u32' },
        { name: 'parentPhysicalSlot', type: 'u32' },
        { name: 'parentGeneration', type: 'u32' },
        { name: 'priority', type: 'u32' },
        { name: 'decisionFrameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
        { name: 'childMask', type: 'u32' },
    ],
})

export const gpuTileFrontierDiagnosticsCodec = layoutCodec({
    name: 'GpuTileFrontierDiagnostics',
    fields: [
        { name: 'frameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
        { name: 'activeFrontierCount', type: 'u32' },
        { name: 'visibleInstanceCount', type: 'u32' },
        { name: 'refineCandidateCount', type: 'u32' },
        { name: 'coarsenCandidateCount', type: 'u32' },
        { name: 'demandCount', type: 'u32' },
        { name: 'fallbackCount', type: 'u32' },
        { name: 'staleGenerationCount', type: 'u32' },
        { name: 'budgetLimitedCount', type: 'u32' },
        { name: 'maximumObservedSse', type: 'f32' },
        { name: 'minimumSelectedMatrixLevel', type: 'u32' },
        { name: 'maximumSelectedMatrixLevel', type: 'u32' },
        { name: 'frontierOverflow', type: 'u32' },
        { name: 'demandOverflow', type: 'u32' },
        { name: 'visibleOverflow', type: 'u32' },
        { name: 'convergenceState', type: 'u32' },
        { name: 'reserved0', type: 'u32' },
        { name: 'reserved1', type: 'u32' },
        { name: 'reserved2', type: 'u32' },
    ],
})

export const gpuTileFrontierLayouts = Object.freeze({
    mapMeta: layoutFacts(gpuTileFrontierMapMetaCodec),
    policy: layoutFacts(gpuTileFrontierPolicyCodec),
    levelMetric: layoutFacts(gpuTileFrontierLevelMetricCodec),
    frontierEntry: layoutFacts(gpuTileFrontierEntryCodec),
    visibleInstance: layoutFacts(gpuTileFrontierVisibleInstanceCodec),
    demand: layoutFacts(gpuTileFrontierDemandCodec),
    diagnostics: layoutFacts(gpuTileFrontierDiagnosticsCodec),
})

export function gpuTileFrontierPolicy(
    input: GpuTileFrontierPolicy
): GpuTileFrontierPolicy {

    if (typeof input !== 'object' || input === null) {
        return invalidFrontier('GPU tile frontier policy requires an object.', {
            policy: 'GpuTileFrontierPolicy',
        }, input)
    }
    const finiteFields = [
        input.refineErrorPixels,
        input.coarsenErrorPixels,
        input.minimumMatrixLevel,
        input.maximumMatrixLevel,
        input.maximumActiveTiles,
        input.maximumDemands,
        input.transitionReservePages,
        input.invisibleGraceFrames,
    ]
    const integerFields = [
        input.minimumMatrixLevel,
        input.maximumMatrixLevel,
        input.maximumActiveTiles,
        input.maximumDemands,
        input.transitionReservePages,
        input.invisibleGraceFrames,
    ]
    if (finiteFields.some(value => !Number.isFinite(value)) ||
        integerFields.some(value => !Number.isSafeInteger(value)) ||
        input.coarsenErrorPixels < 0 ||
        input.refineErrorPixels <= input.coarsenErrorPixels ||
        input.minimumMatrixLevel < 0 ||
        input.maximumMatrixLevel < input.minimumMatrixLevel ||
        input.maximumActiveTiles <= 0 ||
        input.maximumDemands <= 0 ||
        input.transitionReservePages <= 0 ||
        input.invisibleGraceFrames < 0 ||
        input.maximumDemands > input.maximumActiveTiles * 4) {
        return invalidFrontier(
            'GPU tile frontier policy values are inconsistent or outside finite GPU bounds.',
            {
                finiteNumbers: true,
                coarsenErrorPixels: '[0, refineErrorPixels)',
                matrixLevels: 'non-negative ordered integers',
                capacities: 'positive integers',
                maximumDemands: '<= maximumActiveTiles * 4',
                invisibleGraceFrames: 'non-negative integer',
            },
            input
        )
    }
    return Object.freeze({ ...input })
}

export function validateGpuTileFrontierDescriptor(
    descriptor: GpuTileFrontierDescriptor
): void {

    if (typeof descriptor !== 'object' || descriptor === null) {
        return invalidFrontier('GPU tile frontier requires a descriptor object.', {
            descriptor: 'GpuTileFrontierDescriptor',
        }, descriptor)
    }
    const addressSpace = descriptor.gpuState?.addressSpace
    const coverage = descriptor.addressCodec?.coverage
    if (addressSpace?.kind !== 'virtual-raster-address-space' ||
        addressSpace.tileCoverage === undefined ||
        coverage === undefined ||
        addressSpace.tileCoverage !== coverage) {
        return invalidFrontier(
            'GPU tile frontier GPU state and WebMercatorQuad codec must share one tile coverage.',
            { addressSpace: 'tile-backed VirtualRasterAddressSpace', coverage: 'same object' },
            {
                addressSpaceKind: addressSpace?.kind,
                hasTileCoverage: addressSpace?.tileCoverage !== undefined,
                coverageMatches: addressSpace?.tileCoverage === coverage,
            }
        )
    }
    gpuTileFrontierPolicy(descriptor.policy)
    validateLevelMetrics(descriptor)
    validateRoots(descriptor)
    validateDrawTemplates(descriptor.drawTemplates)
}

function layoutFacts(codec: LayoutCodec): FrontierLayout {

    return Object.freeze({
        codec,
        byteSize: codec.byteLength(),
        fieldOffsets: Object.freeze(Object.fromEntries(codec.artifact.fields.map(field => [
            field.name,
            field.offset,
        ]))),
    })
}

function validateLevelMetrics(descriptor: GpuTileFrontierDescriptor): void {

    const expectedLevels = descriptor.policy.maximumMatrixLevel -
        descriptor.policy.minimumMatrixLevel + 1
    const seen = new Set<number>()
    if (!Array.isArray(descriptor.levelMetrics) ||
        descriptor.levelMetrics.length !== expectedLevels) {
        return invalidFrontier(
            'GPU tile frontier requires exactly one metric for every selected matrix level.',
            { levelMetricCount: expectedLevels },
            { levelMetricCount: descriptor.levelMetrics?.length }
        )
    }
    for (const metric of descriptor.levelMetrics) {
        if (!Number.isSafeInteger(metric.matrixLevel) ||
            metric.matrixLevel < descriptor.policy.minimumMatrixLevel ||
            metric.matrixLevel > descriptor.policy.maximumMatrixLevel ||
            seen.has(metric.matrixLevel) ||
            !Number.isFinite(metric.minimumElevationMeters) ||
            !Number.isFinite(metric.maximumElevationMeters) ||
            !Number.isFinite(metric.geometricErrorMeters) ||
            metric.maximumElevationMeters < metric.minimumElevationMeters ||
            metric.geometricErrorMeters < 0) {
            return invalidFrontier(
                'GPU tile frontier level metrics must be unique, finite, and ordered by valid matrix level.',
                { matrixLevels: [
                    descriptor.policy.minimumMatrixLevel,
                    descriptor.policy.maximumMatrixLevel,
                ] },
                metric
            )
        }
        seen.add(metric.matrixLevel)
    }
}

function validateRoots(descriptor: GpuTileFrontierDescriptor): void {

    if (!Array.isArray(descriptor.roots) || descriptor.roots.length === 0) {
        return invalidFrontier('GPU tile frontier requires at least one root page.', {
            roots: 'non-empty VirtualRasterPageIdentity[]',
        }, descriptor.roots)
    }
    const seen = new Set<string>()
    for (const root of descriptor.roots) {
        descriptor.gpuState.addressSpace.assertPage(root)
        const matrixLevel = Number(root.tile?.matrixId)
        if (root.tile === undefined ||
            matrixLevel !== descriptor.policy.minimumMatrixLevel ||
            seen.has(root.key)) {
            return invalidFrontier(
                'GPU tile frontier roots must be unique WebMercatorQuad pages at the minimum matrix level.',
                { matrixLevel: descriptor.policy.minimumMatrixLevel, unique: true },
                root
            )
        }
        seen.add(root.key)
    }
}

function validateDrawTemplates(templates: readonly GpuTileFrontierDrawTemplate[]): void {

    if (!Array.isArray(templates) || templates.length === 0) {
        return invalidFrontier('GPU tile frontier requires at least one draw template.', {
            drawTemplates: 'non-empty GpuTileFrontierDrawTemplate[]',
        }, templates)
    }
    const ids = new Set<string>()
    for (const template of templates) {
        if (typeof template.id !== 'string' || template.id.length === 0 ||
            ids.has(template.id) ||
            !positiveInteger(template.vertexCount) ||
            !optionalNonNegativeInteger(template.firstVertex) ||
            !optionalNonNegativeInteger(template.firstInstance)) {
            return invalidFrontier(
                'GPU tile frontier draw templates require unique ids and bounded integer draw fields.',
                { id: 'unique non-empty string', vertexCount: 'positive integer' },
                { drawTemplateId: template.id, drawTemplate: template }
            )
        }
        ids.add(template.id)
    }
}

function positiveInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}

function optionalNonNegativeInteger(value: number | undefined): boolean {

    return value === undefined || Number.isSafeInteger(value) && value >= 0
}

function invalidFrontier(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_INVALID',
        phase: 'selection',
        subject: { kind: 'gpu-tile-frontier' },
        message,
        expected,
        actual,
    })
}
