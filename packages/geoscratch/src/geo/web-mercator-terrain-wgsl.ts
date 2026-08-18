import { layoutCodec, type LayoutArtifact } from '../scratch/index.js'
import { gpuWebMercatorQuadCoverReadWgslModule } from './gpu-web-mercator-quad-cover-layout.js'

/** Built-in fragment entry point for post-stitch logical-tile wireframe diagnostics. */
export const WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT =
    'WebMercatorTerrain_tile_wireframe'

export type WebMercatorTerrainWgslOptions = Readonly<{
    namespace?: string
    fieldNamespace: string
    addressNamespace: string
    cellsPerPatchEdge: number
    sceneGroup: number
    mapMetaBinding: number
    configBinding: number
    dataGroup: number
    indicesBinding: number
    gridPositionsBinding: number
    visibleInstancesBinding: number
    lookupEntriesBinding: number
}>

export type WebMercatorTerrainWgslModule = Readonly<{
    kind: 'web-mercator-terrain-wgsl-module'
    namespace: string
    code: string
    vertexEntryPoint: string
    tileWireframeFragmentEntryPoint: string
    layoutDependencies: readonly LayoutArtifact[]
    bindings: Readonly<{
        sceneGroup: number
        mapMeta: number
        config: number
        dataGroup: number
        indices: number
        gridPositions: number
        visibleInstances: number
        lookupEntries: number
    }>
}>

export const webMercatorTerrainConfigCodec = layoutCodec({
    name: 'WebMercatorTerrainConfig',
    fields: [
        { name: 'sourceMercatorBox', type: 'vec4f' },
        { name: 'elevationRange', type: 'vec2f' },
        { name: 'coordinateBits', type: 'u32' },
        { name: 'exaggeration', type: 'f32' },
        { name: 'coverMaximumMatrixLevel', type: 'u32' },
        { name: 'coverLookupCapacity', type: 'u32' },
    ],
}, { usage: [ 'uniform' ] })

