import { surfaceDomain } from './coordinate-domain.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    wideFixedCodec,
    type WideFixedCodec,
    type WideFixedPosition,
} from './position-codec.js'
import {
    tileMatrixSet,
    type TileCoordinate,
    type TileMatrixCoverage,
    type TileMatrixId,
    type TileMatrixSet,
} from './tile-matrix.js'

export const WEB_MERCATOR_QUAD_MAX_LATITUDE = 85.0511287798066
export const WEB_MERCATOR_QUAD_HALF_WORLD = 20_037_508.3427892
export const WEB_MERCATOR_QUAD_WORLD_WIDTH = WEB_MERCATOR_QUAD_HALF_WORLD * 2
export const WEB_MERCATOR_QUAD_MAX_ZOOM = 24

export type GeographicPosition2D = readonly [longitude: number, latitude: number]
export type ProjectedPosition2D = readonly [x: number, y: number]

export type WebMercatorQuadTileBounds = Readonly<{
    projected: Readonly<{
        west: number
        south: number
        east: number
        north: number
    }>
    geographic: Readonly<{
        west: number
        south: number
        east: number
        north: number
    }>
}>

export type WebMercatorQuadModel = TileMatrixSet & Readonly<{
    maxLatitude: number
    project(position: GeographicPosition2D): ProjectedPosition2D
    unproject(position: ProjectedPosition2D): GeographicPosition2D
    tileFromLonLat(position: GeographicPosition2D, matrixId: TileMatrixId): TileCoordinate
    tileFromProjected(position: ProjectedPosition2D, matrixId: TileMatrixId): TileCoordinate
    tileBounds(tile: TileCoordinate): WebMercatorQuadTileBounds
}>

export type WebMercatorQuadPosition = Readonly<{
    kind: 'web-mercator-wide-fixed-position'
    tileMatrixSetId: 'WebMercatorQuad'
    coordinateBits: number
    fixed: WideFixedPosition
}>

export type WebMercatorTileSampleAddress = Readonly<{
    kind: 'web-mercator-tile-sample-address'
    tile: TileCoordinate
    texel: readonly [number, number]
    subTexel: readonly [number, number]
    covered: boolean
    compactIndex?: number
}>

export type WebMercatorQuadAddressCodecDescriptor = Readonly<{
    coverage: TileMatrixCoverage
    coordinateBits?: number
}>

export type WebMercatorQuadAddressWgslOptions = Readonly<{
    namespace?: string
}>

const WEB_MERCATOR_SCALE_DENOMINATORS = Object.freeze([
    559082264.028717,
    279541132.014358,
    139770566.007179,
    69885283.0035897,
    34942641.5017948,
    17471320.7508974,
    8735660.37544871,
    4367830.18772435,
    2183915.09386217,
    1091957.54693108,
    545978.773465544,
    272989.386732772,
    136494.693366386,
    68247.346683193,
    34123.6733415964,
    17061.8366707982,
    8530.91833539913,
    4265.45916769956,
    2132.72958384978,
    1066.36479192489,
    533.182395962445,
    266.591197981222,
    133.295598990611,
    66.6477994953056,
    33.3238997476528,
])

const WEB_MERCATOR_CELL_SIZES = Object.freeze([
    156543.033928041,
    78271.5169640204,
    39135.7584820102,
    19567.8792410051,
    9783.93962050256,
    4891.96981025128,
    2445.98490512564,
    1222.99245256282,
    611.49622628141,
    305.748113140704,
    152.874056570352,
    76.4370282851762,
    38.2185141425881,
    19.109257071294,
    9.55462853564703,
    4.77731426782351,
    2.38865713391175,
    1.19432856695587,
    0.597164283477939,
    0.29858214173897,
    0.149291070869485,
    0.0746455354347424,
    0.0373227677173712,
    0.0186613838586856,
    0.0093306919293428,
])

