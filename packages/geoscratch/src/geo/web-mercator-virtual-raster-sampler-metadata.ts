import { layoutCodec } from '../scratch/index.js'
import type { LayoutCodec } from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import { WebMercatorQuad, WEB_MERCATOR_QUAD_MAX_ZOOM } from './web-mercator-quad.js'
import type { WebMercatorVirtualRasterField } from './web-mercator-virtual-raster-field.js'

const LEVEL_CAPACITY = WEB_MERCATOR_QUAD_MAX_ZOOM + 1
const NOT_COVERED = 0xffff_ffff

export const rasterSamplerMetadataCodec = layoutCodec({
    name: 'WebMercatorRasterSamplerMetadata',
    fields: [
        { name: 'dimensions', type: 'vec4u' },
        { name: 'decoding', type: 'vec4f' },
        { name: 'scale', type: 'vec4f' },
        { name: 'offset', type: 'vec4f' },
        { name: 'sourceWestNorth', type: 'vec4u' },
        { name: 'sourceEastSouth', type: 'vec4u' },
        { name: 'levelForMatrix', type: { element: 'vec4u', count: Math.ceil(LEVEL_CAPACITY / 4) } },
        { name: 'levels', type: { count: LEVEL_CAPACITY, element: {
            kind: 'struct', name: 'WebMercatorRasterSamplerLevel',
            fields: [
                { name: 'mapping', type: 'vec4u' },
                { name: 'tileBounds', type: 'vec4u' },
                { name: 'texelBounds', type: 'vec4u' },
                { name: 'halfTexel', type: 'vec4u' },
            ],
        } } },
    ],
}, { usage: [ 'uniform', 'readback' ] })

export type PreparedWebMercatorVirtualRasterSampler = Readonly<{
    kind: 'prepared-web-mercator-virtual-raster-sampler'
    model: WebMercatorVirtualRasterField
    layout: LayoutCodec
    /** Returns a fresh caller-owned copy; mutation cannot change this preparation. */
    pack(): Uint8Array
}>

/** Prepares one immutable source interpretation; packing owns no GPU resources or residency. */
export function prepareWebMercatorVirtualRasterSampler(
    model: WebMercatorVirtualRasterField
): PreparedWebMercatorVirtualRasterSampler {

    if (model?.kind !== 'web-mercator-virtual-raster-field' ||
        model.coverage?.tileMatrixSet !== WebMercatorQuad ||
        model.addressSpace?.tileCoverage !== model.coverage ||
        model.addressCodec?.coverage !== model.coverage ||
        model.spatialProfile?.coverage !== model.coverage ||
        model.plane?.addressSpace !== model.addressSpace ||
        model.representation?.field !== model.field ||
        model.representation?.plane !== model.plane ||
        model.addressSpace.levelCount > LEVEL_CAPACITY) {
        return throwGeoDiagnostic({
            code: 'GEO_RASTER_SAMPLER_METADATA_INVALID', phase: 'sampling',
            subject: { kind: 'web-mercator-raster-sampler' },
            message: 'Sampler metadata requires one coherent WebMercator Virtual Raster model.',
            actual: model,
        })
    }
    const { addressSpace, addressCodec, coverage, plane } = model
    const [west, south, east, north] = model.geographicBounds
    const northwest = addressCodec.fromLonLat([west, north])
    const southeast = addressCodec.fromLonLat([east, south])
    const axisWords = (position: typeof northwest, axis: number) => {
        const limb = position.fixed.limbs[axis]!
        return [limb.low, limb.high]
    }
    const levelForMatrix = Array.from({ length: Math.ceil(LEVEL_CAPACITY / 4) }, () =>
        Array<number>(4).fill(NOT_COVERED))
    const levels = Array.from({ length: LEVEL_CAPACITY }, (_, level) => {
        if (level >= addressSpace.levelCount) return {
            mapping: [0, 0, 0, 0], tileBounds: [0, 0, 0, 0],
            texelBounds: [0, 0, 0, 0], halfTexel: [0, 0, 0, 0],
        }
        const matrixId = addressSpace.matrixId(level)
        const matrix = Number(matrixId)
        const limit = coverage.limit(matrixId)!
        const first = addressCodec.address(northwest, matrixId)
        const last = addressCodec.address(southeast, matrixId)
        const minimum = (axis: number) => Math.ceil(texelCoordinate(first, axis) - 0.5)
        const maximum = (axis: number) => Math.floor(texelCoordinate(last, axis) - 0.5)
        const tableOffset = coverage.index({ matrixId, tileCol: limit.minTileCol, tileRow: limit.minTileRow })
        const halfShift = addressCodec.coordinateBits - matrix - 9
        const half = halfShift < 0 ? 0n : 1n << BigInt(halfShift)
        levelForMatrix[Math.floor(matrix / 4)]![matrix % 4] = level
        return {
            mapping: [matrix, tableOffset, limit.maxTileCol - limit.minTileCol + 1, 1],
            tileBounds: [limit.minTileCol, limit.minTileRow, limit.maxTileCol, limit.maxTileRow],
            texelBounds: [minimum(0), minimum(1), east === 180
                ? WebMercatorQuad.matrix(matrixId).matrixWidth * 256 - 1 : maximum(0), maximum(1)],
            halfTexel: [Number(half & 0xffff_ffffn), Number(half >> 32n), 0, 0],
        }
    })
    const expand = (values: readonly number[]) => Array.from({ length: 4 }, (_, index) =>
        values[Math.min(index, values.length - 1)]!)
    const bytes = rasterSamplerMetadataCodec.pack({
        dimensions: [addressSpace.levelCount, ...addressSpace.pageSize, addressCodec.coordinateBits],
        decoding: [plane.sampleType === 'unorm8' ? 255 : 1,
            plane.noData === undefined ? 0 : plane.sampleType === 'unorm8' ? 2 : 1,
            plane.noData ?? 0, 0],
        scale: expand(plane.scale), offset: expand(plane.offset),
        sourceWestNorth: [...axisWords(northwest, 0), ...axisWords(northwest, 1)],
        sourceEastSouth: [...(east === 180 ? [0, 2 ** (addressCodec.coordinateBits - 32)]
            : axisWords(southeast, 0)), ...axisWords(southeast, 1)],
        levelForMatrix, levels,
    })
    return Object.freeze({
        kind: 'prepared-web-mercator-virtual-raster-sampler', model,
        layout: rasterSamplerMetadataCodec,
        pack: () => bytes.slice(),
    })
}

function texelCoordinate(address: ReturnType<WebMercatorVirtualRasterField['addressCodec']['address']>, axis: number): number {

    return (axis === 0 ? address.tile.tileCol : address.tile.tileRow) * 256 +
        address.texel[axis]! + address.subTexel[axis]!
}
