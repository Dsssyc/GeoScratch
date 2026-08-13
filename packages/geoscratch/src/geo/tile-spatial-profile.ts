import { throwGeoDiagnostic } from './diagnostics.js'
import {
    regularQuadTileTopology,
    type TileTopology,
} from './tile-topology.js'
import type {
    TileCoordinate,
    TileCoordinateDescriptor,
    TileMatrixCoverage,
} from './tile-matrix.js'
import {
    WebMercatorQuad,
    type ProjectedPosition2D,
    type WebMercatorQuadAddressCodec,
} from './web-mercator-quad.js'

export type PlanarTileBounds = Readonly<{
    west: number
    south: number
    east: number
    north: number
}>

export type TileSpatialCameraEncoding = Readonly<{
    low: readonly [number, number]
    high: readonly [number, number]
}>

export type TileSpatialFrontierEncoding = Readonly<{
    coordinateBits: number
    rootColumnBits: number
    rootRowBits: number
    quantumMeters: readonly [number, number]
    highLimbMeters: readonly [number, number]
}>

export type PlanarTileSpatialProfileDescriptor = Readonly<{
    id: string
    topology: TileTopology
    coverage: TileMatrixCoverage
    coordinateBits?: number
    wrapX?: boolean
}>

export type WebMercatorPlanarTileSpatialProfileDescriptor = Readonly<{
    addressCodec: WebMercatorQuadAddressCodec
}>

export type TileSpatialProfile = Readonly<{
    kind: 'tile-spatial-profile'
    id: string
    coordinateFrame: 'planar'
    topology: TileTopology
    coverage: TileMatrixCoverage
    coordinateBits: number
    frontierEncoding: TileSpatialFrontierEncoding
    matrixLevel(tile: Pick<TileCoordinate, 'tileMatrixSetId' | 'matrixId'>): number
    matrixId(matrixLevel: number): string
    tileBounds(tile: TileCoordinateDescriptor): PlanarTileBounds
    normalizedBounds(tile: TileCoordinateDescriptor): ReturnType<TileTopology['normalizedBounds']>
    parent(tile: TileCoordinateDescriptor): TileCoordinate | undefined
    children(tile: TileCoordinateDescriptor): readonly TileCoordinate[]
    coveredChildren(tile: TileCoordinateDescriptor): readonly TileCoordinate[]
    path(tile: TileCoordinateDescriptor): readonly number[]
    comparePath(left: TileCoordinateDescriptor, right: TileCoordinateDescriptor): number
    isPathPrefix(prefix: TileCoordinateDescriptor, candidate: TileCoordinateDescriptor): boolean
    encodeCamera(position: ProjectedPosition2D): TileSpatialCameraEncoding
}>

export type WebMercatorPlanarTileSpatialProfile = TileSpatialProfile & Readonly<{
    addressCodec: WebMercatorQuadAddressCodec
}>