const baseWebMercatorQuad = tileMatrixSet({
    id: 'WebMercatorQuad',
    title: 'Google Maps Compatible for the World',
    uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
    wellKnownScaleSet: 'http://www.opengis.net/def/wkss/OGC/1.0/GoogleMapsCompatible',
    orderedAxes: [ 'X', 'Y' ],
    boundingBox: {
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
        lowerCorner: [ -WEB_MERCATOR_QUAD_HALF_WORLD, -WEB_MERCATOR_QUAD_HALF_WORLD ],
        upperCorner: [ WEB_MERCATOR_QUAD_HALF_WORLD, WEB_MERCATOR_QUAD_HALF_WORLD ],
    },
    tileMatrices: Array.from({ length: WEB_MERCATOR_QUAD_MAX_ZOOM + 1 }, (_, zoom) => {
        const matrixSize = 2 ** zoom
        return {
            id: String(zoom),
            scaleDenominator: WEB_MERCATOR_SCALE_DENOMINATORS[zoom]!,
            cellSize: WEB_MERCATOR_CELL_SIZES[zoom]!,
            pointOfOrigin: [ -WEB_MERCATOR_QUAD_HALF_WORLD, WEB_MERCATOR_QUAD_HALF_WORLD ],
            cornerOfOrigin: 'topLeft',
            tileWidth: 256,
            tileHeight: 256,
            matrixWidth: matrixSize,
            matrixHeight: matrixSize,
        }
    }),
})

