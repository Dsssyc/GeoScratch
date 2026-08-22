import {
    layoutCodec,
    type LayoutArtifact,
} from '../scratch/index.js'

export const gpuWebMercatorQuadCoverMapMetaCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverMapMeta',
    fields: [
        { name: 'clipFromRelativeWorld', type: 'mat4x4f' },
        { name: 'cameraHigh', type: 'vec3f' },
        { name: 'cameraLow', type: 'vec3f' },
        { name: 'cameraFixedLow', type: 'vec2u' },
        { name: 'cameraFixedHigh', type: 'vec2u' },
        { name: 'referenceViewport', type: 'vec2f' },
        { name: 'verticalFovRadians', type: 'f32' },
        { name: 'cameraLatitudeRadians', type: 'f32' },
        { name: 'zoomHint', type: 'f32' },
        { name: 'frameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
        { name: 'cameraPitchRadians', type: 'f32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverPolicyCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverPolicy',
    fields: [
        { name: 'minimumMatrixLevel', type: 'u32' },
        { name: 'maximumMatrixLevel', type: 'u32' },
        { name: 'sourceMaximumMatrixLevel', type: 'u32' },
        { name: 'maximumPatches', type: 'u32' },
        { name: 'demandCapacity', type: 'u32' },
        { name: 'coverageLimitCount', type: 'u32' },
        { name: 'coordinateBits', type: 'u32' },
        { name: 'vertexCount', type: 'u32' },
        { name: 'lookupCapacity', type: 'u32' },
        { name: 'minimumElevationMeters', type: 'f32' },
        { name: 'maximumElevationMeters', type: 'f32' },
        { name: 'cellsPerPatchEdge', type: 'u32' },
        { name: 'referenceTileSizePixels', type: 'f32' },
        { name: 'maximumCellSpanReferencePixels', type: 'f32' },
        { name: 'refinementTolerance', type: 'f32' },
        { name: 'variableLodPitchThresholdRadians', type: 'f32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverLimitCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverLimit',
    fields: [
        { name: 'matrixLevel', type: 'u32' },
        { name: 'minTileRow', type: 'u32' },
        { name: 'maxTileRow', type: 'u32' },
        { name: 'minTileCol', type: 'u32' },
        { name: 'maxTileCol', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverPatchCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverPatch',
    fields: [
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverLookupEntryCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverLookupEntry',
    fields: [
        { name: 'occupied', type: 'u32' },
        { name: 'matrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'patchIndex', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverDemandCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverDemand',
    fields: [
        { name: 'desiredSampleLevel', type: 'u32' },
        { name: 'sourceLevelCeiling', type: 'u32' },
        { name: 'requestMatrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'priority', type: 'u32' },
        { name: 'decisionFrameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadCoverStateCodec = layoutCodec({
    name: 'GpuWebMercatorQuadCoverState',
    fields: [
        { name: 'frameEpoch', type: 'u32' },
        { name: 'candidateCount', type: 'u32' },
        { name: 'patchCount', type: 'u32' },
        { name: 'demandCount', type: 'u32' },
        { name: 'descriptorOverflowCount', type: 'u32' },
        { name: 'lookupOverflowCount', type: 'u32' },
        { name: 'demandOverflowCount', type: 'u32' },
        { name: 'minimumMatrixLevel', type: 'u32' },
        { name: 'maximumMatrixLevel', type: 'u32' },
        { name: 'maximumAdjacentLevelDelta', type: 'u32' },
        { name: 'finestMatrixLevel', type: 'u32' },
        { name: 'sourceLevelCeiling', type: 'u32' },
        { name: 'selectionMode', type: 'u32' },
        { name: 'minimumCellSpanQ8', type: 'u32' },
        { name: 'maximumCellSpanQ8', type: 'u32' },
        { name: 'reserved3', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export type GpuWebMercatorQuadCoverReadWgslOptions = Readonly<{
    namespace?: string
    group: number
    visibleInstancesBinding: number
    lookupEntriesBinding: number
}>

export type GpuWebMercatorQuadCoverReadWgslModule = Readonly<{
    kind: 'gpu-web-mercator-quad-cover-read-wgsl-module'
    namespace: string
    code: string
    layoutDependencies: readonly LayoutArtifact[]
    bindings: Readonly<{
        group: number
        visibleInstances: number
        lookupEntries: number
    }>
}>

/** Generates standard-tile lookup, neighbor, and edge-stitching WGSL for one cover. */
export function gpuWebMercatorQuadCoverReadWgslModule(
    options: GpuWebMercatorQuadCoverReadWgslOptions
): GpuWebMercatorQuadCoverReadWgslModule {

    const namespace = wgslIdentifier(options?.namespace ?? 'GpuWebMercatorQuadCoverRead')
    const group = nonNegativeBinding(options?.group, 'group')
    const visibleInstances = nonNegativeBinding(
        options?.visibleInstancesBinding,
        'visibleInstancesBinding'
    )
    const lookupEntries = nonNegativeBinding(
        options?.lookupEntriesBinding,
        'lookupEntriesBinding'
    )
    if (visibleInstances === lookupEntries) {
        throw new TypeError('WebMercatorQuad cover read bindings must be distinct')
    }
    const shared = sharedWgsl()
    const code = `${shared.code}
${gpuWebMercatorQuadCoverLookupEntryCodec.wgslAccessors({
        namespace: `${namespace}LookupEntryLayout`,
    })}

struct ${namespace}Neighbor {
    found: u32,
    matrixLevel: u32,
    patchIndex: u32,
};

@group(${group}) @binding(${visibleInstances})
var<storage, read> ${namespace}_visible_instances: array<GpuWebMercatorQuadCoverPatch>;
@group(${group}) @binding(${lookupEntries})
var<storage, read> ${namespace}_lookup_entries:
    array<GpuWebMercatorQuadCoverLookupEntry>;

fn ${namespace}_missing() -> ${namespace}Neighbor {
    return ${namespace}Neighbor(0u, 0u, 0xffffffffu);
}

fn ${namespace}_lookup(
    matrix_level: u32,
    tile_row: u32,
    tile_col: u32,
    lookup_capacity: u32,
) -> ${namespace}Neighbor {
    for (var probe = 0u; probe < lookup_capacity; probe += 1u) {
        let slot = GpuWebMercatorQuadCover_lookupSlot(
            matrix_level,
            tile_row,
            tile_col,
            probe,
            lookup_capacity,
        );
        let entry = ${namespace}_lookup_entries[slot];
        if (entry.occupied == 0u) { return ${namespace}_missing(); }
        if (entry.matrixLevel == matrix_level &&
            entry.tileRow == tile_row &&
            entry.tileCol == tile_col) {
            return ${namespace}Neighbor(1u, matrix_level, entry.patchIndex);
        }
    }
    return ${namespace}_missing();
}

fn ${namespace}_covering(
    render_row: u32,
    render_col: u32,
    maximum_matrix_level: u32,
    lookup_capacity: u32,
) -> ${namespace}Neighbor {
    var matrix_level = maximum_matrix_level;
    loop {
        let shift = maximum_matrix_level - matrix_level;
        let result = ${namespace}_lookup(
            matrix_level,
            render_row >> shift,
            render_col >> shift,
            lookup_capacity,
        );
        if (result.found != 0u) { return result; }
        if (matrix_level == 0u) { break; }
        matrix_level -= 1u;
    }
    return ${namespace}_missing();
}

fn ${namespace}_neighbor(
    instance: GpuWebMercatorQuadCoverPatch,
    edge: u32,
    local: vec2f,
    maximum_matrix_level: u32,
    lookup_capacity: u32,
) -> ${namespace}Neighbor {
    let level_delta = maximum_matrix_level - instance.matrixLevel;
    let scale = 1u << level_delta;
    let matrix_width = 1u << maximum_matrix_level;
    let west = instance.tileCol * scale;
    let north = instance.tileRow * scale;
    let along_x = min(scale - 1u, u32(floor(
        clamp(local.x, 0.0f, 0.99999994f) * f32(scale)
    )));
    let along_south = min(scale - 1u, u32(floor(
        clamp(1.0f - local.y, 0.0f, 0.99999994f) * f32(scale)
    )));
    var row = north + along_south;
    var column = west + along_x;
    switch edge {
        case 0u: { column = (west + matrix_width - 1u) % matrix_width; }
        case 1u: { column = (west + scale) % matrix_width; }
        case 2u: {
            if (north == 0u) { return ${namespace}_missing(); }
            row = north - 1u;
        }
        default: {
            row = north + scale;
            if (row >= matrix_width) { return ${namespace}_missing(); }
        }
    }
    return ${namespace}_covering(
        row,
        column,
        maximum_matrix_level,
        lookup_capacity,
    );
}

fn ${namespace}_snap_edge_coordinate(
    coordinate: u32,
    matrix_level: u32,
    neighbor_matrix_level: u32,
    cells_per_edge: u32,
) -> u32 {
    if (neighbor_matrix_level >= matrix_level) { return coordinate; }
    let level_delta = min(matrix_level - neighbor_matrix_level, 31u);
    let step = 1u << level_delta;
    return min(cells_per_edge, ((coordinate + step - 1u) / step) * step);
}
`
    return Object.freeze({
        kind: 'gpu-web-mercator-quad-cover-read-wgsl-module' as const,
        namespace,
        code,
        layoutDependencies: Object.freeze([
            ...shared.layoutDependencies,
            gpuWebMercatorQuadCoverLookupEntryCodec.artifact,
        ]),
        bindings: Object.freeze({ group, visibleInstances, lookupEntries }),
    })
}

export function gpuWebMercatorQuadCoverSharedWgslModule() {

    return sharedWgsl()
}

function sharedWgsl() {

    return Object.freeze({
        code: [
            gpuWebMercatorQuadCoverMapMetaCodec.wgslAccessors({
                namespace: 'GpuWebMercatorQuadCoverMapMeta',
            }),
            gpuWebMercatorQuadCoverPatchCodec.wgslAccessors({
                namespace: 'GpuWebMercatorQuadCoverPatch',
            }),
            `
fn GpuWebMercatorQuadCover_hash(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> u32 {
    var hash = matrixLevel * 0x9e3779b9u;
    hash = (hash ^ tileRow) * 0x85ebca6bu;
    hash = (hash ^ tileCol) * 0xc2b2ae35u;
    hash = hash ^ (hash >> 16u);
    return hash;
}

fn GpuWebMercatorQuadCover_lookupSlot(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
    probe: u32,
    capacity: u32,
) -> u32 {
    return (
        GpuWebMercatorQuadCover_hash(matrixLevel, tileRow, tileCol) + probe
    ) & (capacity - 1u);
}
`,
        ].join('\n'),
        layoutDependencies: Object.freeze([
            gpuWebMercatorQuadCoverMapMetaCodec.artifact,
            gpuWebMercatorQuadCoverPatchCodec.artifact,
        ]),
    })
}

function wgslIdentifier(value: string): string {

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new TypeError('WebMercatorQuad cover WGSL namespace must be an identifier')
    }
    return value
}

function nonNegativeBinding(value: number | undefined, name: string): number {

    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`WebMercatorQuad cover ${name} must be a non-negative integer`)
    }
    return Number(value)
}
