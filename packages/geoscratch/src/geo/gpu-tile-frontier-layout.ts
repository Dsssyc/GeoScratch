import { layoutCodec, type LayoutArtifact, type LayoutCodec } from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type { TileSpatialProfile } from './tile-spatial-profile.js'
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

export type GpuTileFrontierView = GeoViewSnapshot

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
    spatialProfile: TileSpatialProfile
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
    coarsenGracePendingCount: number
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

export type GpuTileFrontierRenderWgslOptions = Readonly<{
    namespace?: string
}>

export type GpuTileFrontierRenderWgslModule = Readonly<{
    code: string
    layoutDependencies: readonly LayoutArtifact[]
}>

export function compareGpuTileFrontierPathOrder(
    spatialProfile: TileSpatialProfile,
    left: Pick<VirtualRasterPageIdentity, 'tile'>,
    right: Pick<VirtualRasterPageIdentity, 'tile'>
): number {

    const leftTile = frontierPathTile(left)
    const rightTile = frontierPathTile(right)
    return spatialProfile.comparePath(leftTile, rightTile)
}

export function gpuTileFrontierPathIsPrefix(
    spatialProfile: TileSpatialProfile,
    prefix: Pick<VirtualRasterPageIdentity, 'tile'>,
    candidate: Pick<VirtualRasterPageIdentity, 'tile'>
): boolean {

    const prefixTile = frontierPathTile(prefix)
    const candidateTile = frontierPathTile(candidate)
    return spatialProfile.isPathPrefix(prefixTile, candidateTile)
}

type FrontierLayout = Readonly<{
    codec: LayoutCodec
    byteSize: number
    fieldOffsets: Readonly<Record<string, number>>
}>

const U32_MAX = 0xffff_ffff