export const WebMercatorQuad: WebMercatorQuadModel = Object.freeze({
    ...baseWebMercatorQuad,
    maxLatitude: WEB_MERCATOR_QUAD_MAX_LATITUDE,
    project(position) {

        assertFinitePair(position, 'longitude/latitude')
        const longitude = wrapLongitude(position[0])
        const latitude = clampLatitude(position[1])
        if (longitude === 0 && latitude === 0) return Object.freeze([ 0, 0 ])
        const x = longitude / 180 * WEB_MERCATOR_QUAD_HALF_WORLD
        const radians = latitude * Math.PI / 180
        const y = Math.max(
            -WEB_MERCATOR_QUAD_HALF_WORLD,
            Math.min(
                WEB_MERCATOR_QUAD_HALF_WORLD,
                WEB_MERCATOR_QUAD_HALF_WORLD / Math.PI *
                    Math.log(Math.tan(Math.PI / 4 + radians / 2))
            )
        )
        return Object.freeze([ normalizeZero(x), normalizeZero(y) ])
    },
    unproject(position) {

        assertFinitePair(position, 'projected Web Mercator')
        const x = periodicProjectedX(position[0])
        const y = Math.max(
            -WEB_MERCATOR_QUAD_HALF_WORLD,
            Math.min(WEB_MERCATOR_QUAD_HALF_WORLD, position[1])
        )
        const longitude = x / WEB_MERCATOR_QUAD_HALF_WORLD * 180
        const latitude = Math.atan(Math.sinh(y / WEB_MERCATOR_QUAD_HALF_WORLD * Math.PI)) *
            180 / Math.PI
        return Object.freeze([ normalizeZero(longitude), normalizeZero(latitude) ])
    },
    tileFromLonLat(position, matrixId) {

        return tileFromNormalized(
            (wrapLongitude(position[0]) + 180) / 360,
            latitudeToWorldY(position[1]),
            matrixId
        )
    },
    tileFromProjected(position, matrixId) {

        assertFinitePair(position, 'projected Web Mercator')
        return tileFromNormalized(
            positiveModulo(
                (position[0] + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
                1
            ),
            Math.max(0, Math.min(
                1,
                (WEB_MERCATOR_QUAD_HALF_WORLD - position[1]) / WEB_MERCATOR_QUAD_WORLD_WIDTH
            )),
            matrixId
        )
    },
    tileBounds(tile) {

        if (tile.tileMatrixSetId !== baseWebMercatorQuad.id) {
            return throwGeoDiagnostic({
                code: 'GEO_TILE_COORDINATE_INVALID',
                phase: 'coordinate',
                subject: { kind: 'tile-matrix-set', id: baseWebMercatorQuad.id },
                message: 'Tile bounds require a tile from WebMercatorQuad.',
                expected: { tileMatrixSetId: baseWebMercatorQuad.id },
                actual: tile,
            })
        }
        const accepted = baseWebMercatorQuad.tile(tile)
        const matrix = baseWebMercatorQuad.matrix(accepted.matrixId)
        const west = matrix.pointOfOrigin[0] + accepted.tileCol * matrix.tileWidth * matrix.cellSize
        const north = matrix.pointOfOrigin[1] - accepted.tileRow * matrix.tileHeight * matrix.cellSize
        const east = west + matrix.tileWidth * matrix.cellSize
        const south = north - matrix.tileHeight * matrix.cellSize
        return Object.freeze({
            projected: Object.freeze({ west, south, east, north }),
            geographic: Object.freeze({
                west: accepted.tileCol / matrix.matrixWidth * 360 - 180,
                south: projectedYToLatitude(south),
                east: (accepted.tileCol + 1) / matrix.matrixWidth * 360 - 180,
                north: projectedYToLatitude(north),
            }),
        })
    },
})

export class WebMercatorQuadAddressCodec {

    readonly coverage: TileMatrixCoverage
    readonly coordinateBits: number
    readonly worldQuanta: bigint
    readonly quantumMeters: number
    readonly bytesPerPosition = 16
    readonly positionCodec: WideFixedCodec

    constructor(descriptor: WebMercatorQuadAddressCodecDescriptor) {

        if (descriptor.coverage.tileMatrixSet !== WebMercatorQuad) {
            throwGeoDiagnostic({
                code: 'GEO_TILE_MATRIX_SET_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec' },
                message: 'WebMercatorQuad addressing requires WebMercatorQuad coverage.',
                expected: { tileMatrixSetId: WebMercatorQuad.id },
                actual: {
                    tileMatrixSetId: descriptor.coverage.tileMatrixSet.id,
                    canonicalModel: descriptor.coverage.tileMatrixSet === WebMercatorQuad,
                },
            })
        }
        const coordinateBits = descriptor.coordinateBits ?? 40
        if (!Number.isSafeInteger(coordinateBits) || coordinateBits < 32 || coordinateBits > 52) {
            throwGeoDiagnostic({
                code: 'GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec' },
                message: 'WebMercatorQuad fixed coordinates require 32 to 52 world-fraction bits.',
                expected: { minimum: 32, maximum: 52 },
                actual: { coordinateBits },
            })
        }
        this.coverage = descriptor.coverage
        this.coordinateBits = coordinateBits
        this.worldQuanta = 1n << BigInt(coordinateBits)
        this.quantumMeters = WEB_MERCATOR_QUAD_WORLD_WIDTH / Number(this.worldQuanta)
        this.positionCodec = wideFixedCodec({
            domain: surfaceDomain({
                id: `WebMercatorQuad.canonical.${coordinateBits}`,
                axes: [
                    { name: 'east', unit: 'm' },
                    { name: 'south', unit: 'm' },
                ],
                embeddingAxes: [
                    { name: 'x', unit: 'm' },
                    { name: 'y', unit: 'm' },
                    { name: 'z', unit: 'm' },
                ],
            }),
            quantum: this.quantumMeters,
        })
        Object.freeze(this)
    }

    fromLonLat(position: GeographicPosition2D): WebMercatorQuadPosition {

        return this.fromProjected(WebMercatorQuad.project(position))
    }

    fromProjected(position: ProjectedPosition2D): WebMercatorQuadPosition {

        assertFinitePair(position, 'projected Web Mercator')
        const normalizedX = positiveModulo(
            (position[0] + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
            1
        )
        const normalizedY = Math.max(0, Math.min(
            1,
            (WEB_MERCATOR_QUAD_HALF_WORLD - position[1]) / WEB_MERCATOR_QUAD_WORLD_WIDTH
        ))
        return this.fromWorldQuanta([
            BigInt(Math.round(normalizedX * Number(this.worldQuanta))),
            BigInt(Math.min(
                Number(this.worldQuanta - 1n),
                Math.round(normalizedY * Number(this.worldQuanta))
            )),
        ])
    }

    fromWorldQuanta(values: readonly bigint[]): WebMercatorQuadPosition {

        if (values.length !== 2 || typeof values[0] !== 'bigint' || typeof values[1] !== 'bigint') {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec' },
                message: 'Canonical WebMercatorQuad positions require two integer axes.',
                expected: { dimensions: 2, scalar: 'bigint' },
                actual: values,
            })
        }
        const x = moduloBigInt(values[0]!, this.worldQuanta)
        const y = values[1]!
        if (y < 0n || y >= this.worldQuanta) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_OVERFLOW',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec', axis: 'south' },
                message: 'Canonical WebMercatorQuad north/south coordinates cannot leave the projected world.',
                expected: { minimum: '0', maximum: String(this.worldQuanta - 1n) },
                actual: { value: String(y) },
            })
        }
        return Object.freeze({
            kind: 'web-mercator-wide-fixed-position',
            tileMatrixSetId: 'WebMercatorQuad',
            coordinateBits: this.coordinateBits,
            fixed: this.positionCodec.fromQuanta([ x, y ]),
        })
    }

    toWorldQuanta(position: WebMercatorQuadPosition): readonly [bigint, bigint] {

        this.#assertPosition(position)
        const values = this.positionCodec.toQuanta(position.fixed)
        return Object.freeze([ values[0]!, values[1]! ])
    }

    toProjected(position: WebMercatorQuadPosition): ProjectedPosition2D {

        const [ x, y ] = this.toWorldQuanta(position)
        return Object.freeze([
            Number(x) / Number(this.worldQuanta) * WEB_MERCATOR_QUAD_WORLD_WIDTH -
                WEB_MERCATOR_QUAD_HALF_WORLD,
            WEB_MERCATOR_QUAD_HALF_WORLD -
                Number(y) / Number(this.worldQuanta) * WEB_MERCATOR_QUAD_WORLD_WIDTH,
        ])
    }

    advance(
        position: WebMercatorQuadPosition,
        deltaQuanta: readonly [bigint, bigint]
    ): WebMercatorQuadPosition {

        const values = this.toWorldQuanta(position)
        return this.fromWorldQuanta([
            values[0] + deltaQuanta[0],
            values[1] + deltaQuanta[1],
        ])
    }

    advanceMeters(
        position: WebMercatorQuadPosition,
        deltaMeters: readonly [number, number]
    ): WebMercatorQuadPosition {

        assertFinitePair(deltaMeters, 'Web Mercator displacement')
        const deltaQuanta = deltaMeters.map(value => shaderCompatibleRound(
            Math.fround(Math.fround(value) / Math.fround(this.quantumMeters))
        ))
        if (deltaQuanta.some(value => value < -2_147_483_648 || value > 2_147_483_647)) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_OVERFLOW',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec' },
                message: 'A single shader-compatible displacement must fit signed i32 quanta.',
                expected: { minimum: -2_147_483_648, maximum: 2_147_483_647 },
                actual: { deltaQuanta },
            })
        }
        return this.advance(position, [ BigInt(deltaQuanta[0]!), BigInt(deltaQuanta[1]!) ])
    }

    address(
        position: WebMercatorQuadPosition,
        matrixId: TileMatrixId
    ): WebMercatorTileSampleAddress {

        const matrix = WebMercatorQuad.matrix(matrixId)
        const zoom = numericZoom(matrix.id)
        if (zoom + 8 > this.coordinateBits) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED',
                phase: 'sampling',
                subject: { kind: 'web-mercator-address-codec', matrixId },
                message: 'Canonical coordinate bits cannot identify every texel at this matrix.',
                expected: { minimumCoordinateBits: zoom + 8 },
                actual: { coordinateBits: this.coordinateBits },
            })
        }
        const values = this.toWorldQuanta(position)
        const subBits = this.coordinateBits - zoom - 8
        const globalTexel = values.map(value => Number(value >> BigInt(subBits)))
        const tile = WebMercatorQuad.tile({
            matrixId,
            tileRow: Math.floor(globalTexel[1]! / matrix.tileHeight),
            tileCol: Math.floor(globalTexel[0]! / matrix.tileWidth),
        })
        const compactIndex = this.coverage.tryIndex(tile)
        return Object.freeze({
            kind: 'web-mercator-tile-sample-address',
            tile,
            texel: Object.freeze([
                globalTexel[0]! % matrix.tileWidth,
                globalTexel[1]! % matrix.tileHeight,
            ]) as readonly [number, number],
            subTexel: Object.freeze([
                wgslSubTexel(values[0]!, subBits),
                wgslSubTexel(values[1]!, subBits),
            ]) as readonly [number, number],
            covered: compactIndex !== undefined,
            ...(compactIndex === undefined ? {} : { compactIndex }),
        })
    }

    wgslModule(options: WebMercatorQuadAddressWgslOptions = {}): string {

        const namespace = normalizeNamespace(options.namespace, 'GeoWebMercatorQuad')
        const fixedNamespace = `${namespace}Fixed`
        const fixed = this.positionCodec.wgslModule({ namespace: fixedNamespace })
        const coverage = this.coverage.wgslModule({ namespace })
        const highBits = this.coordinateBits - 32
        const worldHighMask = highBits === 0 ? 0 : 2 ** highBits - 1
        return `${fixed}\n${coverage}\n` +
            `struct ${namespace}Advance {\n` +
            `    position: ${fixedNamespace}Position,\n` +
            `    north_south_valid: u32,\n` +
            `}\n\n` +
            `struct ${namespace}Address {\n` +
            `    tile: vec2u,\n` +
            `    texel: vec2u,\n` +
            `    sub_texel: vec2f,\n` +
            `    compact_index: u32,\n` +
            `    covered: u32,\n` +
            `}\n\n` +
            `fn ${namespace}_shift_right(axis: ${fixedNamespace}Axis, shift: u32) -> u32 {\n` +
            `    if (shift == 0u) { return axis.low; }\n` +
            `    if (shift < 32u) { return (axis.low >> shift) | (axis.high << (32u - shift)); }\n` +
            `    return axis.high >> (shift - 32u);\n` +
            `}\n\n` +
            `fn ${namespace}_add_i32_axis(value: ${fixedNamespace}Axis, delta: i32) -> ${fixedNamespace}Axis {\n` +
            `    let delta_axis = ${fixedNamespace}Axis(bitcast<u32>(delta), select(0u, 0xffffffffu, delta < 0));\n` +
            `    return ${fixedNamespace}_add_axis(value, delta_axis);\n` +
            `}\n\n` +
            `fn ${namespace}_advance_i32(value: ${fixedNamespace}Position, delta: vec2i) -> ${namespace}Advance {\n` +
            `    var position = value;\n` +
            `    position.axes[0] = ${namespace}_add_i32_axis(position.axes[0], delta.x);\n` +
            `    position.axes[1] = ${namespace}_add_i32_axis(position.axes[1], delta.y);\n` +
            `    position.axes[0].high &= ${worldHighMask}u;\n` +
            `    let north_south_valid = select(0u, 1u, position.axes[1].high <= ${worldHighMask}u);\n` +
            `    return ${namespace}Advance(position, north_south_valid);\n` +
            `}\n\n` +
            `fn ${namespace}_advance_meters(value: ${fixedNamespace}Position, delta: vec2f) -> ${namespace}Advance {\n` +
            `    let delta_quanta = vec2i(round(delta / vec2f(${Math.fround(this.quantumMeters)}f)));\n` +
            `    return ${namespace}_advance_i32(value, delta_quanta);\n` +
            `}\n\n` +
            `fn ${namespace}_sub_texel(axis: ${fixedNamespace}Axis, bits: u32) -> f32 {\n` +
            `    if (bits == 0u) { return 0.0f; }\n` +
            `    if (bits <= 32u) {\n` +
            `        var remainder = axis.low;\n` +
            `        if (bits < 32u) { remainder &= (1u << bits) - 1u; }\n` +
            `        return ldexp(f32(remainder), -i32(bits));\n` +
            `    }\n` +
            `    let high_bits = bits - 32u;\n` +
            `    let high_remainder = axis.high & ((1u << high_bits) - 1u);\n` +
            `    return ldexp(f32(high_remainder), -i32(high_bits)) + ldexp(f32(axis.low), -i32(bits));\n` +
            `}\n\n` +
            `fn ${namespace}_address(value: ${fixedNamespace}Position, matrix: u32) -> ${namespace}Address {\n` +
            `    if (matrix > ${WEB_MERCATOR_QUAD_MAX_ZOOM}u || matrix + 8u > ${this.coordinateBits}u) {\n` +
            `        return ${namespace}Address(vec2u(), vec2u(), vec2f(), ${namespace}_not_covered, 0u);\n` +
            `    }\n` +
            `    let sub_bits = ${this.coordinateBits}u - matrix - 8u;\n` +
            `    let global_texel = vec2u(\n` +
            `        ${namespace}_shift_right(value.axes[0], sub_bits),\n` +
            `        ${namespace}_shift_right(value.axes[1], sub_bits)\n` +
            `    );\n` +
            `    let tile = global_texel >> vec2u(8u);\n` +
            `    let compact_index = ${namespace}_compact_index(matrix, tile);\n` +
            `    return ${namespace}Address(\n` +
            `        tile,\n` +
            `        global_texel & vec2u(255u),\n` +
            `        vec2f(\n` +
            `            ${namespace}_sub_texel(value.axes[0], sub_bits),\n` +
            `            ${namespace}_sub_texel(value.axes[1], sub_bits)\n` +
            `        ),\n` +
            `        compact_index,\n` +
            `        select(1u, 0u, compact_index == ${namespace}_not_covered)\n` +
            `    );\n` +
            `}\n`
    }

    #assertPosition(position: WebMercatorQuadPosition): void {

        if (position.kind !== 'web-mercator-wide-fixed-position' ||
            position.tileMatrixSetId !== WebMercatorQuad.id ||
            position.coordinateBits !== this.coordinateBits) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_DOMAIN_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'web-mercator-address-codec' },
                message: 'Canonical position and WebMercatorQuad codec must share one precision domain.',
                expected: {
                    tileMatrixSetId: WebMercatorQuad.id,
                    coordinateBits: this.coordinateBits,
                },
                actual: position,
            })
        }
    }
}