/** Defines planar bounds, camera encoding, and frontier encoding for one tiled topology. */
export function planarTileSpatialProfile(
    descriptor: PlanarTileSpatialProfileDescriptor
): TileSpatialProfile {

    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        descriptor.topology?.kind !== 'tile-topology' ||
        descriptor.coverage?.tileMatrixSet !== descriptor.topology.tileMatrixSet) {
        return invalidProfile(
            'A planar tile spatial profile requires one topology and coverage over the same TileMatrixSet.',
            { id: 'non-empty string', topologyCoverage: 'same TileMatrixSet object' },
            descriptor
        )
    }
    const matrixSet = descriptor.topology.tileMatrixSet
    const coverage = descriptor.coverage
    const wrapX = descriptor.wrapX === true
    const root = matrixSet.tileMatrices[0]!
    if (matrixSet.tileMatrices.some(matrix => matrix.cornerOfOrigin !== 'topLeft')) {
        return invalidProfile(
            'The current planar frontier profile requires top-left tile matrix origins.',
            { cornerOfOrigin: 'topLeft' },
            matrixSet.tileMatrices.map(matrix => ({ id: matrix.id, corner: matrix.cornerOfOrigin }))
        )
    }
    const rootColumnBits = exactPowerOfTwoExponent(root.matrixWidth)
    const rootRowBits = exactPowerOfTwoExponent(root.matrixHeight)
    if (rootColumnBits === undefined || rootRowBits === undefined) {
        return invalidProfile(
            'GPU frontier fixed addressing requires power-of-two root matrix dimensions.',
            { matrixWidth: 'power of two', matrixHeight: 'power of two' },
            { matrixWidth: root.matrixWidth, matrixHeight: root.matrixHeight }
        )
    }
    const coordinateBits = descriptor.coordinateBits ?? 40
    if (!Number.isSafeInteger(coordinateBits) || coordinateBits < 32 || coordinateBits > 52 ||
        coordinateBits < rootColumnBits || coordinateBits < rootRowBits) {
        return invalidProfile(
            'Planar fixed coordinates require 32 to 52 bits and enough bits for every root.',
            { minimum: 32, maximum: 52, rootColumnBits, rootRowBits },
            { coordinateBits }
        )
    }
    const maximumMatrixLevel = matrixSet.tileMatrices.length - 1
    if (maximumMatrixLevel + rootColumnBits > coordinateBits ||
        maximumMatrixLevel + rootRowBits > coordinateBits) {
        return invalidProfile(
            'The complete tile hierarchy must fit the fixed-coordinate frontier encoding.',
            {
                maximumColumnLevel: coordinateBits - rootColumnBits,
                maximumRowLevel: coordinateBits - rootRowBits,
            },
            { maximumMatrixLevel, rootColumnBits, rootRowBits, coordinateBits }
        )
    }
    const lower = matrixSet.boundingBox.lowerCorner
    const upper = matrixSet.boundingBox.upperCorner
    const width = upper[0] - lower[0]
    const height = upper[1] - lower[1]
    if (matrixSet.boundingBox.crs !== matrixSet.crs ||
        !Number.isFinite(width) || width <= 0 ||
        !Number.isFinite(height) || height <= 0) {
        return invalidProfile(
            'A planar profile requires one finite bounding box in its TileMatrixSet CRS.',
            { boundingBoxCrs: matrixSet.crs, width: 'finite positive', height: 'finite positive' },
            { boundingBox: matrixSet.boundingBox, width, height }
        )
    }
    for (const matrix of matrixSet.tileMatrices) {
        const matrixWidth = matrix.matrixWidth * matrix.tileWidth * matrix.cellSize
        const matrixHeight = matrix.matrixHeight * matrix.tileHeight * matrix.cellSize
        if (!approximatelyEqual(matrix.pointOfOrigin[0], lower[0]) ||
            !approximatelyEqual(matrix.pointOfOrigin[1], upper[1]) ||
            !approximatelyEqual(matrixWidth, width) ||
            !approximatelyEqual(matrixHeight, height)) {
            return invalidProfile(
                'Every planar tile matrix must span the same bounding box used by the fixed-coordinate GPU encoding.',
                {
                    pointOfOrigin: [ lower[0], upper[1] ],
                    matrixWidth: width,
                    matrixHeight: height,
                },
                {
                    matrixId: matrix.id,
                    pointOfOrigin: matrix.pointOfOrigin,
                    matrixWidth,
                    matrixHeight,
                }
            )
        }
    }
    const worldQuanta = 1n << BigInt(coordinateBits)
    const quantumMeters = Object.freeze([
        width / Number(worldQuanta),
        height / Number(worldQuanta),
    ]) as readonly [number, number]
    const highLimbMeters = Object.freeze([
        quantumMeters[0] * 2 ** 32,
        quantumMeters[1] * 2 ** 32,
    ]) as readonly [number, number]
    if ([ ...quantumMeters, ...highLimbMeters ].some(value =>
        !Number.isFinite(value) || value <= 0
    )) {
        return invalidProfile(
            'Planar world dimensions must produce finite positive GPU fixed-coordinate units.',
            { quantumMeters: 'finite positive pair', highLimbMeters: 'finite positive pair' },
            { quantumMeters, highLimbMeters }
        )
    }
    const topology = descriptor.topology

    const profile: TileSpatialProfile = {
        kind: 'tile-spatial-profile',
        id: descriptor.id,
        coordinateFrame: 'planar',
        topology,
        coverage,
        coordinateBits,
        frontierEncoding: Object.freeze({
            coordinateBits,
            rootColumnBits,
            rootRowBits,
            quantumMeters,
            highLimbMeters,
        }),
        matrixLevel: tile => topology.matrixLevel(tile),
        matrixId(matrixLevel) {

            if (!Number.isSafeInteger(matrixLevel) || matrixLevel < 0 ||
                matrixLevel >= matrixSet.tileMatrices.length) {
                return invalidProfile(
                    'A profile matrix level must index its TileMatrixSet.',
                    { minimum: 0, maximum: matrixSet.tileMatrices.length - 1 },
                    { matrixLevel }
                )
            }
            return matrixSet.tileMatrices[matrixLevel]!.id
        },
        tileBounds(tile) {

            const normalized = topology.normalizedBounds(tile)
            return Object.freeze({
                west: lower[0] + normalized.west * width,
                south: upper[1] - normalized.south * height,
                east: lower[0] + normalized.east * width,
                north: upper[1] - normalized.north * height,
            })
        },
        normalizedBounds: tile => topology.normalizedBounds(tile),
        parent: tile => topology.parent(tile),
        children: tile => topology.children(tile),
        coveredChildren(tile) {

            return Object.freeze(topology.children(tile).filter(child =>
                coverage.contains(child)
            ))
        },
        path: tile => topology.path(tile),
        comparePath: (left, right) => topology.comparePath(left, right),
        isPathPrefix: (prefix, candidate) => topology.isPathPrefix(prefix, candidate),
        encodeCamera(position) {

            if (position.length !== 2 || !position.every(Number.isFinite)) {
                return invalidProfile(
                    'Planar camera encoding requires one finite projected pair.',
                    { position: 'finite [x, y]' },
                    position
                )
            }
            const normalizedX = wrapX
                ? positiveModulo((position[0] - lower[0]) / width, 1)
                : clamp((position[0] - lower[0]) / width, 0, 1)
            const normalizedY = clamp((upper[1] - position[1]) / height, 0, 1)
            const encodedX = BigInt(Math.round(normalizedX * Number(worldQuanta)))
            const x = wrapX
                ? moduloBigInt(encodedX, worldQuanta)
                : clampQuanta(encodedX, worldQuanta)
            const y = BigInt(Math.min(
                Number(worldQuanta - 1n),
                Math.round(normalizedY * Number(worldQuanta))
            ))
            return cameraEncoding(x, y)
        },
    }
    return Object.freeze(profile)
}

