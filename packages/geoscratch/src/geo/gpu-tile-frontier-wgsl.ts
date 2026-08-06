import type { LayoutArtifact } from '../scratch/index.js'
import {
    gpuTileFrontierDemandCodec,
    gpuTileFrontierDiagnosticsCodec,
    gpuTileFrontierEntryCodec,
    gpuTileFrontierLevelMetricCodec,
    gpuTileFrontierMapMetaCodec,
    gpuTileFrontierPolicyCodec,
    gpuTileFrontierVisibleInstanceCodec,
    type GpuTileFrontierDescriptor,
} from './gpu-tile-frontier-layout.js'

export const GPU_TILE_FRONTIER_WORKGROUP_SIZE = 64
export const GPU_TILE_FRONTIER_SCAN_BLOCK_SIZE = 64

export const gpuTileFrontierEntryPoints = Object.freeze([
    'resetFrontier',
    'clearLookup',
    'buildLookup',
    'evaluateFrontier',
    'selectBudgets',
    'resolveTransitions',
    'balanceNeighbors',
    'scanBlocks',
    'scanBlockSums',
    'addScanOffsets',
    'compactOutputs',
    'finalizeArguments',
] as const)

export type GpuTileFrontierEntryPoint = typeof gpuTileFrontierEntryPoints[number]

export const gpuTileFrontierWgslBindings = Object.freeze({
    mapMeta: 0,
    policy: 1,
    levelMetrics: 2,
    currentFrontier: 3,
    nextFrontier: 4,
    slotTable: 5,
    lookupWrite: 6,
    lookupRead: 7,
    currentDispatchArguments: 8,
    visibilityFlags: 9,
    decisionWrite: 10,
    decisionRead: 11,
    prefixWrite: 12,
    prefixRead: 13,
    visibleOutput: 14,
    demandOutput: 15,
    retireOutput: 16,
    countersWrite: 17,
    countersRead: 18,
    diagnosticsOutput: 19,
    drawArgumentsOutput: 20,
    nextDispatchArguments: 21,
    pageTable: 22,
})

export type GpuTileFrontierWgslModule = Readonly<{
    code: string
    entryPoints: readonly GpuTileFrontierEntryPoint[]
    layoutDependencies: readonly LayoutArtifact[]
}>

const layoutDependencies = Object.freeze([
    gpuTileFrontierMapMetaCodec.artifact,
    gpuTileFrontierPolicyCodec.artifact,
    gpuTileFrontierLevelMetricCodec.artifact,
    gpuTileFrontierEntryCodec.artifact,
    gpuTileFrontierVisibleInstanceCodec.artifact,
    gpuTileFrontierDemandCodec.artifact,
    gpuTileFrontierDiagnosticsCodec.artifact,
])