export function webMercatorQuadAddressCodec(
    descriptor: WebMercatorQuadAddressCodecDescriptor
): WebMercatorQuadAddressCodec {

    return new WebMercatorQuadAddressCodec(descriptor)
}

function tileFromNormalized(x: number, y: number, matrixId: TileMatrixId): TileCoordinate {

    const matrix = baseWebMercatorQuad.matrix(matrixId)
    return baseWebMercatorQuad.tile({
        matrixId,
        tileRow: Math.min(matrix.matrixHeight - 1, Math.floor(Math.max(0, y) * matrix.matrixHeight)),
        tileCol: Math.min(matrix.matrixWidth - 1, Math.floor(positiveModulo(x, 1) * matrix.matrixWidth)),
    })
}

function latitudeToWorldY(value: number): number {

    if (!Number.isFinite(value)) throw new TypeError('Latitude must be finite.')
    const latitude = clampLatitude(value) * Math.PI / 180
    const sine = Math.sin(latitude)
    return Math.max(0, Math.min(1, 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)))
}

function wrapLongitude(value: number): number {

    if (!Number.isFinite(value)) throw new TypeError('Longitude must be finite.')
    return normalizeZero(positiveModulo(value + 180, 360) - 180)
}

function clampLatitude(value: number): number {

    if (!Number.isFinite(value)) throw new TypeError('Latitude must be finite.')
    return Math.max(-WEB_MERCATOR_QUAD_MAX_LATITUDE, Math.min(WEB_MERCATOR_QUAD_MAX_LATITUDE, value))
}

