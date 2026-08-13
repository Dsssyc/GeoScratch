import { throwGeoDiagnostic } from './diagnostics.js'
import type { WebMercatorVirtualRasterField } from './web-mercator-virtual-raster-field.js'
import {
    WebMercatorQuad,
    type WebMercatorQuadAddressCodec,
} from './web-mercator-quad.js'

export type WebMercatorVirtualRasterWgslOptions = Readonly<{
    namespace?: string
    addressNamespace?: string
    group: number
    pageTableBinding: number
    atlasBinding: number
    transitionTexels?: number
}>

export type WebMercatorVirtualRasterWgslModule = Readonly<{
    kind: 'web-mercator-virtual-raster-wgsl-module'
    namespace: string
    addressNamespace: string
    code: string
    bindings: Readonly<{
        group: number
        pageTable: number
        atlas: number
    }>
}>

/** Generates precision-aware WGSL for logical Web Mercator raster sampling in any shader stage. */
export function webMercatorVirtualRasterWgslModule(
    model: WebMercatorVirtualRasterField,
    options: WebMercatorVirtualRasterWgslOptions
): WebMercatorVirtualRasterWgslModule {

    assertModel(model)
    const namespace = normalizeNamespace(options?.namespace, 'GeoWebMercatorRaster')
    const addressNamespace = normalizeNamespace(
        options?.addressNamespace,
        namespace + 'Address'
    )
    const transitionTexels = options?.transitionTexels ?? 16
    for (const [ name, value ] of Object.entries({
        group: options?.group,
        pageTableBinding: options?.pageTableBinding,
        atlasBinding: options?.atlasBinding,
    })) {
        if (!Number.isSafeInteger(value) || Number(value) < 0) {
            return invalidWgsl(namespace, 'Virtual Raster WGSL bindings must be non-negative integers.', {
                [name]: value,
            })
        }
    }
    const pageWidth = model.addressSpace.pageSize[0]!
    const pageHeight = model.addressSpace.pageSize[1]!
    if (!Number.isFinite(transitionTexels) || transitionTexels <= 0 ||
        transitionTexels > Math.min(pageWidth, pageHeight) / 2) {
        return invalidWgsl(
            namespace,
            'The cross-level transition width must be finite, positive, and fit inside half a page.',
            { transitionTexels, pageSize: model.addressSpace.pageSize }
        )
    }
    const levelCount = model.addressSpace.levelCount
    const matrixIds = Array.from({ length: levelCount }, (_, level) =>
        Number(model.addressSpace.matrixId(level)) + 'u'
    ).join(', ')
    const minimums: string[] = []
    const maximums: string[] = []
    const [ west, south, east, north ] = model.geographicBounds
    for (let level = 0; level < levelCount; level++) {
        const matrixId = model.addressSpace.matrixId(level)
        const northwest = model.addressCodec.address(
            model.addressCodec.fromLonLat([ west, north ]),
            matrixId
        )
        const southeast = model.addressCodec.address(
            model.addressCodec.fromLonLat([ east, south ]),
            matrixId
        )
        const matrix = WebMercatorQuad.matrix(matrixId)
        const maximumEast = east === 180
            ? matrix.matrixWidth * matrix.tileWidth - 1
            : coveredTexel(southeast, 0, 'maximum', pageWidth)
        minimums.push(
            'vec2u(' + coveredTexel(northwest, 0, 'minimum', pageWidth) + 'u, ' +
            coveredTexel(northwest, 1, 'minimum', pageHeight) + 'u)'
        )
        maximums.push(
            'vec2u(' + maximumEast + 'u, ' +
            coveredTexel(southeast, 1, 'maximum', pageHeight) + 'u)'
        )
    }
    const scale = channelVector(model.plane.scale)
    const offset = channelVector(model.plane.offset)
    const rawScale = model.plane.sampleType === 'unorm8' ? '255.0f' : '1.0f'
    const noData = noDataExpression(model)
    const fixedPosition = addressNamespace + 'FixedPosition'
    const sample = namespace + 'Sample'
    const lines = [
        'struct ' + sample + ' {',
        '    value: vec4f,',
        '    status: u32,',
        '    requested_level: u32,',
        '    resolved_level: u32,',
        '}',
        '',
        '@group(' + options.group + ') @binding(' + options.pageTableBinding +
            ') var<storage, read> ' + namespace + '_page_table: array<u32>;',
        '@group(' + options.group + ') @binding(' + options.atlasBinding +
            ') var ' + namespace + '_atlas: texture_2d<f32>;',
        '',
        'const ' + namespace + '_level_count = ' + levelCount + 'u;',
        'const ' + namespace + '_page_size = vec2u(' + pageWidth + 'u, ' + pageHeight + 'u);',
        'const ' + namespace + '_transition_texels = ' + wgslFloat(transitionTexels) + ';',
        'const ' + namespace + '_matrix = array<u32, ' + levelCount + '>(' + matrixIds + ');',
        'const ' + namespace + '_minimum_texel = array<vec2u, ' + levelCount + '>(' +
            minimums.join(', ') + ');',
        'const ' + namespace + '_maximum_texel = array<vec2u, ' + levelCount + '>(' +
            maximums.join(', ') + ');',
        '',
        'fn ' + namespace + '_missing(level: u32) -> ' + sample + ' {',
        '    return ' + sample + '(vec4f(0.0), 0u, level, level);',
        '}',
        '',
        'fn ' + namespace + '_failed(level: u32) -> ' + sample + ' {',
        '    return ' + sample + '(vec4f(0.0), 4u, level, level);',
        '}',
        '',
        'fn ' + namespace + '_resolution_global(input_texel: vec2i, level: u32) -> vec2u {',
        '    let texel = vec2u(clamp(input_texel, vec2i(' + namespace +
            '_minimum_texel[level]), vec2i(' + namespace + '_maximum_texel[level])));',
        '    let matrix = ' + namespace + '_matrix[level];',
        '    let tile = texel / ' + namespace + '_page_size;',
        '    let table_index = ' + addressNamespace + '_compact_index(matrix, tile);',
        '    if (table_index == ' + addressNamespace + '_not_covered) { return vec2u(0u, level); }',
        '    let base = table_index * 8u;',
        '    let status = ' + namespace + '_page_table[base + 3u];',
        '    return vec2u(status, select(level, ' + namespace +
            '_page_table[base + 2u], status != 0u));',
        '}',
        '',
        'fn ' + namespace + '_load_global(input_texel: vec2i, level: u32) -> ' + sample + ' {',
        '    let texel = vec2u(clamp(input_texel, vec2i(' + namespace +
            '_minimum_texel[level]), vec2i(' + namespace + '_maximum_texel[level])));',
        '    let matrix = ' + namespace + '_matrix[level];',
        '    let tile = texel / ' + namespace + '_page_size;',
        '    let table_index = ' + addressNamespace + '_compact_index(matrix, tile);',
        '    if (table_index == ' + addressNamespace + '_not_covered) { return ' +
            namespace + '_missing(level); }',
        '    let base = table_index * 8u;',
        '    let status = ' + namespace + '_page_table[base + 3u];',
        '    if (status == 0u) { return ' + namespace + '_missing(level); }',
        '    if (status == 4u) { return ' + namespace + '_failed(level); }',
        '    let resolved_level = ' + namespace + '_page_table[base + 2u];',
        '    let resolved_matrix = ' + namespace + '_matrix[resolved_level];',
        '    let resolved_texel = texel >> vec2u(matrix - resolved_matrix);',
        '    let local_texel = resolved_texel % ' + namespace + '_page_size;',
        '    let slot = vec2u(' + namespace + '_page_table[base], ' +
            namespace + '_page_table[base + 1u]);',
        '    let raw = textureLoad(' + namespace + '_atlas, vec2i(slot * ' +
            namespace + '_page_size + local_texel), 0);',
        ...(noData === undefined
            ? []
            : [ '    if (' + noData + ') { return ' + sample +
                '(vec4f(0.0), 3u, level, resolved_level); }' ]),
        '    let decoded = raw * ' + rawScale + ' * ' + scale + ' + ' + offset + ';',
        '    return ' + sample + '(decoded, status, level, resolved_level);',
        '}',
        '',
        'fn ' + namespace + '_load_position(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' {',
        '    let address = ' + addressNamespace + '_address(position, ' +
            namespace + '_matrix[level]);',
        '    let texel = address.tile * ' + namespace + '_page_size + address.texel;',
        '    return ' + namespace + '_load_global(vec2i(texel), level);',
        '}',
        '',
        'fn ' + namespace + '_sample_level(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' {',
        '    var sample_level = level;',
        '    var address = ' + addressNamespace + '_address(position, ' +
            namespace + '_matrix[sample_level]);',
        '    for (var iteration = 0u; iteration < ' + namespace +
            '_level_count; iteration++) {',
        '        let base = vec2i(address.tile * ' + namespace + '_page_size + address.texel);',
        '        let tl_resolution = ' + namespace + '_resolution_global(base, sample_level);',
        '        let tr_resolution = ' + namespace +
            '_resolution_global(base + vec2i(1, 0), sample_level);',
        '        let bl_resolution = ' + namespace +
            '_resolution_global(base + vec2i(0, 1), sample_level);',
        '        let br_resolution = ' + namespace +
            '_resolution_global(base + vec2i(1, 1), sample_level);',
        '        if (tl_resolution.x == 4u || tr_resolution.x == 4u || ' +
            'bl_resolution.x == 4u || br_resolution.x == 4u) { return ' +
            namespace + '_failed(level); }',
        '        if (tl_resolution.x == 0u || tr_resolution.x == 0u || ' +
            'bl_resolution.x == 0u || br_resolution.x == 0u) { return ' +
            namespace + '_missing(level); }',
        '        let resolved_level = max(max(tl_resolution.y, tr_resolution.y), ' +
            'max(bl_resolution.y, br_resolution.y));',
        '        if (resolved_level == sample_level) { break; }',
        '        sample_level = resolved_level;',
        '        address = ' + addressNamespace + '_address(position, ' +
            namespace + '_matrix[sample_level]);',
        '    }',
        '    let base = vec2i(address.tile * ' + namespace + '_page_size + address.texel);',
        '    let tl = ' + namespace + '_load_global(base, sample_level);',
        '    let tr = ' + namespace + '_load_global(base + vec2i(1, 0), sample_level);',
        '    let bl = ' + namespace + '_load_global(base + vec2i(0, 1), sample_level);',
        '    let br = ' + namespace + '_load_global(base + vec2i(1, 1), sample_level);',
        '    if (tl.status == 4u || tr.status == 4u || bl.status == 4u || ' +
            'br.status == 4u) { return ' + namespace + '_failed(level); }',
        '    if (tl.status == 0u || tr.status == 0u || bl.status == 0u || ' +
            'br.status == 0u) { return ' + namespace + '_missing(level); }',
        '    if (tl.status == 3u || tr.status == 3u || bl.status == 3u || br.status == 3u) {',
        '        return ' + sample + '(vec4f(0.0), 3u, level, sample_level);',
        '    }',
        '    let value = mix(mix(tl.value, tr.value, address.sub_texel.x), ' +
            'mix(bl.value, br.value, address.sub_texel.x), address.sub_texel.y);',
        '    return ' + sample + '(value, max(max(tl.status, tr.status), ' +
            'max(bl.status, br.status)), level, sample_level);',
        '}',
        '',
        'fn ' + namespace + '_edge_blend_weight(position: ' + fixedPosition +
            ', level: u32) -> f32 {',
        '    let address = ' + addressNamespace + '_address(position, ' +
            namespace + '_matrix[level]);',
        '    let local = vec2f(address.texel) + address.sub_texel;',
        '    let origin = vec2i(address.tile * ' + namespace + '_page_size);',
        '    var weight = 1.0f;',
        '    if (local.x < ' + namespace + '_transition_texels) {',
        '        let neighbor = ' + namespace +
            '_resolution_global(origin + vec2i(-1, i32(address.texel.y)), level);',
        '        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, ' +
            'smoothstep(0.0f, ' + namespace + '_transition_texels, local.x)); }',
        '    }',
        '    if (f32(' + namespace + '_page_size.x) - local.x < ' +
            namespace + '_transition_texels) {',
        '        let neighbor = ' + namespace + '_resolution_global(origin + vec2i(i32(' +
            namespace + '_page_size.x), i32(address.texel.y)), level);',
        '        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, ' +
            'smoothstep(0.0f, ' + namespace + '_transition_texels, f32(' +
            namespace + '_page_size.x) - local.x)); }',
        '    }',
        '    if (local.y < ' + namespace + '_transition_texels) {',
        '        let neighbor = ' + namespace +
            '_resolution_global(origin + vec2i(i32(address.texel.x), -1), level);',
        '        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, ' +
            'smoothstep(0.0f, ' + namespace + '_transition_texels, local.y)); }',
        '    }',
        '    if (f32(' + namespace + '_page_size.y) - local.y < ' +
            namespace + '_transition_texels) {',
        '        let neighbor = ' + namespace + '_resolution_global(origin + vec2i(' +
            'i32(address.texel.x), i32(' + namespace + '_page_size.y)), level);',
        '        if (neighbor.x != 0u && neighbor.y > level) { weight = min(weight, ' +
            'smoothstep(0.0f, ' + namespace + '_transition_texels, f32(' +
            namespace + '_page_size.y) - local.y)); }',
        '    }',
        '    return weight;',
        '}',
        '',
        'fn ' + namespace + '_sample_bilinear(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' {',
        '    let fine = ' + namespace + '_sample_level(position, level);',
        '    if (fine.status == 0u || fine.status == 3u || fine.status == 4u || ' +
            'fine.resolved_level != level || level + 1u >= ' + namespace +
            '_level_count) { return fine; }',
        '    let weight = ' + namespace + '_edge_blend_weight(position, level);',
        '    if (weight >= 1.0f) { return fine; }',
        '    let parent = ' + namespace + '_sample_level(position, level + 1u);',
        '    if (parent.status == 0u || parent.status == 3u || parent.status == 4u) ' +
            '{ return fine; }',
        '    return ' + sample + '(mix(parent.value, fine.value, weight), ' +
            'max(parent.status, fine.status), level, ' +
            'max(parent.resolved_level, fine.resolved_level));',
        '}',
        '',
        'fn ' + namespace + '_sample_vertex(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' { return ' +
            namespace + '_sample_bilinear(position, level); }',
        'fn ' + namespace + '_sample_fragment(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' { return ' +
            namespace + '_sample_bilinear(position, level); }',
        'fn ' + namespace + '_sample_compute(position: ' + fixedPosition +
            ', level: u32) -> ' + sample + ' { return ' +
            namespace + '_sample_bilinear(position, level); }',
        '',
    ]
    return Object.freeze({
        kind: 'web-mercator-virtual-raster-wgsl-module',
        namespace,
        addressNamespace,
        code: model.addressCodec.wgslModule({ namespace: addressNamespace }) +
            '\n\n' + lines.join('\n'),
        bindings: Object.freeze({
            group: options.group,
            pageTable: options.pageTableBinding,
            atlas: options.atlasBinding,
        }),
    })
}

function assertModel(model: WebMercatorVirtualRasterField): void {

    if (model?.kind !== 'web-mercator-virtual-raster-field' ||
        model.coverage?.tileMatrixSet !== WebMercatorQuad ||
        model.addressSpace?.tileCoverage !== model.coverage ||
        model.addressCodec?.coverage !== model.coverage ||
        model.spatialProfile?.coverage !== model.coverage ||
        model.plane?.addressSpace !== model.addressSpace ||
        model.representation?.field !== model.field ||
        model.representation?.plane !== model.plane ||
        model.safetyCoverPages.length === 0) {
        return invalidWgsl(
            'GeoWebMercatorRaster',
            'WebMercator Virtual Raster WGSL requires one coherent field model.',
            model
        )
    }
}

function noDataExpression(model: WebMercatorVirtualRasterField): string | undefined {

    if (model.plane.noData === undefined) return undefined
    const noData = wgslFloat(model.plane.noData)
    return model.plane.sampleType === 'unorm8'
        ? 'abs(raw.x * 255.0f - ' + noData + ') < 0.5f'
        : 'raw.x == ' + noData
}

function channelVector(values: readonly number[]): string {

    const expanded = Array.from({ length: 4 }, (_, index) =>
        wgslFloat(values[Math.min(index, values.length - 1)]!)
    )
    return 'vec4f(' + expanded.join(', ') + ')'
}

function coveredTexel(
    address: ReturnType<WebMercatorQuadAddressCodec['address']>,
    axis: 0 | 1,
    edge: 'minimum' | 'maximum',
    pageSize: number
): number {

    const tileCoordinate = axis === 0 ? address.tile.tileCol : address.tile.tileRow
    const pixelCoordinate = tileCoordinate * pageSize +
        address.texel[axis] + address.subTexel[axis]
    return edge === 'minimum'
        ? Math.ceil(pixelCoordinate - 0.5)
        : Math.floor(pixelCoordinate - 0.5)
}

function wgslFloat(value: number): string {

    const rounded = String(Math.fround(value))
    return (rounded.includes('.') || rounded.includes('e') ? rounded : rounded + '.0') + 'f'
}

function normalizeNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        return invalidWgsl(
            fallback,
            'A WebMercator Virtual Raster WGSL namespace must be an identifier.',
            { namespace }
        )
    }
    return namespace
}

function invalidWgsl(namespace: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIRTUAL_RASTER_ACCESSOR_INVALID',
        phase: 'sampling',
        subject: { kind: 'wgsl-module', id: namespace },
        message,
        expected: { model: 'WebMercatorVirtualRasterField' },
        actual,
    })
}