/** Specializes a planar tile profile with WebMercatorQuad addressing and bounds. */
export function webMercatorPlanarTileSpatialProfile(
    descriptor: WebMercatorPlanarTileSpatialProfileDescriptor
): WebMercatorPlanarTileSpatialProfile {

    const addressCodec = descriptor?.addressCodec
    if (addressCodec?.coverage?.tileMatrixSet !== WebMercatorQuad) {
        return invalidProfile(
            'A WebMercator planar profile requires a WebMercatorQuad address codec.',
            { tileMatrixSetId: WebMercatorQuad.id },
            { tileMatrixSetId: addressCodec?.coverage?.tileMatrixSet?.id }
        )
    }
    const base = planarTileSpatialProfile({
        id: `WebMercatorQuad.planar.${addressCodec.coordinateBits}`,
        topology: regularQuadTileTopology({
            id: 'WebMercatorQuad.quadtree',
            tileMatrixSet: WebMercatorQuad,
        }),
        coverage: addressCodec.coverage,
        coordinateBits: addressCodec.coordinateBits,
        wrapX: true,
    })
    const profile: WebMercatorPlanarTileSpatialProfile = {
        ...base,
        addressCodec,
        tileBounds(tile) {

            return WebMercatorQuad.tileBounds(WebMercatorQuad.tile(tile)).projected
        },
        encodeCamera(position) {

            const limbs = addressCodec.fromProjected(position).fixed.limbs
            return Object.freeze({
                low: Object.freeze([ limbs[0]!.low, limbs[1]!.low ]) as readonly [number, number],
                high: Object.freeze([ limbs[0]!.high, limbs[1]!.high ]) as readonly [number, number],
            })
        },
    }
    return Object.freeze(profile)
}

function cameraEncoding(x: bigint, y: bigint): TileSpatialCameraEncoding {

    const mask = 0xffff_ffffn
    return Object.freeze({
        low: Object.freeze([ Number(x & mask), Number(y & mask) ]) as readonly [number, number],
        high: Object.freeze([
            Number((x >> 32n) & mask),
            Number((y >> 32n) & mask),
        ]) as readonly [number, number],
    })
}

function exactPowerOfTwoExponent(value: number): number | undefined {

    const exponent = Math.log2(value)
    return Number.isInteger(exponent) ? exponent : undefined
}

function positiveModulo(value: number, modulus: number): number {

    return ((value % modulus) + modulus) % modulus
}

function moduloBigInt(value: bigint, modulus: bigint): bigint {

    return ((value % modulus) + modulus) % modulus
}

function clampQuanta(value: bigint, worldQuanta: bigint): bigint {

    return value < 0n ? 0n : value >= worldQuanta ? worldQuanta - 1n : value
}

function clamp(value: number, minimum: number, maximum: number): number {

    return Math.max(minimum, Math.min(maximum, value))
}

function approximatelyEqual(left: number, right: number): boolean {

    const scale = Math.max(1, Math.abs(left), Math.abs(right))
    return Math.abs(left - right) <= Number.EPSILON * 64 * scale
}

function invalidProfile(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_TILE_SPATIAL_PROFILE_INVALID',
        phase: 'selection',
        subject: { kind: 'tile-spatial-profile' },
        message,
        expected,
        actual,
    })
}