/** Generates the complete precision-aware Web Mercator terrain vertex and wireframe WGSL. */
export function webMercatorTerrainWgslModule(
    options: WebMercatorTerrainWgslOptions
): WebMercatorTerrainWgslModule {

    const namespace = wgslNamespace(options?.namespace, 'WebMercatorTerrain')
    const fieldNamespace = wgslNamespace(options?.fieldNamespace, 'GeoTerrainField')
    const addressNamespace = wgslNamespace(options?.addressNamespace, 'GeoTerrainAddress')
    const fixedNamespace = `${addressNamespace}Fixed`
    const cellsPerPatchEdge = positivePowerOfTwo(
        options?.cellsPerPatchEdge,
        'cellsPerPatchEdge'
    )
    const cellsPerPatchEdgeBits = Math.log2(cellsPerPatchEdge)
    const bindings = Object.freeze({
        sceneGroup: nonNegativeInteger(options?.sceneGroup, 'sceneGroup'),
        mapMeta: nonNegativeInteger(options?.mapMetaBinding, 'mapMetaBinding'),
        config: nonNegativeInteger(options?.configBinding, 'configBinding'),
        dataGroup: nonNegativeInteger(options?.dataGroup, 'dataGroup'),
        indices: nonNegativeInteger(options?.indicesBinding, 'indicesBinding'),
        gridPositions: nonNegativeInteger(
            options?.gridPositionsBinding,
            'gridPositionsBinding'
        ),
        visibleInstances: nonNegativeInteger(
            options?.visibleInstancesBinding,
            'visibleInstancesBinding'
        ),
        lookupEntries: nonNegativeInteger(
            options?.lookupEntriesBinding,
            'lookupEntriesBinding'
        ),
    })
    assertDistinctBindings(bindings)

    const patchNamespace = `${namespace}Patch`
    const patch = gpuWebMercatorQuadCoverReadWgslModule({
        namespace: patchNamespace,
        group: bindings.dataGroup,
        visibleInstancesBinding: bindings.visibleInstances,
        lookupEntriesBinding: bindings.lookupEntries,
    })
    const vertexEntryPoint = `${namespace}_vertex`
    const tileWireframeFragmentEntryPoint = `${namespace}_tile_wireframe`
    const config = 'webMercatorTerrainConfig'
    const mapMeta = 'webMercatorTerrainMapMeta'
    const indices = 'webMercatorTerrainIndices'
    const positions = 'webMercatorTerrainGridPositions'
    const code = [
        patch.code,
        webMercatorTerrainConfigCodec.wgslAccessors({
            namespace: `${namespace}ConfigLayout`,
        }),
        `
struct ${namespace}VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
}

struct ${namespace}VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) normalizedElevation: f32,
    @location(1) barycentric: vec3f,
    @location(2) @interpolate(flat) tileColor: vec3f,
}

@group(${bindings.sceneGroup}) @binding(${bindings.mapMeta})
var<uniform> ${mapMeta}: GpuWebMercatorQuadCoverMapMeta;
@group(${bindings.sceneGroup}) @binding(${bindings.config})
var<uniform> ${config}: WebMercatorTerrainConfig;

@group(${bindings.dataGroup}) @binding(${bindings.indices})
var<storage, read> ${indices}: array<u32>;
@group(${bindings.dataGroup}) @binding(${bindings.gridPositions})
var<storage, read> ${positions}: array<u32>;

const ${namespace}_cells_per_patch_edge: u32 = ${cellsPerPatchEdge}u;

fn ${namespace}_nan() -> f32 {
    let zero = 0.0f;
    return zero / zero;
}

fn ${namespace}_grid_position(index: u32) -> vec2u {
    return vec2u(${positions}[index * 2u], ${positions}[index * 2u + 1u]);
}

fn ${namespace}_logical_tile_color(instance: GpuWebMercatorQuadCoverPatch) -> vec3f {
    var hash = instance.matrixLevel * 0x9e3779b9u;
    hash = hash ^ (instance.tileRow * 0x85ebca6bu);
    hash = hash ^ (instance.tileCol * 0xc2b2ae35u);
    hash = (hash ^ (hash >> 16u)) * 0x7feb352du;
    hash = (hash ^ (hash >> 15u)) * 0x846ca68bu;
    hash = hash ^ (hash >> 16u);
    return vec3f(
        0.35f + 0.65f * f32(hash & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 8u) & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 16u) & 255u) / 255.0f,
    );
}

fn ${namespace}_barycentric_for_vertex(vertex_index: u32) -> vec3f {
    let corner = vertex_index % 3u;
    return vec3f(
        select(0.0f, 1.0f, corner == 0u),
        select(0.0f, 1.0f, corner == 1u),
        select(0.0f, 1.0f, corner == 2u),
    );
}

fn ${namespace}_triangle_centroid(triangle_id: u32) -> vec2f {
    let first = vec2f(${namespace}_grid_position(${indices}[triangle_id * 3u]));
    let second = vec2f(${namespace}_grid_position(${indices}[triangle_id * 3u + 1u]));
    let third = vec2f(${namespace}_grid_position(${indices}[triangle_id * 3u + 2u]));
    return (first + second + third) / (3.0f * f32(${namespace}_cells_per_patch_edge));
}

fn ${namespace}_fixed_position(
    instance: GpuWebMercatorQuadCoverPatch,
    grid: vec2u,
) -> ${fixedNamespace}Position {
    let shift = ${config}.coordinateBits - instance.matrixLevel - ${cellsPerPatchEdgeBits}u;
    let east_numerator = instance.tileCol * ${namespace}_cells_per_patch_edge + grid.x;
    let south_numerator = instance.tileRow * ${namespace}_cells_per_patch_edge +
        (${namespace}_cells_per_patch_edge - grid.y);
    return ${fixedNamespace}Position(array<${fixedNamespace}Axis, 2>(
        ${fixedNamespace}_from_shifted_u32(east_numerator, shift),
        ${fixedNamespace}_from_shifted_u32(south_numerator, shift),
    ));
}

fn ${namespace}_source_uv(position: ${fixedNamespace}Position) -> vec2f {
    let normalized = vec2f(
        ${fixedNamespace}_fraction_f32(position.axes[0], ${config}.coordinateBits),
        ${fixedNamespace}_fraction_f32(position.axes[1], ${config}.coordinateBits),
    );
    let extent = ${config}.sourceMercatorBox.zw - ${config}.sourceMercatorBox.xy;
    return (normalized - ${config}.sourceMercatorBox.xy) / extent;
}

fn ${namespace}_source_contains(uv: vec2f) -> bool {
    return all(uv >= vec2f(0.0f)) && all(uv <= vec2f(1.0f));
}

fn ${namespace}_position_cs(position: ${fixedNamespace}Position, elevation: f32) -> vec4f {
    let camera_x = ${fixedNamespace}Axis(
        ${mapMeta}.cameraFixedLow.x,
        ${mapMeta}.cameraFixedHigh.x,
    );
    let camera_south = ${fixedNamespace}Axis(
        ${mapMeta}.cameraFixedLow.y,
        ${mapMeta}.cameraFixedHigh.y,
    );
    let relative_x = ${fixedNamespace}_signed_difference_f32(
        position.axes[0],
        camera_x,
    );
    let relative_y = ${fixedNamespace}_signed_difference_f32(
        camera_south,
        position.axes[1],
    );
    let relative_z = ${fixedNamespace}_subtract_expansions_f32(
        vec2f(elevation * ${config}.exaggeration, 0.0f),
        vec2f(${mapMeta}.cameraHigh.z, ${mapMeta}.cameraLow.z),
    );
    return ${mapMeta}.clipFromRelativeWorld * vec4f(
        relative_x,
        relative_y,
        relative_z,
        1.0f,
    );
}

@vertex
fn ${vertexEntryPoint}(input: ${namespace}VertexInput) -> ${namespace}VertexOutput {
    let instance = ${patchNamespace}_visible_instances[input.instanceIndex];
    let triangle_id = input.vertexIndex / 3u;
    var grid = ${namespace}_grid_position(${indices}[input.vertexIndex]);
    let matrix_level = instance.matrixLevel;
    let sampling_level = 0u;
    let centroid = ${namespace}_triangle_centroid(triangle_id);

    if (grid.x == 0u) {
        let neighbor = ${patchNamespace}_neighbor(instance, 0u, centroid,
            ${config}.coverMaximumMatrixLevel, ${config}.coverLookupCapacity);
        if (neighbor.found != 0u) {
            grid.y = ${patchNamespace}_snap_edge_coordinate(
                grid.y, matrix_level, neighbor.matrixLevel, ${namespace}_cells_per_patch_edge);
        }
    }
    if (grid.x == ${namespace}_cells_per_patch_edge) {
        let neighbor = ${patchNamespace}_neighbor(instance, 1u, centroid,
            ${config}.coverMaximumMatrixLevel, ${config}.coverLookupCapacity);
        if (neighbor.found != 0u) {
            grid.y = ${patchNamespace}_snap_edge_coordinate(
                grid.y, matrix_level, neighbor.matrixLevel, ${namespace}_cells_per_patch_edge);
        }
    }
    if (grid.y == 0u) {
        let neighbor = ${patchNamespace}_neighbor(instance, 3u, centroid,
            ${config}.coverMaximumMatrixLevel, ${config}.coverLookupCapacity);
        if (neighbor.found != 0u) {
            grid.x = ${patchNamespace}_snap_edge_coordinate(
                grid.x, matrix_level, neighbor.matrixLevel, ${namespace}_cells_per_patch_edge);
        }
    }
    if (grid.y == ${namespace}_cells_per_patch_edge) {
        let neighbor = ${patchNamespace}_neighbor(instance, 2u, centroid,
            ${config}.coverMaximumMatrixLevel, ${config}.coverLookupCapacity);
        if (neighbor.found != 0u) {
            grid.x = ${patchNamespace}_snap_edge_coordinate(
                grid.x, matrix_level, neighbor.matrixLevel, ${namespace}_cells_per_patch_edge);
        }
    }

    let position = ${namespace}_fixed_position(instance, grid);
    let source_uv = ${namespace}_source_uv(position);
    var output: ${namespace}VertexOutput;
    if (${namespace}_source_contains(source_uv)) {
        let height_sample = ${fieldNamespace}_sample_vertex(position, sampling_level);
        let available = height_sample.status != 0u &&
            height_sample.status != 3u && height_sample.status != 4u;
        let elevation = select(
            ${config}.elevationRange.x,
            height_sample.value.x,
            available,
        );
        output.position = ${namespace}_position_cs(position, elevation);
        output.normalizedElevation = (elevation - ${config}.elevationRange.x) /
            max(${config}.elevationRange.y - ${config}.elevationRange.x, 1e-6f);
    } else {
        output.position = vec4f(${namespace}_nan());
        output.normalizedElevation = 0.0f;
    }
    output.barycentric = ${namespace}_barycentric_for_vertex(input.vertexIndex);
    output.tileColor = ${namespace}_logical_tile_color(instance);
    return output;
}

@fragment
fn ${tileWireframeFragmentEntryPoint}(
    input: ${namespace}VertexOutput,
) -> @location(0) vec4f {
    let width = max(fwidth(input.barycentric), vec3f(1e-5f));
    let interior = smoothstep(vec3f(0.0f), width * 1.35f, input.barycentric);
    let coverage = 1.0f - min(min(interior.x, interior.y), interior.z);
    if (coverage <= 0.01f) { discard; }
    return vec4f(input.tileColor * coverage, coverage);
}
`,
    ].join('\n')
    return Object.freeze({
        kind: 'web-mercator-terrain-wgsl-module' as const,
        namespace,
        code,
        vertexEntryPoint,
        tileWireframeFragmentEntryPoint,
        layoutDependencies: Object.freeze([
            ...patch.layoutDependencies,
            webMercatorTerrainConfigCodec.artifact,
        ]),
        bindings,
    })
}

function wgslNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        throw new TypeError('Web Mercator terrain WGSL namespaces must be identifiers')
    }
    return namespace
}

function nonNegativeInteger(value: number | undefined, name: string): number {

    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`Web Mercator terrain ${name} must be a non-negative integer`)
    }
    return Number(value)
}

function positivePowerOfTwo(value: number | undefined, name: string): number {

    if (!Number.isSafeInteger(value) || Number(value) < 1 ||
        (Number(value) & (Number(value) - 1)) !== 0) {
        throw new TypeError(`Web Mercator terrain ${name} must be a positive power of two`)
    }
    return Number(value)
}

function assertDistinctBindings(bindings: WebMercatorTerrainWgslModule['bindings']): void {

    const scene = [ bindings.mapMeta, bindings.config ]
    const data = [
        bindings.indices,
        bindings.gridPositions,
        bindings.visibleInstances,
        bindings.lookupEntries,
    ]
    if (new Set(scene).size !== scene.length || new Set(data).size !== data.length ||
        (bindings.sceneGroup === bindings.dataGroup &&
            new Set([ ...scene, ...data ]).size !== scene.length + data.length)) {
        throw new TypeError('Web Mercator terrain WGSL bindings must be distinct within a group')
    }
}
