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

export function compareGpuTileFrontierPathOrder(
    left: Pick<VirtualRasterPageIdentity, 'tile'>,
    right: Pick<VirtualRasterPageIdentity, 'tile'>
): number {

    const leftTile = frontierPathTile(left)
    const rightTile = frontierPathTile(right)
    const commonDepth = Math.min(leftTile.matrixLevel, rightTile.matrixLevel)
    for (let depth = 0; depth < commonDepth; depth++) {
        const leftShift = leftTile.matrixLevel - depth - 1
        const rightShift = rightTile.matrixLevel - depth - 1
        const leftChild = pathChildOrdinal(
            leftTile.tileRow,
            leftTile.tileCol,
            leftShift
        )
        const rightChild = pathChildOrdinal(
            rightTile.tileRow,
            rightTile.tileCol,
            rightShift
        )
        if (leftChild !== rightChild) return leftChild - rightChild
    }
    return leftTile.matrixLevel - rightTile.matrixLevel
}

export function gpuTileFrontierPathIsPrefix(
    prefix: Pick<VirtualRasterPageIdentity, 'tile'>,
    candidate: Pick<VirtualRasterPageIdentity, 'tile'>
): boolean {

    const prefixTile = frontierPathTile(prefix)
    const candidateTile = frontierPathTile(candidate)
    if (prefixTile.matrixLevel > candidateTile.matrixLevel) return false
    const shift = candidateTile.matrixLevel - prefixTile.matrixLevel
    return Math.floor(candidateTile.tileRow / 2 ** shift) === prefixTile.tileRow &&
        Math.floor(candidateTile.tileCol / 2 ** shift) === prefixTile.tileCol
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
    if (!positiveInteger(descriptor.gpuState.maxPhysicalPages)) {
        return invalidFrontier(
            'GPU tile frontier physical-page capacity must fit a positive u32.',
            { maxPhysicalPages: 'positive u32' },
            { maxPhysicalPages: descriptor.gpuState.maxPhysicalPages }
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

    const matrixId = String(descriptor.policy.minimumMatrixLevel)
    const minimumLimit = descriptor.addressCodec.coverage.limit(matrixId)
    if (minimumLimit === undefined) {
        return invalidFrontier(
            'GPU tile frontier minimum matrix level must exist in its finite coverage.',
            { matrixId },
            { limits: descriptor.addressCodec.coverage.limits }
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
): Readonly<{ matrixLevel: number, tileRow: number, tileCol: number }> {

    const tile = page.tile
    if (tile === undefined) {
        return invalidFrontier(
            'GPU tile frontier path ordering requires tile-backed pages.',
            { tile: 'WebMercatorQuad tile' },
            page
        )
    }
    const matrixLevel = Number(tile.matrixId)
    const tileRow = tile.tileRow
    const tileCol = tile.tileCol
    if (!u32(matrixLevel) || !u32(tileRow) || !u32(tileCol)) {
        return invalidFrontier(
            'GPU tile frontier path ordering requires u32 tile coordinates.',
            { matrixLevel: 'u32', tileRow: 'u32', tileCol: 'u32' },
            tile
        )
    }
    return { matrixLevel, tileRow, tileCol }
}

function pathChildOrdinal(tileRow: number, tileCol: number, shift: number): number {

    const scale = 2 ** shift
    const rowBit = Math.floor(tileRow / scale) % 2
    const colBit = Math.floor(tileCol / scale) % 2
    return rowBit * 2 + colBit
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