export const gpuTileFrontierMapMetaCodec = layoutCodec({
    name: 'GpuTileFrontierMapMeta',
    fields: [
        { name: 'clipFromRelativeWorld', type: 'mat4x4f' },
        { name: 'cameraHigh', type: 'vec3f' },
        { name: 'cameraLow', type: 'vec3f' },
        { name: 'cameraFixedLow', type: 'vec2u' },
        { name: 'cameraFixedHigh', type: 'vec2u' },
        { name: 'viewport', type: 'vec2f' },
        { name: 'verticalFovRadians', type: 'f32' },
        { name: 'cameraLatitudeRadians', type: 'f32' },
        { name: 'zoomHint', type: 'f32' },
        { name: 'frameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
        { name: 'cameraPitchRadians', type: 'f32' },
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
        { name: 'expectedContentEpoch', type: 'u32' },
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

/** Produces WGSL accessors for map metadata and visible tile instances. */
export function gpuTileFrontierRenderWgslModule(
    options: GpuTileFrontierRenderWgslOptions = {}
): GpuTileFrontierRenderWgslModule {

    return Object.freeze({
        code: [
            gpuTileFrontierMapMetaCodec.wgslAccessors({ namespace: 'FrontierMapMeta' }),
            gpuTileFrontierVisibleInstanceCodec.wgslAccessors({
                namespace: options.namespace ?? 'FrontierVisible',
            }),
        ].join('\n'),
        layoutDependencies: Object.freeze([
            gpuTileFrontierMapMetaCodec.artifact,
            gpuTileFrontierVisibleInstanceCodec.artifact,
        ]),
    })
}

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
        { name: 'coarsenGracePendingCount', type: 'u32' },
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

/** Validates and freezes screen-error, distance, capacity, and transition policy. */
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
        integerFields.some(value => !u32(value)) ||
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
                matrixLevels: 'ordered u32 values',
                capacities: 'positive u32 values',
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
    validateSpatialProfile(descriptor.spatialProfile)
    const addressSpace = descriptor.gpuState?.addressSpace
    const coverage = descriptor.spatialProfile?.coverage
    if (addressSpace?.kind !== 'virtual-raster-address-space' ||
        addressSpace.tileCoverage === undefined ||
        coverage === undefined ||
        addressSpace.tileCoverage !== coverage) {
        return invalidFrontier(
            'GPU tile frontier GPU state and spatial profile must share one tile coverage.',
            { addressSpace: 'tile-backed VirtualRasterAddressSpace', coverage: 'same object' },
            {
                addressSpaceKind: addressSpace?.kind,
                hasTileCoverage: addressSpace?.tileCoverage !== undefined,
                coverageMatches: addressSpace?.tileCoverage === coverage,
            }
        )
    }
    if (!positiveInteger(descriptor.gpuState.maxPhysicalPages)) {
        return invalidFrontier(
            'GPU tile frontier physical-page capacity must fit a positive u32.',
            { maxPhysicalPages: 'positive u32' },
            { maxPhysicalPages: descriptor.gpuState.maxPhysicalPages }
        )
    }
    gpuTileFrontierPolicy(descriptor.policy)
    const profileMaximumMatrixLevel = descriptor.spatialProfile.topology
        .tileMatrixSet.tileMatrices.length - 1
    const encoding = descriptor.spatialProfile.frontierEncoding
    if (descriptor.policy.minimumMatrixLevel > profileMaximumMatrixLevel ||
        descriptor.policy.maximumMatrixLevel > profileMaximumMatrixLevel ||
        descriptor.policy.maximumMatrixLevel + encoding.rootColumnBits >
            encoding.coordinateBits ||
        descriptor.policy.maximumMatrixLevel + encoding.rootRowBits >
            encoding.coordinateBits) {
        return invalidFrontier(
            'GPU tile frontier matrix levels must fit the spatial profile and its fixed-coordinate encoding.',
            {
                maximumMatrixLevel: profileMaximumMatrixLevel,
                maximumColumnEncodingLevel:
                    encoding.coordinateBits - encoding.rootColumnBits,
                maximumRowEncodingLevel: encoding.coordinateBits - encoding.rootRowBits,
            },
            descriptor.policy
        )
    }
    validateLevelMetrics(descriptor)
    validateRoots(descriptor)
    validateDrawTemplates(descriptor.drawTemplates)
}

function validateSpatialProfile(profile: TileSpatialProfile): void {

    const encoding = profile?.frontierEncoding
    const validTuple = (value: unknown): value is readonly [number, number] =>
        Array.isArray(value) && value.length === 2 &&
        value.every(item => Number.isFinite(item) && item > 0)
    if (profile?.kind !== 'tile-spatial-profile' || profile.coordinateFrame !== 'planar' ||
        profile.topology?.kind !== 'tile-topology' ||
        profile.coverage?.tileMatrixSet !== profile.topology.tileMatrixSet ||
        !Number.isSafeInteger(profile.coordinateBits) ||
        profile.coordinateBits < 32 || profile.coordinateBits > 52 ||
        encoding?.coordinateBits !== profile.coordinateBits ||
        !Number.isSafeInteger(encoding.rootColumnBits) || encoding.rootColumnBits < 0 ||
        !Number.isSafeInteger(encoding.rootRowBits) || encoding.rootRowBits < 0 ||
        !validTuple(encoding.quantumMeters) || !validTuple(encoding.highLimbMeters) ||
        typeof profile.matrixLevel !== 'function' || typeof profile.matrixId !== 'function' ||
        typeof profile.tileBounds !== 'function' || typeof profile.normalizedBounds !== 'function' ||
        typeof profile.parent !== 'function' || typeof profile.children !== 'function' ||
        typeof profile.coveredChildren !== 'function' || typeof profile.path !== 'function' ||
        typeof profile.comparePath !== 'function' ||
        typeof profile.isPathPrefix !== 'function' || typeof profile.encodeCamera !== 'function') {
        return invalidFrontier(
            'GPU tile frontier requires one complete planar TileSpatialProfile.',
            {
                kind: 'tile-spatial-profile',
                coordinateFrame: 'planar',
                topologyCoverage: 'same TileMatrixSet object',
                frontierEncoding: 'finite positive two-axis fixed-coordinate facts',
            },
            profile
        )
    }
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
    if (!Array.isArray(descriptor.levelMetrics) ||
        descriptor.levelMetrics.length !== expectedLevels) {
        return invalidFrontier(
            'GPU tile frontier requires exactly one metric for every selected matrix level.',
            { levelMetricCount: expectedLevels },
            { levelMetricCount: descriptor.levelMetrics?.length }
        )
    }
    for (let index = 0; index < descriptor.levelMetrics.length; index++) {
        const metric = descriptor.levelMetrics[index]!
        const expectedMatrixLevel = descriptor.policy.minimumMatrixLevel + index
        if (!u32(metric.matrixLevel) ||
            metric.matrixLevel !== expectedMatrixLevel ||
            !Number.isFinite(metric.minimumElevationMeters) ||
            !Number.isFinite(metric.maximumElevationMeters) ||
            !Number.isFinite(metric.geometricErrorMeters) ||
            metric.maximumElevationMeters < metric.minimumElevationMeters ||
            metric.geometricErrorMeters < 0) {
            return invalidFrontier(
                'GPU tile frontier level metrics must be unique, finite, and ordered by valid matrix level.',
                { matrixLevel: expectedMatrixLevel, index },
                metric
            )
        }
    }
}

function validateRoots(descriptor: GpuTileFrontierDescriptor): void {

    const matrixId = descriptor.spatialProfile.matrixId(
        descriptor.policy.minimumMatrixLevel
    )
    const minimumLimit = descriptor.spatialProfile.coverage.limit(matrixId)
    if (minimumLimit === undefined) {
        return invalidFrontier(
            'GPU tile frontier minimum matrix level must exist in its finite coverage.',
            { matrixId },
            { limits: descriptor.spatialProfile.coverage.limits }
        )
    }
    const width = minimumLimit.maxTileCol - minimumLimit.minTileCol + 1
    const expectedRootCount = width *
        (minimumLimit.maxTileRow - minimumLimit.minTileRow + 1)
    if (!Array.isArray(descriptor.roots) ||
        descriptor.roots.length !== expectedRootCount) {
        return invalidFrontier(
            'GPU tile frontier roots must exactly cover the complete minimum matrix level.',
            { rootCount: expectedRootCount, limit: minimumLimit },
            { rootCount: Array.isArray(descriptor.roots)
                ? descriptor.roots.length
                : undefined }
        )
    }
    if (expectedRootCount > descriptor.policy.maximumActiveTiles) {
        return invalidFrontier(
            'GPU tile frontier active capacity must hold the complete minimum-level root cover.',
            { maximumActiveTiles: `>= ${expectedRootCount}` },
            { maximumActiveTiles: descriptor.policy.maximumActiveTiles, expectedRootCount }
        )
    }
    const expectedRootKeys = new Set<string>()
    for (let row = minimumLimit.minTileRow; row <= minimumLimit.maxTileRow; row++) {
        for (let col = minimumLimit.minTileCol; col <= minimumLimit.maxTileCol; col++) {
            expectedRootKeys.add(descriptor.gpuState.addressSpace.pageFromTile({
                matrixId,
                tileRow: row,
                tileCol: col,
            }).key)
        }
    }
    for (const root of descriptor.roots) {
        try {
            descriptor.gpuState.addressSpace.assertPage(root)
        } catch {
            return invalidFrontier(
                'GPU tile frontier roots must belong to the descriptor address space.',
                { addressSpaceId: descriptor.gpuState.addressSpace.id },
                root
            )
        }
        if (!expectedRootKeys.delete(root.key)) {
            return invalidFrontier(
                'GPU tile frontier roots must be a unique complete minimum-level set.',
                { matrixId, limit: minimumLimit },
                { root: root.key }
            )
        }
    }
}

function frontierPathTile(
    page: Pick<VirtualRasterPageIdentity, 'tile'>
): NonNullable<VirtualRasterPageIdentity['tile']> {

    const tile = page.tile
    if (tile === undefined) {
        return invalidFrontier(
            'GPU tile frontier path ordering requires tile-backed pages.',
            { tile: 'tile-backed page identity' },
            page
        )
    }
    if (!u32(tile.tileRow) || !u32(tile.tileCol)) {
        return invalidFrontier(
            'GPU tile frontier path ordering requires u32 tile coordinates.',
            { tileRow: 'u32', tileCol: 'u32' },
            tile
        )
    }
    return tile
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

    return u32(value) && value > 0
}

function optionalNonNegativeInteger(value: number | undefined): boolean {

    return value === undefined || u32(value)
}

function u32(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= U32_MAX
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