function periodicProjectedX(value: number): number {

    return positiveModulo(
        value + WEB_MERCATOR_QUAD_HALF_WORLD,
        WEB_MERCATOR_QUAD_WORLD_WIDTH
    ) - WEB_MERCATOR_QUAD_HALF_WORLD
}

function projectedYToLatitude(value: number): number {

    const y = Math.max(
        -WEB_MERCATOR_QUAD_HALF_WORLD,
        Math.min(WEB_MERCATOR_QUAD_HALF_WORLD, value)
    )
    return Math.atan(Math.sinh(y / WEB_MERCATOR_QUAD_HALF_WORLD * Math.PI)) * 180 / Math.PI
}

function positiveModulo(value: number, modulus: number): number {

    return ((value % modulus) + modulus) % modulus
}

function moduloBigInt(value: bigint, modulus: bigint): bigint {

    return ((value % modulus) + modulus) % modulus
}

function shaderCompatibleRound(value: number): number {

    const lower = Math.floor(value)
    const fraction = value - lower
    if (fraction < 0.5) return lower
    if (fraction > 0.5) return lower + 1
    return lower % 2 === 0 ? lower : lower + 1
}

function wgslSubTexel(value: bigint, bits: number): number {

    if (bits === 0) return 0
    if (bits <= 32) {
        const mask = (1n << BigInt(bits)) - 1n
        const remainder = Math.fround(Number(value & mask))
        return Math.fround(remainder * 2 ** -bits)
    }
    const highBits = bits - 32
    const highMask = (1n << BigInt(highBits)) - 1n
    const highRemainder = Math.fround(Number((value >> 32n) & highMask))
    const low = Math.fround(Number(value & 0xffff_ffffn))
    const highFraction = Math.fround(highRemainder * 2 ** -highBits)
    const lowFraction = Math.fround(low * 2 ** -bits)
    return Math.fround(highFraction + lowFraction)
}

function numericZoom(matrixId: string): number {

    const zoom = Number(matrixId)
    if (!Number.isSafeInteger(zoom) || zoom < 0 || String(zoom) !== matrixId) {
        throw new TypeError('WebMercatorQuad matrix ids must be canonical zoom integers.')
    }
    return zoom
}

function assertFinitePair(value: readonly number[], label: string): void {

    if (value.length !== 2 || value.some(coordinate => !Number.isFinite(coordinate))) {
        throw new TypeError(`${label} position requires two finite coordinates.`)
    }
}

function normalizeNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        throw new TypeError('WGSL namespace must be a valid identifier.')
    }
    return namespace
}

function normalizeZero(value: number): number {

    return Object.is(value, -0) ? 0 : value
}