export function createGpuTileFrontierWgsl(
    descriptor: GpuTileFrontierDescriptor,
    lookupCapacity: number,
    scanBlockCount: number
): GpuTileFrontierWgslModule {

    const levels = descriptor.levelMetrics.map(metric => metric.matrixLevel)
    const quantumMeters = descriptor.addressCodec.quantumMeters
    const highLimbMeters = quantumMeters * 2 ** 32
    const limits = levels.map(matrixLevel => {
        const limit = descriptor.addressCodec.coverage.limit(String(matrixLevel))
        if (limit === undefined) throw new TypeError('GPU tile frontier WGSL coverage is incomplete.')
        return {
            offset: descriptor.addressCodec.coverage.index({
                matrixId: limit.matrixId,
                tileRow: limit.minTileRow,
                tileCol: limit.minTileCol,
            }),
            minimumRow: limit.minTileRow,
            maximumRow: limit.maxTileRow,
            minimumColumn: limit.minTileCol,
            maximumColumn: limit.maxTileCol,
            width: limit.maxTileCol - limit.minTileCol + 1,
        }
    })
    const drawTemplates = descriptor.drawTemplates
    const declarations = [
        gpuTileFrontierMapMetaCodec.wgslAccessors({ namespace: 'FrontierMapMeta' }),
        gpuTileFrontierPolicyCodec.wgslAccessors({ namespace: 'FrontierPolicy' }),
        gpuTileFrontierLevelMetricCodec.wgslAccessors({ namespace: 'FrontierLevelMetric' }),
        gpuTileFrontierEntryCodec.wgslAccessors({ namespace: 'FrontierEntry' }),
        gpuTileFrontierVisibleInstanceCodec.wgslAccessors({ namespace: 'FrontierVisible' }),
        gpuTileFrontierDemandCodec.wgslAccessors({ namespace: 'FrontierDemand' }),
        gpuTileFrontierDiagnosticsCodec.wgslAccessors({ namespace: 'FrontierDiagnostics' }),
    ].join('\n')
    const code = `${declarations}

const FRONTIER_WORKGROUP_SIZE: u32 = ${GPU_TILE_FRONTIER_WORKGROUP_SIZE}u;
const FRONTIER_SCAN_BLOCK_SIZE: u32 = ${GPU_TILE_FRONTIER_SCAN_BLOCK_SIZE}u;
const FRONTIER_ACTIVE_CAPACITY: u32 = ${descriptor.policy.maximumActiveTiles}u;
const FRONTIER_DEMAND_CAPACITY: u32 = ${descriptor.policy.maximumDemands}u;
const FRONTIER_SLOT_CAPACITY: u32 = ${descriptor.gpuState.maxPhysicalPages}u;
const FRONTIER_LOOKUP_CAPACITY: u32 = ${lookupCapacity}u;
const FRONTIER_SCAN_BLOCK_COUNT: u32 = ${scanBlockCount}u;
const FRONTIER_LEVEL_COUNT: u32 = ${levels.length}u;
const FRONTIER_DRAW_TEMPLATE_COUNT: u32 = ${drawTemplates.length}u;
const FRONTIER_INVALID_U32: u32 = 0xffffffffu;
const FRONTIER_PI: f32 = 3.141592653589793;
const FRONTIER_COORDINATE_BITS: u32 = ${descriptor.addressCodec.coordinateBits}u;
const FRONTIER_QUANTUM_METERS: f32 = ${f32Literal(quantumMeters)};
const FRONTIER_HIGH_LIMB_METERS: f32 = ${f32Literal(highLimbMeters)};

const FRONTIER_COVERAGE_OFFSETS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.offset))});
const FRONTIER_COVERAGE_MIN_ROWS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.minimumRow))});
const FRONTIER_COVERAGE_MAX_ROWS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.maximumRow))});
const FRONTIER_COVERAGE_MIN_COLUMNS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.minimumColumn))});
const FRONTIER_COVERAGE_MAX_COLUMNS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.maximumColumn))});
const FRONTIER_COVERAGE_WIDTHS: array<u32, ${levels.length}> = array<u32, ${levels.length}>(${u32List(limits.map(limit => limit.width))});
const FRONTIER_DRAW_VERTEX_COUNTS: array<u32, ${drawTemplates.length}> = array<u32, ${drawTemplates.length}>(${u32List(drawTemplates.map(template => template.vertexCount))});
const FRONTIER_DRAW_FIRST_VERTICES: array<u32, ${drawTemplates.length}> = array<u32, ${drawTemplates.length}>(${u32List(drawTemplates.map(template => template.firstVertex ?? 0))});
const FRONTIER_DRAW_FIRST_INSTANCES: array<u32, ${drawTemplates.length}> = array<u32, ${drawTemplates.length}>(${u32List(drawTemplates.map(template => template.firstInstance ?? 0))});

const SLOT_STRIDE: u32 = 12u;
const SLOT_VALID: u32 = 0u;
const SLOT_SAMPLING_LEVEL: u32 = 1u;
const SLOT_MATRIX_LEVEL: u32 = 2u;
const SLOT_TILE_ROW: u32 = 3u;
const SLOT_TILE_COLUMN: u32 = 4u;
const SLOT_COMPACT_INDEX: u32 = 5u;
const SLOT_PHYSICAL_SLOT: u32 = 6u;
const SLOT_GENERATION: u32 = 7u;
const SLOT_CONTENT_EPOCH: u32 = 8u;
const SLOT_SNAPSHOT_EPOCH: u32 = 9u;

const LOOKUP_STRIDE: u32 = 4u;
const LOOKUP_KEY: u32 = 0u;
const LOOKUP_INDEX: u32 = 1u;
const LOOKUP_EPOCH: u32 = 2u;

const DECISION_STRIDE: u32 = 18u;
const DECISION_TRANSITION: u32 = 0u;
const DECISION_PRIORITY: u32 = 1u;
const DECISION_ACCEPTED: u32 = 2u;
const DECISION_MISSING_CHILD_MASK: u32 = 3u;
const DECISION_NEXT_COUNT: u32 = 4u;
const DECISION_VISIBLE_COUNT: u32 = 5u;
const DECISION_DEMAND_COUNT: u32 = 6u;
const DECISION_RETIRE_COUNT: u32 = 7u;
const DECISION_TRANSITION_VISIBLE_EPOCH: u32 = 8u;
const DECISION_BALANCE_REJECTED: u32 = 9u;
const DECISION_SSE_BITS: u32 = 10u;
const DECISION_VISIBLE_FLAG: u32 = 11u;
const DECISION_CANDIDATE: u32 = 12u;
const DECISION_BLOCKED: u32 = 13u;
const DECISION_COVERED_CHILD_COUNT: u32 = 14u;
const DECISION_LIVE_REFINE: u32 = 15u;
const DECISION_BASE_PRIORITY: u32 = 16u;
const DECISION_COARSEN_GRACE_PENDING: u32 = 17u;

const PREFIX_STRIDE: u32 = 8u;
const PREFIX_NEXT: u32 = 0u;
const PREFIX_VISIBLE: u32 = 1u;
const PREFIX_DEMAND: u32 = 2u;
const PREFIX_RETIRE: u32 = 3u;
const PREFIX_BLOCK_BASE: u32 = FRONTIER_ACTIVE_CAPACITY * PREFIX_STRIDE;
const PREFIX_CURRENT_COUNT: u32 = 4u;

const COUNTER_CURRENT_COUNT: u32 = 0u;
const COUNTER_NEXT_COUNT: u32 = 1u;
const COUNTER_VISIBLE_COUNT: u32 = 2u;
const COUNTER_REFINE_COUNT: u32 = 3u;
const COUNTER_COARSEN_COUNT: u32 = 4u;
const COUNTER_DEMAND_COUNT: u32 = 5u;
const COUNTER_RETIRE_COUNT: u32 = 6u;
const COUNTER_STALE_COUNT: u32 = 7u;
const COUNTER_BUDGET_LIMITED_COUNT: u32 = 8u;
const COUNTER_MAXIMUM_SSE_BITS: u32 = 9u;
const COUNTER_MINIMUM_LEVEL: u32 = 10u;
const COUNTER_MAXIMUM_LEVEL: u32 = 11u;
const COUNTER_FRONTIER_OVERFLOW: u32 = 12u;
const COUNTER_DEMAND_OVERFLOW: u32 = 13u;
const COUNTER_VISIBLE_OVERFLOW: u32 = 14u;
const COUNTER_LOOKUP_DUPLICATE: u32 = 15u;
const COUNTER_BALANCE_REJECTED: u32 = 16u;
const COUNTER_FRAME_EPOCH: u32 = 17u;
const COUNTER_SNAPSHOT_EPOCH: u32 = 18u;
const COUNTER_FALLBACK_COUNT: u32 = 19u;
const COUNTER_ACCEPTED_REFINE: u32 = 20u;
const COUNTER_ACCEPTED_COARSEN: u32 = 21u;
const COUNTER_COARSEN_GRACE_PENDING: u32 = 22u;
const COUNTER_LAST: u32 = COUNTER_COARSEN_GRACE_PENDING;

const TRANSITION_RETAIN: u32 = 0u;
const TRANSITION_REFINE: u32 = 1u;
const TRANSITION_COARSEN: u32 = 2u;
const TRANSITION_STALE: u32 = 3u;
const PAGE_TABLE_STRIDE: u32 = 8u;
const PAGE_TABLE_STATUS: u32 = 3u;
const PAGE_TABLE_SNAPSHOT_EPOCH: u32 = 7u;

@group(0) @binding(${gpuTileFrontierWgslBindings.mapMeta}) var<uniform> mapMeta: GpuTileFrontierMapMeta;
@group(0) @binding(${gpuTileFrontierWgslBindings.policy}) var<uniform> selectionPolicy: GpuTileFrontierPolicy;
@group(0) @binding(${gpuTileFrontierWgslBindings.levelMetrics}) var<storage, read> levelMetrics: array<GpuTileFrontierLevelMetric>;
@group(0) @binding(${gpuTileFrontierWgslBindings.currentFrontier}) var<storage, read> currentFrontier: array<GpuTileFrontierEntry>;
@group(0) @binding(${gpuTileFrontierWgslBindings.nextFrontier}) var<storage, read_write> nextFrontier: array<GpuTileFrontierEntry>;
@group(0) @binding(${gpuTileFrontierWgslBindings.slotTable}) var<storage, read> residentSlots: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.lookupWrite}) var<storage, read_write> frontierLookupWrite: array<atomic<u32>>;
@group(0) @binding(${gpuTileFrontierWgslBindings.lookupRead}) var<storage, read> frontierLookupRead: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.currentDispatchArguments}) var<storage, read_write> currentDispatchArguments: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.visibilityFlags}) var<storage, read_write> visibilityFlags: array<atomic<u32>>;
@group(0) @binding(${gpuTileFrontierWgslBindings.decisionWrite}) var<storage, read_write> decisionWrite: array<atomic<u32>>;
@group(0) @binding(${gpuTileFrontierWgslBindings.decisionRead}) var<storage, read> decisionRead: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.prefixWrite}) var<storage, read_write> prefixWrite: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.prefixRead}) var<storage, read> prefixRead: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.visibleOutput}) var<storage, read_write> visibleOutput: array<GpuTileFrontierVisibleInstance>;
@group(0) @binding(${gpuTileFrontierWgslBindings.demandOutput}) var<storage, read_write> demandOutput: array<GpuTileFrontierDemand>;
@group(0) @binding(${gpuTileFrontierWgslBindings.retireOutput}) var<storage, read_write> retireOutput: array<GpuTileFrontierEntry>;
@group(0) @binding(${gpuTileFrontierWgslBindings.countersWrite}) var<storage, read_write> countersWrite: array<atomic<u32>>;
@group(0) @binding(${gpuTileFrontierWgslBindings.countersRead}) var<storage, read> countersRead: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.diagnosticsOutput}) var<storage, read_write> diagnosticsOutput: GpuTileFrontierDiagnostics;
@group(0) @binding(${gpuTileFrontierWgslBindings.drawArgumentsOutput}) var<storage, read_write> drawArgumentsOutput: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.nextDispatchArguments}) var<storage, read_write> nextDispatchArguments: array<u32>;
@group(0) @binding(${gpuTileFrontierWgslBindings.pageTable}) var<storage, read> virtualPageTable: array<u32>;

struct FrontierBounds {
    minimum: vec3f,
    maximum: vec3f,
}

struct FrontierQuanta {
    low: u32,
    high: u32,
}

struct FrontierPlane {
    normal: vec3f,
    distance: f32,
}

fn decisionOffset(index: u32, field: u32) -> u32 {
    return index * DECISION_STRIDE + field;
}

fn prefixOffset(index: u32, field: u32) -> u32 {
    return index * PREFIX_STRIDE + field;
}

fn coverageLevelIndex(matrixLevel: u32) -> u32 {
    return matrixLevel - selectionPolicy.minimumMatrixLevel;
}

fn tileWithinCoverage(matrixLevel: u32, row: u32, column: u32) -> bool {
    if (matrixLevel < selectionPolicy.minimumMatrixLevel || matrixLevel > selectionPolicy.maximumMatrixLevel) {
        return false;
    }
    let levelIndex = coverageLevelIndex(matrixLevel);
    return row >= FRONTIER_COVERAGE_MIN_ROWS[levelIndex] &&
        row <= FRONTIER_COVERAGE_MAX_ROWS[levelIndex] &&
        column >= FRONTIER_COVERAGE_MIN_COLUMNS[levelIndex] &&
        column <= FRONTIER_COVERAGE_MAX_COLUMNS[levelIndex];
}

fn compactIndexFor(matrixLevel: u32, row: u32, column: u32) -> u32 {
    let levelIndex = coverageLevelIndex(matrixLevel);
    return FRONTIER_COVERAGE_OFFSETS[levelIndex] +
        (row - FRONTIER_COVERAGE_MIN_ROWS[levelIndex]) * FRONTIER_COVERAGE_WIDTHS[levelIndex] +
        column - FRONTIER_COVERAGE_MIN_COLUMNS[levelIndex];
}

fn samplingLevelFor(matrixLevel: u32) -> u32 {
    return selectionPolicy.maximumMatrixLevel - matrixLevel;
}

fn slotBase(slot: u32) -> u32 {
    return slot * SLOT_STRIDE;
}

fn residentSlotFor(matrixLevel: u32, row: u32, column: u32, snapshotEpoch: u32) -> u32 {
    if (!tileWithinCoverage(matrixLevel, row, column)) {
        return FRONTIER_INVALID_U32;
    }
    for (var slot = 0u; slot < FRONTIER_SLOT_CAPACITY; slot += 1u) {
        let base = slotBase(slot);
        if (residentSlots[base + SLOT_VALID] == 1u &&
            residentSlots[base + SLOT_MATRIX_LEVEL] == matrixLevel &&
            residentSlots[base + SLOT_TILE_ROW] == row &&
            residentSlots[base + SLOT_TILE_COLUMN] == column &&
            residentSlots[base + SLOT_SNAPSHOT_EPOCH] == snapshotEpoch) {
            return slot;
        }
    }
    return FRONTIER_INVALID_U32;
}

fn currentEntryValid(entry: GpuTileFrontierEntry) -> bool {
    if (entry.physicalSlot >= FRONTIER_SLOT_CAPACITY ||
        entry.residencySnapshotEpoch > mapMeta.residencySnapshotEpoch) {
        return false;
    }
    let base = slotBase(entry.physicalSlot);
    return residentSlots[base + SLOT_VALID] == 1u &&
        residentSlots[base + SLOT_PHYSICAL_SLOT] == entry.physicalSlot &&
        residentSlots[base + SLOT_GENERATION] == entry.expectedGeneration &&
        residentSlots[base + SLOT_CONTENT_EPOCH] == entry.expectedContentEpoch &&
        residentSlots[base + SLOT_SAMPLING_LEVEL] == entry.samplingLevel &&
        residentSlots[base + SLOT_MATRIX_LEVEL] == entry.matrixLevel &&
        residentSlots[base + SLOT_TILE_ROW] == entry.tileRow &&
        residentSlots[base + SLOT_TILE_COLUMN] == entry.tileCol &&
        residentSlots[base + SLOT_COMPACT_INDEX] == entry.compactIndex &&
        residentSlots[base + SLOT_SNAPSHOT_EPOCH] == mapMeta.residencySnapshotEpoch;
}

fn lookupHash(key: u32) -> u32 {
    return (key * 2654435761u) & (FRONTIER_LOOKUP_CAPACITY - 1u);
}

fn lookupIndex(key: u32) -> u32 {
    var slot = lookupHash(key);
    for (var probe = 0u; probe < FRONTIER_LOOKUP_CAPACITY; probe += 1u) {
        let base = slot * LOOKUP_STRIDE;
        let storedKey = frontierLookupRead[base + LOOKUP_KEY];
        if (storedKey == key && frontierLookupRead[base + LOOKUP_EPOCH] == mapMeta.frameEpoch) {
            return frontierLookupRead[base + LOOKUP_INDEX];
        }
        if (storedKey == FRONTIER_INVALID_U32) {
            return FRONTIER_INVALID_U32;
        }
        slot = (slot + 1u) & (FRONTIER_LOOKUP_CAPACITY - 1u);
    }
    return FRONTIER_INVALID_U32;
}

fn metricFor(matrixLevel: u32) -> GpuTileFrontierLevelMetric {
    return levelMetrics[coverageLevelIndex(matrixLevel)];
}

fn subtractExpansions(
    leftHigh: f32,
    leftLow: f32,
    rightHigh: f32,
    rightLow: f32
) -> f32 {
    let lowDifference = leftLow - rightLow;
    if (leftHigh == rightHigh) {
        return lowDifference;
    }
    let difference = leftHigh - rightHigh;
    let bridge = difference - leftHigh;
    let roundoff = (leftHigh - (difference - bridge)) - (rightHigh + bridge);
    return difference + (roundoff + leftLow - rightLow);
}

fn boundaryQuanta(index: u32, matrixLevel: u32) -> FrontierQuanta {
    let shift = FRONTIER_COORDINATE_BITS - matrixLevel;
    if (shift >= 32u) {
        return FrontierQuanta(0u, index << (shift - 32u));
    }
    if (shift == 0u) {
        return FrontierQuanta(index, 0u);
    }
    return FrontierQuanta(index << shift, index >> (32u - shift));
}

fn subtractQuanta(left: FrontierQuanta, right: FrontierQuanta) -> FrontierQuanta {
    let borrow = select(0u, 1u, left.low < right.low);
    return FrontierQuanta(left.low - right.low, left.high - right.high - borrow);
}

fn quantaMagnitude(value: FrontierQuanta) -> FrontierQuanta {
    if ((value.high & 0x80000000u) == 0u) {
        return value;
    }
    let low = ~value.low + 1u;
    let carry = select(0u, 1u, low == 0u);
    return FrontierQuanta(low, ~value.high + carry);
}

fn relativeQuantaMeters(left: FrontierQuanta, right: FrontierQuanta) -> f32 {
    let difference = subtractQuanta(left, right);
    let negative = (difference.high & 0x80000000u) != 0u;
    let magnitude = quantaMagnitude(difference);
    let meters = f32(magnitude.high) * FRONTIER_HIGH_LIMB_METERS +
        f32(magnitude.low) * FRONTIER_QUANTUM_METERS;
    return select(meters, -meters, negative);
}

fn boundsFor(matrixLevel: u32, row: u32, column: u32) -> FrontierBounds {
    let metric = metricFor(matrixLevel);
    let west = boundaryQuanta(column, matrixLevel);
    let east = boundaryQuanta(column + 1u, matrixLevel);
    let north = boundaryQuanta(row, matrixLevel);
    let south = boundaryQuanta(row + 1u, matrixLevel);
    let cameraX = FrontierQuanta(mapMeta.cameraFixedLow.x, mapMeta.cameraFixedHigh.x);
    let cameraY = FrontierQuanta(mapMeta.cameraFixedLow.y, mapMeta.cameraFixedHigh.y);
    let minimumX = relativeQuantaMeters(west, cameraX);
    let maximumX = relativeQuantaMeters(east, cameraX);
    let maximumY = relativeQuantaMeters(cameraY, north);
    let minimumY = relativeQuantaMeters(cameraY, south);
    let minimumZ = subtractExpansions(
        metric.minimumElevationMeters,
        0.0,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z
    );
    let maximumZ = subtractExpansions(
        metric.maximumElevationMeters,
        0.0,
        mapMeta.cameraHigh.z,
        mapMeta.cameraLow.z
    );
    return FrontierBounds(
        vec3f(minimumX, minimumY, minimumZ),
        vec3f(maximumX, maximumY, maximumZ)
    );
}

fn normalizedPlane(equation: vec4f) -> FrontierPlane {
    let magnitude = max(length(equation.xyz), 1e-20);
    return FrontierPlane(equation.xyz / magnitude, equation.w / magnitude);
}

fn frustumPlane(index: u32) -> FrontierPlane {
    let matrix = mapMeta.clipFromRelativeWorld;
    let row0 = vec4f(matrix[0].x, matrix[1].x, matrix[2].x, matrix[3].x);
    let row1 = vec4f(matrix[0].y, matrix[1].y, matrix[2].y, matrix[3].y);
    let row2 = vec4f(matrix[0].z, matrix[1].z, matrix[2].z, matrix[3].z);
    let row3 = vec4f(matrix[0].w, matrix[1].w, matrix[2].w, matrix[3].w);
    switch index {
        case 0u: { return normalizedPlane(row3 + row0); }
        case 1u: { return normalizedPlane(row3 - row0); }
        case 2u: { return normalizedPlane(row3 + row1); }
        case 3u: { return normalizedPlane(row3 - row1); }
        case 4u: { return normalizedPlane(row2); }
        default: { return normalizedPlane(row3 - row2); }
    }
}

fn webGpuClipVisible(bounds: FrontierBounds) -> bool {
    for (var index = 0u; index < 6u; index += 1u) {
        let plane = frustumPlane(index);
        let positive = vec3f(
            select(bounds.minimum.x, bounds.maximum.x, plane.normal.x >= 0.0),
            select(bounds.minimum.y, bounds.maximum.y, plane.normal.y >= 0.0),
            select(bounds.minimum.z, bounds.maximum.z, plane.normal.z >= 0.0)
        );
        if (dot(plane.normal, positive) + plane.distance < 0.0) {
            return false;
        }
    }
    return true;
}

fn intervalDistance(minimum: f32, maximum: f32) -> f32 {
    if (0.0 < minimum) { return minimum; }
    if (0.0 > maximum) { return -maximum; }
    return 0.0;
}

fn distanceToAabb(bounds: FrontierBounds) -> f32 {
    let delta = vec3f(
        intervalDistance(bounds.minimum.x, bounds.maximum.x),
        intervalDistance(bounds.minimum.y, bounds.maximum.y),
        intervalDistance(bounds.minimum.z, bounds.maximum.z)
    );
    return length(delta);
}

fn screenSpaceError(matrixLevel: u32, bounds: FrontierBounds) -> f32 {
    let distance = max(distanceToAabb(bounds), 1e-6);
    let denominator = 2.0 * tan(mapMeta.verticalFovRadians * 0.5) * distance;
    return metricFor(matrixLevel).geometricErrorMeters * mapMeta.viewport.y / denominator;
}

fn projectedArea(bounds: FrontierBounds) -> f32 {
    var minimum = vec2f(1.0);
    var maximum = vec2f(-1.0);
    var projectedCount = 0u;
    for (var corner = 0u; corner < 8u; corner += 1u) {
        let point = vec3f(
            select(bounds.minimum.x, bounds.maximum.x, (corner & 1u) != 0u),
            select(bounds.minimum.y, bounds.maximum.y, (corner & 2u) != 0u),
            select(bounds.minimum.z, bounds.maximum.z, (corner & 4u) != 0u)
        );
        let clip = mapMeta.clipFromRelativeWorld * vec4f(point, 1.0);
        if (clip.w == 0.0) { continue; }
        let ndc = clamp(clip.xy / clip.w, vec2f(-1.0), vec2f(1.0));
        minimum = min(minimum, ndc);
        maximum = max(maximum, ndc);
        projectedCount += 1u;
    }
    if (projectedCount == 0u) { return 0.0; }
    let extent = max(maximum - minimum, vec2f(0.0));
    return extent.x * extent.y;
}

fn priorityBucket(sse: f32, area: f32, incrementalSlotCost: u32, entry: GpuTileFrontierEntry) -> u32 {
    let excess = max(sse - selectionPolicy.refineErrorPixels, 0.0);
    let sseScore = u32(floor(127.0 * excess /
        max(sse, selectionPolicy.refineErrorPixels) + 0.5));
    let areaScore = u32(floor(63.0 * min(1.0, area / 4.0) + 0.5));
    let age = f32(mapMeta.frameEpoch - min(mapMeta.frameEpoch, entry.lastDemandEpoch));
    let ageScore = min(63u, u32(age));
    var costPenalty = 0u;
    if (incrementalSlotCost > 1u) {
        costPenalty = min(63u, (incrementalSlotCost - 1u) * 8u);
    }
    return u32(clamp(
        i32(sseScore + areaScore + ageScore) - i32(costPenalty),
        0i,
        255i
    ));
}

fn coveredChildCount(matrixLevel: u32, row: u32, column: u32) -> u32 {
    if (matrixLevel >= selectionPolicy.maximumMatrixLevel) { return 0u; }
    var count = 0u;
    for (var child = 0u; child < 4u; child += 1u) {
        if (tileWithinCoverage(
            matrixLevel + 1u,
            row * 2u + child / 2u,
            column * 2u + child % 2u
        )) {
            count += 1u;
        }
    }
    return count;
}

fn coveredChildOrdinal(matrixLevel: u32, row: u32, column: u32, quadrant: u32) -> u32 {
    var ordinal = 0u;
    for (var child = 0u; child < quadrant; child += 1u) {
        if (tileWithinCoverage(
            matrixLevel + 1u,
            row * 2u + child / 2u,
            column * 2u + child % 2u
        )) {
            ordinal += 1u;
        }
    }
    return ordinal;
}

fn childMissingMask(entry: GpuTileFrontierEntry) -> u32 {
    if (entry.matrixLevel >= selectionPolicy.maximumMatrixLevel) { return 0u; }
    var mask = 0u;
    for (var child = 0u; child < 4u; child += 1u) {
        let row = entry.tileRow * 2u + child / 2u;
        let column = entry.tileCol * 2u + child % 2u;
        if (!tileWithinCoverage(entry.matrixLevel + 1u, row, column)) { continue; }
        if (residentSlotFor(entry.matrixLevel + 1u, row, column, mapMeta.residencySnapshotEpoch) == FRONTIER_INVALID_U32) {
            mask = mask | (1u << child);
        }
    }
    return mask;
}

fn childTerminalFailureMask(entry: GpuTileFrontierEntry) -> u32 {
    if (entry.matrixLevel >= selectionPolicy.maximumMatrixLevel) { return 0u; }
    var mask = 0u;
    for (var child = 0u; child < 4u; child += 1u) {
        let row = entry.tileRow * 2u + child / 2u;
        let column = entry.tileCol * 2u + child % 2u;
        if (!tileWithinCoverage(entry.matrixLevel + 1u, row, column)) { continue; }
        let base = compactIndexFor(entry.matrixLevel + 1u, row, column) * PAGE_TABLE_STRIDE;
        if (virtualPageTable[base + PAGE_TABLE_STATUS] == 4u &&
            virtualPageTable[base + PAGE_TABLE_SNAPSHOT_EPOCH] == mapMeta.residencySnapshotEpoch) {
            mask = mask | (1u << child);
        }
    }
    return mask;
}

fn addressesNeighbor(
    leftLevel: u32,
    leftRow: u32,
    leftColumn: u32,
    rightLevel: u32,
    rightRow: u32,
    rightColumn: u32
) -> bool {
    let commonLevel = max(leftLevel, rightLevel);
    let leftScale = 1u << (commonLevel - leftLevel);
    let rightScale = 1u << (commonLevel - rightLevel);
    let leftMinRow = leftRow * leftScale;
    let leftMaxRow = (leftRow + 1u) * leftScale;
    let leftMinColumn = leftColumn * leftScale;
    let leftMaxColumn = (leftColumn + 1u) * leftScale;
    let rightMinRow = rightRow * rightScale;
    let rightMaxRow = (rightRow + 1u) * rightScale;
    let rightMinColumn = rightColumn * rightScale;
    let rightMaxColumn = (rightColumn + 1u) * rightScale;
    let verticalEdge = (leftMaxColumn == rightMinColumn || rightMaxColumn == leftMinColumn) &&
        max(leftMinRow, rightMinRow) < min(leftMaxRow, rightMaxRow);
    let horizontalEdge = (leftMaxRow == rightMinRow || rightMaxRow == leftMinRow) &&
        max(leftMinColumn, rightMinColumn) < min(leftMaxColumn, rightMaxColumn);
    return verticalEdge || horizontalEdge;
}

fn entriesNeighbor(left: GpuTileFrontierEntry, right: GpuTileFrontierEntry) -> bool {
    return addressesNeighbor(
        left.matrixLevel,
        left.tileRow,
        left.tileCol,
        right.matrixLevel,
        right.tileRow,
        right.tileCol
    );
}

fn makeEntry(matrixLevel: u32, row: u32, column: u32, slot: u32, previousLodState: u32, lastDemandEpoch: u32, lastVisibleEpoch: u32) -> GpuTileFrontierEntry {
    let base = slotBase(slot);
    return GpuTileFrontierEntry(
        slot,
        residentSlots[base + SLOT_GENERATION],
        residentSlots[base + SLOT_CONTENT_EPOCH],
        samplingLevelFor(matrixLevel),
        matrixLevel,
        row,
        column,
        compactIndexFor(matrixLevel, row, column),
        previousLodState,
        lastVisibleEpoch,
        lastDemandEpoch,
        0u,
        mapMeta.residencySnapshotEpoch
    );
}

fn outputVisible(entry: GpuTileFrontierEntry) -> bool {
    return currentEntryValid(entry) && webGpuClipVisible(boundsFor(entry.matrixLevel, entry.tileRow, entry.tileCol));
}

fn writeVisible(index: u32, entry: GpuTileFrontierEntry) {
    visibleOutput[index] = GpuTileFrontierVisibleInstance(
        entry.physicalSlot,
        entry.expectedGeneration,
        entry.samplingLevel,
        entry.matrixLevel,
        entry.tileRow,
        entry.tileCol,
        entry.compactIndex,
        entry.expectedContentEpoch
    );
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn resetFrontier(@builtin(global_invocation_id) globalId: vec3u) {
    let index = globalId.x;
    if (index < FRONTIER_ACTIVE_CAPACITY) {
        atomicStore(&visibilityFlags[index], 0u);
        for (var field = 0u; field < DECISION_STRIDE; field += 1u) {
            atomicStore(&decisionWrite[decisionOffset(index, field)], 0u);
        }
        for (var field = 0u; field < PREFIX_STRIDE; field += 1u) {
            prefixWrite[prefixOffset(index, field)] = 0u;
        }
    }
    if (index == 0u) {
        let rawCurrentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
        let currentCount = min(rawCurrentCount, FRONTIER_ACTIVE_CAPACITY);
        for (var counter = 1u; counter <= COUNTER_LAST; counter += 1u) {
            atomicStore(&countersWrite[counter], 0u);
        }
        atomicStore(&countersWrite[COUNTER_CURRENT_COUNT], currentCount);
        atomicStore(&countersWrite[COUNTER_MINIMUM_LEVEL], FRONTIER_INVALID_U32);
        atomicStore(&countersWrite[COUNTER_FRONTIER_OVERFLOW], select(0u, 1u, rawCurrentCount > FRONTIER_ACTIVE_CAPACITY));
        atomicStore(&countersWrite[COUNTER_FRAME_EPOCH], mapMeta.frameEpoch);
        atomicStore(&countersWrite[COUNTER_SNAPSHOT_EPOCH], mapMeta.residencySnapshotEpoch);
        currentDispatchArguments[0] = (currentCount + FRONTIER_WORKGROUP_SIZE - 1u) / FRONTIER_WORKGROUP_SIZE;
        currentDispatchArguments[1] = 1u;
        currentDispatchArguments[2] = 1u;
    }
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn clearLookup(@builtin(global_invocation_id) globalId: vec3u) {
    let slot = globalId.x;
    if (slot >= FRONTIER_LOOKUP_CAPACITY) { return; }
    let base = slot * LOOKUP_STRIDE;
    atomicStore(&frontierLookupWrite[base + LOOKUP_KEY], FRONTIER_INVALID_U32);
    atomicStore(&frontierLookupWrite[base + LOOKUP_INDEX], FRONTIER_INVALID_U32);
    atomicStore(&frontierLookupWrite[base + LOOKUP_EPOCH], 0u);
    atomicStore(&frontierLookupWrite[base + 3u], 0u);
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn buildLookup(@builtin(global_invocation_id) globalId: vec3u) {
    let index = globalId.x;
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    if (index >= currentCount) { return; }
    let key = currentFrontier[index].compactIndex;
    var slot = lookupHash(key);
    for (var probe = 0u; probe < FRONTIER_LOOKUP_CAPACITY; probe += 1u) {
        let base = slot * LOOKUP_STRIDE;
        var observed = FRONTIER_INVALID_U32;
        loop {
            let claim = atomicCompareExchangeWeak(
                &frontierLookupWrite[base + LOOKUP_KEY],
                FRONTIER_INVALID_U32,
                key
            );
            observed = claim.old_value;
            if (claim.exchanged) {
                atomicStore(&frontierLookupWrite[base + LOOKUP_INDEX], index);
                atomicStore(&frontierLookupWrite[base + LOOKUP_EPOCH], mapMeta.frameEpoch);
                return;
            }
            if (observed != FRONTIER_INVALID_U32) { break; }
        }
        if (observed == key) {
            atomicAdd(&countersWrite[COUNTER_LOOKUP_DUPLICATE], 1u);
            return;
        }
        slot = (slot + 1u) & (FRONTIER_LOOKUP_CAPACITY - 1u);
    }
    atomicStore(&countersWrite[COUNTER_FRONTIER_OVERFLOW], 1u);
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn evaluateFrontier(@builtin(global_invocation_id) globalId: vec3u) {
    let index = globalId.x;
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    if (index >= currentCount) { return; }
    let entry = currentFrontier[index];
    if (!currentEntryValid(entry)) {
        atomicStore(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)], TRANSITION_STALE);
        atomicAdd(&countersWrite[COUNTER_STALE_COUNT], 1u);
        return;
    }
    let bounds = boundsFor(entry.matrixLevel, entry.tileRow, entry.tileCol);
    let visible = webGpuClipVisible(bounds);
    let sse = screenSpaceError(entry.matrixLevel, bounds);
    var transition = TRANSITION_RETAIN;
    let refinePressure = visible && sse > selectionPolicy.refineErrorPixels &&
        entry.matrixLevel < selectionPolicy.maximumMatrixLevel;
    let terminalChildMask = childTerminalFailureMask(entry);
    let liveRefine = refinePressure && terminalChildMask == 0u;
    let invisibleAge = mapMeta.frameEpoch - min(mapMeta.frameEpoch, entry.transitionState);
    let coarsenGracePending = !visible &&
        entry.matrixLevel > selectionPolicy.minimumMatrixLevel &&
        invisibleAge <= selectionPolicy.invisibleGraceFrames;
    let eligibleCoarsen = entry.matrixLevel > selectionPolicy.minimumMatrixLevel &&
        ((visible && sse < selectionPolicy.coarsenErrorPixels) ||
            (!visible && invisibleAge > selectionPolicy.invisibleGraceFrames));
    if (liveRefine) {
        transition = TRANSITION_REFINE;
    } else if (eligibleCoarsen) {
        transition = TRANSITION_COARSEN;
    }
    let coveredChildren = coveredChildCount(entry.matrixLevel, entry.tileRow, entry.tileCol);
    let missingMask = childMissingMask(entry);
    let incrementalSlotCost = countOneBits(missingMask);
    let area = select(0.0, projectedArea(bounds), visible);
    atomicStore(&visibilityFlags[index], select(0u, 1u, visible));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)], transition);
    let basePriority = priorityBucket(sse, area, incrementalSlotCost, entry);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_PRIORITY)], basePriority);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_BASE_PRIORITY)], basePriority);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_MISSING_CHILD_MASK)], missingMask);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_TRANSITION_VISIBLE_EPOCH)], entry.transitionState);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_SSE_BITS)], bitcast<u32>(max(sse, 0.0)));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_VISIBLE_FLAG)], select(0u, 1u, visible));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_CANDIDATE)], select(0u, 1u, liveRefine));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_COVERED_CHILD_COUNT)], coveredChildren);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_LIVE_REFINE)], select(0u, 1u, liveRefine));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_COARSEN_GRACE_PENDING)], select(0u, 1u, coarsenGracePending));
    if (refinePressure && terminalChildMask != 0u) {
        atomicAdd(&countersWrite[COUNTER_FALLBACK_COUNT], 1u);
    }
    atomicMax(&countersWrite[COUNTER_MAXIMUM_SSE_BITS], bitcast<u32>(max(sse, 0.0)));
}

fn isCanonicalCoveredSibling(entry: GpuTileFrontierEntry) -> bool {
    if (entry.matrixLevel == 0u) { return false; }
    let parentLevel = entry.matrixLevel - 1u;
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    for (var sibling = 0u; sibling < 4u; sibling += 1u) {
        let row = parentRow * 2u + sibling / 2u;
        let column = parentColumn * 2u + sibling % 2u;
        if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
        return entry.tileRow == row && entry.tileCol == column;
    }
    return false;
}

fn siblingGroupReady(entry: GpuTileFrontierEntry) -> bool {
    if (!isCanonicalCoveredSibling(entry)) { return false; }
    let parentLevel = entry.matrixLevel - 1u;
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    for (var sibling = 0u; sibling < 4u; sibling += 1u) {
        let row = parentRow * 2u + sibling / 2u;
        let column = parentColumn * 2u + sibling % 2u;
        if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
        let siblingIndex = lookupIndex(compactIndexFor(entry.matrixLevel, row, column));
        if (siblingIndex == FRONTIER_INVALID_U32 ||
            atomicLoad(&decisionWrite[decisionOffset(siblingIndex, DECISION_TRANSITION)]) != TRANSITION_COARSEN) {
            return false;
        }
    }
    return residentSlotFor(
        parentLevel,
        parentRow,
        parentColumn,
        mapMeta.residencySnapshotEpoch
    ) != FRONTIER_INVALID_U32;
}

fn siblingGroupGracePending(entry: GpuTileFrontierEntry) -> bool {
    if (!isCanonicalCoveredSibling(entry)) { return false; }
    let parentLevel = entry.matrixLevel - 1u;
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    if (residentSlotFor(
        parentLevel,
        parentRow,
        parentColumn,
        mapMeta.residencySnapshotEpoch
    ) == FRONTIER_INVALID_U32) { return false; }
    var hasPendingSibling = false;
    for (var sibling = 0u; sibling < 4u; sibling += 1u) {
        let row = parentRow * 2u + sibling / 2u;
        let column = parentColumn * 2u + sibling % 2u;
        if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
        let siblingIndex = lookupIndex(compactIndexFor(entry.matrixLevel, row, column));
        if (siblingIndex == FRONTIER_INVALID_U32) { return false; }
        let transition = atomicLoad(&decisionWrite[decisionOffset(siblingIndex, DECISION_TRANSITION)]);
        let pending = atomicLoad(&decisionWrite[decisionOffset(siblingIndex, DECISION_COARSEN_GRACE_PENDING)]) == 1u;
        if (transition != TRANSITION_COARSEN && !pending) { return false; }
        hasPendingSibling = hasPendingSibling || pending;
    }
    return hasPendingSibling;
}

fn stickyDemandCandidate(entry: GpuTileFrontierEntry, missingMask: u32) -> bool {
    return entry.previousLodState == TRANSITION_REFINE &&
        (entry.childDemandMask & missingMask) != 0u;
}

@compute @workgroup_size(1)
fn selectBudgets(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x != 0u) { return; }
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    for (var index = 0u; index < currentCount; index += 1u) {
        if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_LIVE_REFINE)]) != 1u) { continue; }
        let entry = currentFrontier[index];
        var blocked = false;
        let candidatePriority = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_BASE_PRIORITY)]);
        for (var otherIndex = 0u; otherIndex < currentCount; otherIndex += 1u) {
            if (otherIndex == index ||
                atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_TRANSITION)]) == TRANSITION_STALE) {
                continue;
            }
            let other = currentFrontier[otherIndex];
            if (!entriesNeighbor(entry, other) || other.matrixLevel >= entry.matrixLevel) { continue; }
            blocked = true;
            atomicStore(&decisionWrite[decisionOffset(otherIndex, DECISION_CANDIDATE)], 1u);
            atomicMax(&decisionWrite[decisionOffset(otherIndex, DECISION_PRIORITY)], candidatePriority);
        }
        if (blocked) {
            atomicStore(&decisionWrite[decisionOffset(index, DECISION_BLOCKED)], 1u);
            atomicAdd(&countersWrite[COUNTER_FALLBACK_COUNT], 1u);
        }
    }
    var candidateCount = 0u;
    for (var index = 0u; index < currentCount; index += 1u) {
        candidateCount += atomicLoad(&decisionWrite[decisionOffset(index, DECISION_CANDIDATE)]);
    }
    atomicStore(&countersWrite[COUNTER_REFINE_COUNT], candidateCount);
    let staleCount = min(currentCount, atomicLoad(&countersWrite[COUNTER_STALE_COUNT]));
    var acceptedActiveCount = currentCount - staleCount;
    var acceptedDemandCount = 0u;
    var acceptedTransitionPages = 0u;
    for (var index = 0u; index < currentCount; index += 1u) {
        if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_CANDIDATE)]) != 1u ||
            atomicLoad(&decisionWrite[decisionOffset(index, DECISION_BLOCKED)]) == 1u) {
            continue;
        }
        let entry = currentFrontier[index];
        let missingMask = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_MISSING_CHILD_MASK)]);
        if (!stickyDemandCandidate(entry, missingMask)) { continue; }
        let missingCount = countOneBits(missingMask);
        let activeCost = 3u;
        if (acceptedActiveCount + activeCost <= selectionPolicy.maximumActiveTiles &&
            acceptedDemandCount + missingCount <= selectionPolicy.maximumDemands &&
            acceptedTransitionPages + missingCount <= selectionPolicy.transitionReservePages) {
            atomicStore(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)], 1u);
            atomicStore(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)], TRANSITION_REFINE);
            acceptedActiveCount += activeCost;
            acceptedDemandCount += missingCount;
            acceptedTransitionPages += missingCount;
        } else {
            atomicAdd(&countersWrite[COUNTER_BUDGET_LIMITED_COUNT], 1u);
        }
    }
    var bucket = 255i;
    loop {
        for (var index = 0u; index < currentCount; index += 1u) {
            if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_CANDIDATE)]) != 1u ||
                atomicLoad(&decisionWrite[decisionOffset(index, DECISION_BLOCKED)]) == 1u ||
                atomicLoad(&decisionWrite[decisionOffset(index, DECISION_PRIORITY)]) != u32(bucket)) {
                continue;
            }
            let entry = currentFrontier[index];
            let missingMask = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_MISSING_CHILD_MASK)]);
            if (stickyDemandCandidate(entry, missingMask)) { continue; }
            let missingCount = countOneBits(missingMask);
            let activeCost = 3u;
            if (acceptedActiveCount + activeCost <= selectionPolicy.maximumActiveTiles &&
                acceptedDemandCount + missingCount <= selectionPolicy.maximumDemands &&
                acceptedTransitionPages + missingCount <= selectionPolicy.transitionReservePages) {
                atomicStore(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)], 1u);
                atomicStore(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)], TRANSITION_REFINE);
                acceptedActiveCount += activeCost;
                acceptedDemandCount += missingCount;
                acceptedTransitionPages += missingCount;
            } else {
                atomicAdd(&countersWrite[COUNTER_BUDGET_LIMITED_COUNT], 1u);
            }
        }
        if (bucket == 0i) { break; }
        bucket -= 1i;
    }
    for (var index = 0u; index < currentCount; index += 1u) {
        let entry = currentFrontier[index];
        if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)]) != TRANSITION_COARSEN ||
            !siblingGroupReady(entry)) {
            continue;
        }
        let parentRow = entry.tileRow / 2u;
        let parentColumn = entry.tileCol / 2u;
        for (var sibling = 0u; sibling < 4u; sibling += 1u) {
            let row = parentRow * 2u + sibling / 2u;
            let column = parentColumn * 2u + sibling % 2u;
            if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
            let key = compactIndexFor(entry.matrixLevel, row, column);
            let siblingIndex = lookupIndex(key);
            atomicStore(&decisionWrite[decisionOffset(siblingIndex, DECISION_ACCEPTED)], 1u);
        }
        atomicAdd(&countersWrite[COUNTER_COARSEN_COUNT], 1u);
    }
    var gracePendingCount = 0u;
    for (var index = 0u; index < currentCount; index += 1u) {
        if (siblingGroupGracePending(currentFrontier[index])) {
            gracePendingCount += 1u;
        }
    }
    atomicStore(&countersWrite[COUNTER_COARSEN_GRACE_PENDING], gracePendingCount);
}

fn resolvedVisibleCount(index: u32, entry: GpuTileFrontierEntry, transition: u32, accepted: bool, missingMask: u32) -> u32 {
    if (!accepted || transition == TRANSITION_RETAIN || missingMask != 0u) {
        return atomicLoad(&visibilityFlags[index]);
    }
    var count = 0u;
    if (transition == TRANSITION_REFINE) {
        for (var child = 0u; child < 4u; child += 1u) {
            let row = entry.tileRow * 2u + child / 2u;
            let column = entry.tileCol * 2u + child % 2u;
            if (!tileWithinCoverage(entry.matrixLevel + 1u, row, column)) { continue; }
            let slot = residentSlotFor(entry.matrixLevel + 1u, row, column, mapMeta.residencySnapshotEpoch);
            if (slot != FRONTIER_INVALID_U32 && outputVisible(makeEntry(entry.matrixLevel + 1u, row, column, slot, TRANSITION_RETAIN, entry.lastDemandEpoch, mapMeta.frameEpoch))) {
                count += 1u;
            }
        }
        return count;
    }
    let parentSlot = residentSlotFor(entry.matrixLevel - 1u, entry.tileRow / 2u, entry.tileCol / 2u, mapMeta.residencySnapshotEpoch);
    if (parentSlot == FRONTIER_INVALID_U32) { return 0u; }
    return select(0u, 1u, outputVisible(makeEntry(entry.matrixLevel - 1u, entry.tileRow / 2u, entry.tileCol / 2u, parentSlot, TRANSITION_RETAIN, entry.lastDemandEpoch, mapMeta.frameEpoch)));
}

fn siblingLastVisible(entry: GpuTileFrontierEntry) -> u32 {
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    var lastVisible = 0u;
    for (var index = 0u; index < currentCount; index += 1u) {
        let sibling = currentFrontier[index];
        if (sibling.matrixLevel == entry.matrixLevel &&
            sibling.tileRow / 2u == parentRow && sibling.tileCol / 2u == parentColumn) {
            let siblingVisibleEpoch = select(
                sibling.transitionState,
                mapMeta.frameEpoch,
                atomicLoad(&decisionWrite[decisionOffset(index, DECISION_VISIBLE_FLAG)]) == 1u
            );
            lastVisible = max(lastVisible, siblingVisibleEpoch);
        }
    }
    return lastVisible;
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn resolveTransitions(@builtin(global_invocation_id) globalId: vec3u) {
    let index = globalId.x;
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    if (index >= currentCount) { return; }
    let entry = currentFrontier[index];
    let transition = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)]);
    let accepted = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)]) == 1u;
    let missingMask = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_MISSING_CHILD_MASK)]);
    let coveredChildren = atomicLoad(&decisionWrite[decisionOffset(index, DECISION_COVERED_CHILD_COUNT)]);
    var nextCount = 1u;
    var demandCount = 0u;
    var retireCount = 0u;
    var visibleCount = atomicLoad(&visibilityFlags[index]);
    if (transition == TRANSITION_STALE) {
        nextCount = 0u;
        visibleCount = 0u;
    } else if (accepted && transition == TRANSITION_REFINE) {
        if (missingMask == 0u) {
            nextCount = coveredChildren;
            retireCount = 1u;
        } else {
            demandCount = countOneBits(missingMask);
        }
        visibleCount = resolvedVisibleCount(index, entry, transition, accepted, missingMask);
    } else if (accepted && transition == TRANSITION_COARSEN) {
        let canonicalFirst = isCanonicalCoveredSibling(entry);
        nextCount = select(0u, 1u, canonicalFirst);
        visibleCount = 0u;
        if (canonicalFirst) {
            visibleCount = resolvedVisibleCount(index, entry, transition, accepted, 0u);
            atomicStore(
                &decisionWrite[decisionOffset(index, DECISION_TRANSITION_VISIBLE_EPOCH)],
                siblingLastVisible(entry)
            );
            retireCount = coveredChildCount(
                entry.matrixLevel - 1u,
                entry.tileRow / 2u,
                entry.tileCol / 2u
            );
        }
    }
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_NEXT_COUNT)], nextCount);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_VISIBLE_COUNT)], visibleCount);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_DEMAND_COUNT)], demandCount);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_RETIRE_COUNT)], retireCount);
}

fn refineViolatesBalance(index: u32, entry: GpuTileFrontierEntry) -> bool {
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    for (var otherIndex = 0u; otherIndex < currentCount; otherIndex += 1u) {
        if (otherIndex == index ||
            atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_TRANSITION)]) == TRANSITION_STALE) {
            continue;
        }
        let other = currentFrontier[otherIndex];
        if (entriesNeighbor(entry, other) && other.matrixLevel < entry.matrixLevel) {
            return true;
        }
    }
    return false;
}

fn sameSiblingGroup(entry: GpuTileFrontierEntry, other: GpuTileFrontierEntry) -> bool {
    return entry.matrixLevel == other.matrixLevel &&
        entry.tileRow / 2u == other.tileRow / 2u &&
        entry.tileCol / 2u == other.tileCol / 2u;
}

fn coarsenViolatesBalance(entry: GpuTileFrontierEntry) -> bool {
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    let parentLevel = entry.matrixLevel - 1u;
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    for (var otherIndex = 0u; otherIndex < currentCount; otherIndex += 1u) {
        let other = currentFrontier[otherIndex];
        if (sameSiblingGroup(entry, other) ||
            atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_TRANSITION)]) == TRANSITION_STALE ||
            !addressesNeighbor(
                parentLevel,
                parentRow,
                parentColumn,
                other.matrixLevel,
                other.tileRow,
                other.tileCol
            )) {
            continue;
        }
        if (other.matrixLevel > entry.matrixLevel) { return true; }
        if (atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_ACCEPTED)]) == 1u &&
            atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_TRANSITION)]) == TRANSITION_REFINE &&
            atomicLoad(&decisionWrite[decisionOffset(otherIndex, DECISION_MISSING_CHILD_MASK)]) == 0u) {
            return true;
        }
    }
    return false;
}

fn rejectTransition(index: u32) {
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)], 0u);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_NEXT_COUNT)], 1u);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_VISIBLE_COUNT)], atomicLoad(&visibilityFlags[index]));
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_DEMAND_COUNT)], 0u);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_RETIRE_COUNT)], 0u);
    atomicStore(&decisionWrite[decisionOffset(index, DECISION_BALANCE_REJECTED)], 1u);
    atomicAdd(&countersWrite[COUNTER_BALANCE_REJECTED], 1u);
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn balanceNeighbors(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x != 0u) { return; }
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    for (var index = 0u; index < currentCount; index += 1u) {
        if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)]) != 1u ||
            atomicLoad(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)]) != TRANSITION_REFINE) {
            continue;
        }
        if (refineViolatesBalance(index, currentFrontier[index])) {
            rejectTransition(index);
            atomicAdd(&countersWrite[COUNTER_FALLBACK_COUNT], 1u);
        } else if (atomicLoad(&decisionWrite[decisionOffset(index, DECISION_MISSING_CHILD_MASK)]) != 0u) {
            atomicAdd(&countersWrite[COUNTER_FALLBACK_COUNT], 1u);
        } else {
            atomicAdd(&countersWrite[COUNTER_ACCEPTED_REFINE], 1u);
        }
    }
    for (var index = 0u; index < currentCount; index += 1u) {
        let entry = currentFrontier[index];
        if (!isCanonicalCoveredSibling(entry) ||
            atomicLoad(&decisionWrite[decisionOffset(index, DECISION_ACCEPTED)]) != 1u ||
            atomicLoad(&decisionWrite[decisionOffset(index, DECISION_TRANSITION)]) != TRANSITION_COARSEN) {
            continue;
        }
        if (!coarsenViolatesBalance(entry)) {
            atomicAdd(&countersWrite[COUNTER_ACCEPTED_COARSEN], 1u);
            continue;
        }
        let parentRow = entry.tileRow / 2u;
        let parentColumn = entry.tileCol / 2u;
        for (var sibling = 0u; sibling < 4u; sibling += 1u) {
            let row = parentRow * 2u + sibling / 2u;
            let column = parentColumn * 2u + sibling % 2u;
            if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
            let siblingIndex = lookupIndex(compactIndexFor(entry.matrixLevel, row, column));
            if (siblingIndex != FRONTIER_INVALID_U32) { rejectTransition(siblingIndex); }
        }
        atomicAdd(&countersWrite[COUNTER_FALLBACK_COUNT], 1u);
    }
}

@compute @workgroup_size(1)
fn scanBlocks(@builtin(global_invocation_id) globalId: vec3u) {
    let block = globalId.x;
    if (block >= FRONTIER_SCAN_BLOCK_COUNT) { return; }
    let currentCount = countersRead[COUNTER_CURRENT_COUNT];
    let begin = block * FRONTIER_SCAN_BLOCK_SIZE;
    let end = min(begin + FRONTIER_SCAN_BLOCK_SIZE, currentCount);
    var totals = vec4u(0u);
    for (var index = begin; index < end; index += 1u) {
        prefixWrite[prefixOffset(index, PREFIX_NEXT)] = totals.x;
        prefixWrite[prefixOffset(index, PREFIX_VISIBLE)] = totals.y;
        prefixWrite[prefixOffset(index, PREFIX_DEMAND)] = totals.z;
        prefixWrite[prefixOffset(index, PREFIX_RETIRE)] = totals.w;
        totals += vec4u(
            decisionRead[decisionOffset(index, DECISION_NEXT_COUNT)],
            decisionRead[decisionOffset(index, DECISION_VISIBLE_COUNT)],
            decisionRead[decisionOffset(index, DECISION_DEMAND_COUNT)],
            decisionRead[decisionOffset(index, DECISION_RETIRE_COUNT)]
        );
    }
    let blockBase = PREFIX_BLOCK_BASE + block * PREFIX_STRIDE;
    prefixWrite[blockBase + PREFIX_NEXT] = totals.x;
    prefixWrite[blockBase + PREFIX_VISIBLE] = totals.y;
    prefixWrite[blockBase + PREFIX_DEMAND] = totals.z;
    prefixWrite[blockBase + PREFIX_RETIRE] = totals.w;
}

@compute @workgroup_size(1)
fn scanBlockSums(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x != 0u) { return; }
    var totals = vec4u(0u);
    for (var block = 0u; block < FRONTIER_SCAN_BLOCK_COUNT; block += 1u) {
        let blockBase = PREFIX_BLOCK_BASE + block * PREFIX_STRIDE;
        let blockTotals = vec4u(
            prefixWrite[blockBase + PREFIX_NEXT],
            prefixWrite[blockBase + PREFIX_VISIBLE],
            prefixWrite[blockBase + PREFIX_DEMAND],
            prefixWrite[blockBase + PREFIX_RETIRE]
        );
        prefixWrite[blockBase + PREFIX_NEXT] = totals.x;
        prefixWrite[blockBase + PREFIX_VISIBLE] = totals.y;
        prefixWrite[blockBase + PREFIX_DEMAND] = totals.z;
        prefixWrite[blockBase + PREFIX_RETIRE] = totals.w;
        totals += blockTotals;
    }
    atomicStore(&countersWrite[COUNTER_NEXT_COUNT], totals.x);
    atomicStore(&countersWrite[COUNTER_VISIBLE_COUNT], totals.y);
    atomicStore(&countersWrite[COUNTER_DEMAND_COUNT], totals.z);
    atomicStore(&countersWrite[COUNTER_RETIRE_COUNT], totals.w);
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    prefixWrite[PREFIX_BLOCK_BASE + PREFIX_CURRENT_COUNT] = currentCount;
    var minimumLevel = FRONTIER_INVALID_U32;
    var maximumLevel = 0u;
    for (var index = 0u; index < currentCount; index += 1u) {
        if (decisionRead[decisionOffset(index, DECISION_NEXT_COUNT)] == 0u) { continue; }
        let entry = currentFrontier[index];
        let transition = decisionRead[decisionOffset(index, DECISION_TRANSITION)];
        let accepted = decisionRead[decisionOffset(index, DECISION_ACCEPTED)] == 1u;
        var outputLevel = entry.matrixLevel;
        if (accepted && transition == TRANSITION_REFINE &&
            decisionRead[decisionOffset(index, DECISION_MISSING_CHILD_MASK)] == 0u) {
            outputLevel += 1u;
        } else if (accepted && transition == TRANSITION_COARSEN) {
            outputLevel -= 1u;
        }
        minimumLevel = min(minimumLevel, outputLevel);
        maximumLevel = max(maximumLevel, outputLevel);
    }
    atomicStore(&countersWrite[COUNTER_MINIMUM_LEVEL], minimumLevel);
    atomicStore(&countersWrite[COUNTER_MAXIMUM_LEVEL], maximumLevel);
}

@compute @workgroup_size(1)
fn addScanOffsets(@builtin(global_invocation_id) globalId: vec3u) {
    let block = globalId.x;
    if (block >= FRONTIER_SCAN_BLOCK_COUNT) { return; }
    let currentCount = countersRead[COUNTER_CURRENT_COUNT];
    let blockBase = PREFIX_BLOCK_BASE + block * PREFIX_STRIDE;
    let blockOffsets = vec4u(
        prefixWrite[blockBase + PREFIX_NEXT],
        prefixWrite[blockBase + PREFIX_VISIBLE],
        prefixWrite[blockBase + PREFIX_DEMAND],
        prefixWrite[blockBase + PREFIX_RETIRE]
    );
    let begin = block * FRONTIER_SCAN_BLOCK_SIZE;
    let end = min(begin + FRONTIER_SCAN_BLOCK_SIZE, currentCount);
    for (var index = begin; index < end; index += 1u) {
        prefixWrite[prefixOffset(index, PREFIX_NEXT)] += blockOffsets.x;
        prefixWrite[prefixOffset(index, PREFIX_VISIBLE)] += blockOffsets.y;
        prefixWrite[prefixOffset(index, PREFIX_DEMAND)] += blockOffsets.z;
        prefixWrite[prefixOffset(index, PREFIX_RETIRE)] += blockOffsets.w;
    }
}

fn updatedRetainEntry(
    entry: GpuTileFrontierEntry,
    visible: bool,
    demanded: bool,
    missingMask: u32
) -> GpuTileFrontierEntry {
    return GpuTileFrontierEntry(
        entry.physicalSlot,
        entry.expectedGeneration,
        entry.expectedContentEpoch,
        entry.samplingLevel,
        entry.matrixLevel,
        entry.tileRow,
        entry.tileCol,
        entry.compactIndex,
        select(entry.previousLodState, TRANSITION_REFINE, demanded),
        select(entry.transitionState, mapMeta.frameEpoch, visible),
        select(entry.lastDemandEpoch, mapMeta.frameEpoch, demanded),
        select(entry.childDemandMask, missingMask, demanded),
        mapMeta.residencySnapshotEpoch
    );
}

@compute @workgroup_size(${GPU_TILE_FRONTIER_WORKGROUP_SIZE})
fn compactOutputs(@builtin(global_invocation_id) globalId: vec3u) {
    let index = globalId.x;
    let currentCount = prefixRead[PREFIX_BLOCK_BASE + PREFIX_CURRENT_COUNT];
    if (index >= currentCount) { return; }
    let entry = currentFrontier[index];
    let transition = decisionRead[decisionOffset(index, DECISION_TRANSITION)];
    let accepted = decisionRead[decisionOffset(index, DECISION_ACCEPTED)] == 1u;
    let missingMask = decisionRead[decisionOffset(index, DECISION_MISSING_CHILD_MASK)];
    let nextOffset = prefixRead[prefixOffset(index, PREFIX_NEXT)];
    var visibleOffset = prefixRead[prefixOffset(index, PREFIX_VISIBLE)];
    var demandOffset = prefixRead[prefixOffset(index, PREFIX_DEMAND)];
    if (transition == TRANSITION_STALE) { return; }
    if (accepted && transition == TRANSITION_REFINE && missingMask == 0u) {
        for (var child = 0u; child < 4u; child += 1u) {
            let row = entry.tileRow * 2u + child / 2u;
            let column = entry.tileCol * 2u + child % 2u;
            if (!tileWithinCoverage(entry.matrixLevel + 1u, row, column)) { continue; }
            let ordinal = coveredChildOrdinal(
                entry.matrixLevel,
                entry.tileRow,
                entry.tileCol,
                child
            );
            let slot = residentSlotFor(entry.matrixLevel + 1u, row, column, mapMeta.residencySnapshotEpoch);
            let childEntry = makeEntry(entry.matrixLevel + 1u, row, column, slot, TRANSITION_REFINE, 0u, mapMeta.frameEpoch);
            nextFrontier[nextOffset + ordinal] = childEntry;
            if (outputVisible(childEntry)) {
                writeVisible(visibleOffset, childEntry);
                visibleOffset += 1u;
            }
        }
        return;
    }
    if (accepted && transition == TRANSITION_COARSEN) {
        if (!isCanonicalCoveredSibling(entry)) { return; }
        let parentLevel = entry.matrixLevel - 1u;
        let parentRow = entry.tileRow / 2u;
        let parentColumn = entry.tileCol / 2u;
        let slot = residentSlotFor(parentLevel, parentRow, parentColumn, mapMeta.residencySnapshotEpoch);
        let parentEntry = makeEntry(
            parentLevel,
            parentRow,
            parentColumn,
            slot,
            TRANSITION_COARSEN,
            0u,
            decisionRead[decisionOffset(index, DECISION_TRANSITION_VISIBLE_EPOCH)]
        );
        nextFrontier[nextOffset] = parentEntry;
        if (outputVisible(parentEntry)) { writeVisible(visibleOffset, parentEntry); }
        return;
    }
    let demanded = accepted && transition == TRANSITION_REFINE && missingMask != 0u;
    let wasVisible = decisionRead[decisionOffset(index, DECISION_VISIBLE_FLAG)] == 1u;
    let retained = updatedRetainEntry(entry, wasVisible, demanded, missingMask);
    nextFrontier[nextOffset] = retained;
    if (wasVisible) { writeVisible(visibleOffset, retained); }
    if (demanded) {
        for (var child = 0u; child < 4u; child += 1u) {
            let childLevel = entry.matrixLevel + 1u;
            let childRow = entry.tileRow * 2u + child / 2u;
            let childColumn = entry.tileCol * 2u + child % 2u;
            if (!tileWithinCoverage(childLevel, childRow, childColumn)) { continue; }
            if ((missingMask & (1u << child)) == 0u) { continue; }
            demandOutput[demandOffset] = GpuTileFrontierDemand(
                samplingLevelFor(childLevel),
                childLevel,
                childRow,
                childColumn,
                compactIndexFor(childLevel, childRow, childColumn),
                entry.compactIndex,
                entry.physicalSlot,
                entry.expectedGeneration,
                decisionRead[decisionOffset(index, DECISION_PRIORITY)],
                mapMeta.frameEpoch,
                mapMeta.residencySnapshotEpoch,
                1u << child
            );
            demandOffset += 1u;
        }
    }
}

fn writeRetireEntries(index: u32, entry: GpuTileFrontierEntry) {
    let retireCount = decisionRead[decisionOffset(index, DECISION_RETIRE_COUNT)];
    if (retireCount == 0u) { return; }
    let retireOffset = prefixRead[prefixOffset(index, PREFIX_RETIRE)];
    let transition = decisionRead[decisionOffset(index, DECISION_TRANSITION)];
    if (transition == TRANSITION_REFINE) {
        retireOutput[retireOffset] = entry;
        return;
    }
    let parentRow = entry.tileRow / 2u;
    let parentColumn = entry.tileCol / 2u;
    var outputIndex = 0u;
    for (var sibling = 0u; sibling < 4u; sibling += 1u) {
        let row = parentRow * 2u + sibling / 2u;
        let column = parentColumn * 2u + sibling % 2u;
        if (!tileWithinCoverage(entry.matrixLevel, row, column)) { continue; }
        for (var siblingIndex = 0u; siblingIndex < atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]); siblingIndex += 1u) {
            let siblingEntry = currentFrontier[siblingIndex];
            if (siblingEntry.matrixLevel == entry.matrixLevel &&
                siblingEntry.tileRow == row && siblingEntry.tileCol == column) {
                retireOutput[retireOffset + outputIndex] = siblingEntry;
                break;
            }
        }
        outputIndex += 1u;
    }
}

@compute @workgroup_size(1)
fn finalizeArguments(@builtin(global_invocation_id) globalId: vec3u) {
    if (globalId.x != 0u) { return; }
    let currentCount = atomicLoad(&countersWrite[COUNTER_CURRENT_COUNT]);
    for (var index = 0u; index < currentCount; index += 1u) {
        writeRetireEntries(index, currentFrontier[index]);
    }
    let visibleCount = min(atomicLoad(&countersWrite[COUNTER_VISIBLE_COUNT]), FRONTIER_ACTIVE_CAPACITY);
    for (var templateIndex = 0u; templateIndex < FRONTIER_DRAW_TEMPLATE_COUNT; templateIndex += 1u) {
        let base = templateIndex * 4u;
        drawArgumentsOutput[base] = FRONTIER_DRAW_VERTEX_COUNTS[templateIndex];
        drawArgumentsOutput[base + 1u] = visibleCount;
        drawArgumentsOutput[base + 2u] = FRONTIER_DRAW_FIRST_VERTICES[templateIndex];
        drawArgumentsOutput[base + 3u] = FRONTIER_DRAW_FIRST_INSTANCES[templateIndex];
    }
    let rawNextCount = atomicLoad(&countersWrite[COUNTER_NEXT_COUNT]);
    let rawDemandCount = atomicLoad(&countersWrite[COUNTER_DEMAND_COUNT]);
    let rawVisibleCount = atomicLoad(&countersWrite[COUNTER_VISIBLE_COUNT]);
    let nextCount = min(rawNextCount, FRONTIER_ACTIVE_CAPACITY);
    let demandCount = min(rawDemandCount, FRONTIER_DEMAND_CAPACITY);
    if (rawNextCount > FRONTIER_ACTIVE_CAPACITY) { atomicStore(&countersWrite[COUNTER_FRONTIER_OVERFLOW], 1u); }
    if (rawDemandCount > FRONTIER_DEMAND_CAPACITY) { atomicStore(&countersWrite[COUNTER_DEMAND_OVERFLOW], 1u); }
    if (rawVisibleCount > FRONTIER_ACTIVE_CAPACITY) { atomicStore(&countersWrite[COUNTER_VISIBLE_OVERFLOW], 1u); }
    atomicStore(&countersWrite[COUNTER_CURRENT_COUNT], nextCount);
    atomicStore(&countersWrite[COUNTER_NEXT_COUNT], nextCount);
    atomicStore(&countersWrite[COUNTER_DEMAND_COUNT], demandCount);
    atomicStore(&countersWrite[COUNTER_VISIBLE_COUNT], visibleCount);
    nextDispatchArguments[0] = (nextCount + FRONTIER_WORKGROUP_SIZE - 1u) / FRONTIER_WORKGROUP_SIZE;
    nextDispatchArguments[1] = 1u;
    nextDispatchArguments[2] = 1u;
    diagnosticsOutput.frameEpoch = mapMeta.frameEpoch;
    diagnosticsOutput.residencySnapshotEpoch = mapMeta.residencySnapshotEpoch;
    diagnosticsOutput.activeFrontierCount = nextCount;
    diagnosticsOutput.visibleInstanceCount = visibleCount;
    diagnosticsOutput.refineCandidateCount = atomicLoad(&countersWrite[COUNTER_REFINE_COUNT]);
    diagnosticsOutput.coarsenCandidateCount = atomicLoad(&countersWrite[COUNTER_COARSEN_COUNT]);
    diagnosticsOutput.coarsenGracePendingCount = atomicLoad(&countersWrite[COUNTER_COARSEN_GRACE_PENDING]);
    diagnosticsOutput.demandCount = demandCount;
    diagnosticsOutput.fallbackCount = atomicLoad(&countersWrite[COUNTER_FALLBACK_COUNT]);
    diagnosticsOutput.staleGenerationCount = atomicLoad(&countersWrite[COUNTER_STALE_COUNT]);
    diagnosticsOutput.budgetLimitedCount = atomicLoad(&countersWrite[COUNTER_BUDGET_LIMITED_COUNT]);
    diagnosticsOutput.maximumObservedSse = bitcast<f32>(atomicLoad(&countersWrite[COUNTER_MAXIMUM_SSE_BITS]));
    diagnosticsOutput.minimumSelectedMatrixLevel = atomicLoad(&countersWrite[COUNTER_MINIMUM_LEVEL]);
    diagnosticsOutput.maximumSelectedMatrixLevel = atomicLoad(&countersWrite[COUNTER_MAXIMUM_LEVEL]);
    diagnosticsOutput.frontierOverflow = atomicLoad(&countersWrite[COUNTER_FRONTIER_OVERFLOW]);
    diagnosticsOutput.demandOverflow = atomicLoad(&countersWrite[COUNTER_DEMAND_OVERFLOW]);
    diagnosticsOutput.visibleOverflow = atomicLoad(&countersWrite[COUNTER_VISIBLE_OVERFLOW]);
    let transitioning = demandCount > 0u ||
        atomicLoad(&countersWrite[COUNTER_ACCEPTED_REFINE]) > 0u ||
        atomicLoad(&countersWrite[COUNTER_ACCEPTED_COARSEN]) > 0u ||
        atomicLoad(&countersWrite[COUNTER_COARSEN_GRACE_PENDING]) > 0u;
    diagnosticsOutput.convergenceState = select(
        select(0u, 1u, transitioning),
        2u,
        diagnosticsOutput.budgetLimitedCount > 0u
    );
    diagnosticsOutput.reserved0 = atomicLoad(&countersWrite[COUNTER_LOOKUP_DUPLICATE]);
    diagnosticsOutput.reserved1 = atomicLoad(&countersWrite[COUNTER_BALANCE_REJECTED]);
}
`

    return Object.freeze({
        code,
        entryPoints: gpuTileFrontierEntryPoints,
        layoutDependencies,
    })
}

function u32List(values: readonly number[]): string {

    return values.map(value => `${value}u`).join(', ')
}

function f32Literal(value: number): string {

    const text = Math.fround(value).toString()
    return /[.e]/i.test(text) ? text : `${text}.0`
}
