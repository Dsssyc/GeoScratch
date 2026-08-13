import { throwGeoDiagnostic } from './diagnostics.js'

export type TileMatrixId = string
export type TileMatrixCornerOfOrigin = 'topLeft' | 'bottomLeft'

export type TileMatrixDescriptor = Readonly<{
    id: TileMatrixId
    scaleDenominator: number
    cellSize: number
    pointOfOrigin: readonly [number, number]
    cornerOfOrigin: TileMatrixCornerOfOrigin
    tileWidth: number
    tileHeight: number
    matrixWidth: number
    matrixHeight: number
}>

export type TileMatrix = Readonly<TileMatrixDescriptor>

export type TileMatrixSetBoundingBox = Readonly<{
    crs: string
    lowerCorner: readonly [number, number]
    upperCorner: readonly [number, number]
}>

export type TileMatrixSetDescriptor = Readonly<{
    id: string
    title?: string
    uri?: string
    crs: string
    wellKnownScaleSet?: string
    orderedAxes: readonly [string, string]
    boundingBox: TileMatrixSetBoundingBox
    tileMatrices: readonly TileMatrixDescriptor[]
}>

export type TileCoordinateDescriptor = Readonly<{
    matrixId: TileMatrixId
    tileRow: number
    tileCol: number
}>

export type TileCoordinate = Readonly<{
    kind: 'tile-coordinate'
    tileMatrixSetId: string
    matrixId: TileMatrixId
    tileRow: number
    tileCol: number
    key: string
}>

export type TileMatrixSet = Readonly<{
    kind: 'tile-matrix-set'
    id: string
    title?: string
    uri?: string
    crs: string
    wellKnownScaleSet?: string
    orderedAxes: readonly [string, string]
    boundingBox: TileMatrixSetBoundingBox
    tileMatrices: readonly TileMatrix[]
    matrix(id: TileMatrixId): TileMatrix
    tile(descriptor: TileCoordinateDescriptor): TileCoordinate
    parent(tile: TileCoordinateDescriptor): TileCoordinate | undefined
}>

export type TileMatrixLimits = Readonly<{
    matrixId: TileMatrixId
    minTileRow: number
    maxTileRow: number
    minTileCol: number
    maxTileCol: number
}>

export type TileMatrixCoverageDescriptor = Readonly<{
    tileMatrixSet: TileMatrixSet
    limits: readonly TileMatrixLimits[]
}>

export type TileMatrixCoverageWgslOptions = Readonly<{
    namespace?: string
}>

type CoverageRecord = Readonly<{
    limit: TileMatrixLimits
    offset: number
    width: number
    height: number
    matrixIndex: number
}>

const MAX_GPU_COMPACT_ENTRIES = 0xffff_fffen

/** Indexes finite per-level TileMatrix limits into compact logical and GPU addresses. */
export class TileMatrixCoverage {

    readonly kind = 'tile-matrix-coverage'
    readonly tileMatrixSet: TileMatrixSet
    readonly limits: readonly TileMatrixLimits[]
    readonly entryCount: number
    readonly #records: readonly CoverageRecord[]
    readonly #recordsByMatrix: ReadonlyMap<TileMatrixId, CoverageRecord>

    constructor(descriptor: TileMatrixCoverageDescriptor) {

        if (descriptor.limits.length === 0) {
            throwCoverageInvalid(descriptor.tileMatrixSet.id, 'Coverage requires at least one limit.', {
                limits: descriptor.limits,
            })
        }
        this.tileMatrixSet = descriptor.tileMatrixSet
        const matrixOrder = new Map(descriptor.tileMatrixSet.tileMatrices.map((matrix, index) => [
            matrix.id,
            index,
        ]))
        const seen = new Set<TileMatrixId>()
        const ordered = [ ...descriptor.limits ].sort((left, right) =>
            requireMatrixOrder(matrixOrder, descriptor.tileMatrixSet.id, left.matrixId) -
            requireMatrixOrder(matrixOrder, descriptor.tileMatrixSet.id, right.matrixId)
        )
        const records: CoverageRecord[] = []
        let offset = 0n
        for (const input of ordered) {
            const matrix = descriptor.tileMatrixSet.matrix(input.matrixId)
            if (seen.has(input.matrixId) || !validLimit(input, matrix)) {
                throwCoverageInvalid(
                    descriptor.tileMatrixSet.id,
                    'Tile matrix limits must be unique, ordered integer ranges inside their matrix.',
                    { limit: input, matrix }
                )
            }
            seen.add(input.matrixId)
            const limit = freezeLimit(input)
            const width = limit.maxTileCol - limit.minTileCol + 1
            const height = limit.maxTileRow - limit.minTileRow + 1
            const count = BigInt(width) * BigInt(height)
            if (offset + count > MAX_GPU_COMPACT_ENTRIES) {
                throwCoverageInvalid(
                    descriptor.tileMatrixSet.id,
                    'Compact coverage exceeds the u32 GPU page-table index budget.',
                    { entryCount: String(offset + count), maximum: String(MAX_GPU_COMPACT_ENTRIES) }
                )
            }
            records.push(Object.freeze({
                limit,
                offset: Number(offset),
                width,
                height,
                matrixIndex: matrixOrder.get(limit.matrixId)!,
            }))
            offset += count
        }
        this.#records = Object.freeze(records)
        this.#recordsByMatrix = new Map(records.map(record => [ record.limit.matrixId, record ]))
        this.limits = Object.freeze(records.map(record => record.limit))
        this.entryCount = Number(offset)
        Object.freeze(this)
    }

    contains(descriptor: TileCoordinateDescriptor): boolean {

        const record = this.#recordsByMatrix.get(descriptor.matrixId)
        return record !== undefined && containsCoordinate(record.limit, descriptor)
    }

    index(descriptor: TileCoordinateDescriptor): number {

        const record = this.#recordsByMatrix.get(descriptor.matrixId)
        if (record === undefined || !containsCoordinate(record.limit, descriptor)) {
            return throwGeoDiagnostic({
                code: 'GEO_TILE_MATRIX_COVERAGE_MISS',
                phase: 'virtual-raster',
                subject: { kind: 'tile-matrix-coverage', id: this.tileMatrixSet.id },
                message: 'A tile must be inside finite coverage before it receives a compact index.',
                expected: { limits: this.limits },
                actual: descriptor,
            })
        }
        return record.offset +
            (descriptor.tileRow - record.limit.minTileRow) * record.width +
            descriptor.tileCol - record.limit.minTileCol
    }

    tryIndex(descriptor: TileCoordinateDescriptor): number | undefined {

        return this.contains(descriptor) ? this.index(descriptor) : undefined
    }

    coordinate(index: number): TileCoordinate {

        if (!Number.isSafeInteger(index) || index < 0 || index >= this.entryCount) {
            return throwGeoDiagnostic({
                code: 'GEO_TILE_MATRIX_COVERAGE_INDEX_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'tile-matrix-coverage', id: this.tileMatrixSet.id },
                message: 'A compact tile index must be inside the finite coverage table.',
                expected: { minimum: 0, maximum: this.entryCount - 1 },
                actual: { index },
            })
        }
        const record = this.#records.find(candidate =>
            index >= candidate.offset && index < candidate.offset + candidate.width * candidate.height
        )!
        const local = index - record.offset
        return this.tileMatrixSet.tile({
            matrixId: record.limit.matrixId,
            tileRow: record.limit.minTileRow + Math.floor(local / record.width),
            tileCol: record.limit.minTileCol + local % record.width,
        })
    }

    parent(descriptor: TileCoordinateDescriptor): TileCoordinate | undefined {

        const sourceMatrixIndex = this.tileMatrixSet.tileMatrices.findIndex(matrix =>
            matrix.id === descriptor.matrixId
        )
        if (sourceMatrixIndex < 0) this.tileMatrixSet.matrix(descriptor.matrixId)
        const sourceMatrix = this.tileMatrixSet.tileMatrices[sourceMatrixIndex]!
        this.tileMatrixSet.tile(descriptor)
        for (let index = sourceMatrixIndex - 1; index >= 0; index--) {
            const matrix = this.tileMatrixSet.tileMatrices[index]!
            const candidate = {
                matrixId: matrix.id,
                tileRow: scaleTileCoordinate(
                    descriptor.tileRow,
                    matrix.matrixHeight,
                    sourceMatrix.matrixHeight
                ),
                tileCol: scaleTileCoordinate(
                    descriptor.tileCol,
                    matrix.matrixWidth,
                    sourceMatrix.matrixWidth
                ),
            }
            if (this.contains(candidate)) return this.tileMatrixSet.tile(candidate)
        }
        return undefined
    }

    limit(matrixId: TileMatrixId): TileMatrixLimits | undefined {

        return this.#recordsByMatrix.get(matrixId)?.limit
    }

    wgslModule(options: TileMatrixCoverageWgslOptions = {}): string {

        const namespace = normalizeNamespace(options.namespace, 'GeoTileCoverage')
        const count = this.#records.length
        const matrixIds = this.#records.map(record => `${matrixNumericId(record.limit.matrixId)}u`).join(', ')
        const offsets = this.#records.map(record => `${record.offset}u`).join(', ')
        const minimums = this.#records.map(record =>
            `vec2u(${record.limit.minTileCol}u, ${record.limit.minTileRow}u)`
        ).join(', ')
        const maximums = this.#records.map(record =>
            `vec2u(${record.limit.maxTileCol}u, ${record.limit.maxTileRow}u)`
        ).join(', ')
        const widths = this.#records.map(record => `${record.width}u`).join(', ')
        return `const ${namespace}_not_covered = 0xffffffffu;\n` +
            `const ${namespace}_limit_count = ${count}u;\n` +
            `const ${namespace}_matrix = array<u32, ${count}>(${matrixIds});\n` +
            `const ${namespace}_offset = array<u32, ${count}>(${offsets});\n` +
            `const ${namespace}_minimum = array<vec2u, ${count}>(${minimums});\n` +
            `const ${namespace}_maximum = array<vec2u, ${count}>(${maximums});\n` +
            `const ${namespace}_width = array<u32, ${count}>(${widths});\n\n` +
            `fn ${namespace}_compact_index(matrix: u32, tile: vec2u) -> u32 {\n` +
            `    for (var index = 0u; index < ${namespace}_limit_count; index++) {\n` +
            `        if (${namespace}_matrix[index] == matrix && all(tile >= ${namespace}_minimum[index]) && all(tile <= ${namespace}_maximum[index])) {\n` +
            `            let local = tile - ${namespace}_minimum[index];\n` +
            `            return ${namespace}_offset[index] + local.y * ${namespace}_width[index] + local.x;\n` +
            `        }\n` +
            `    }\n` +
            `    return ${namespace}_not_covered;\n` +
            `}\n`
    }
}

/** Validates and freezes an OGC-style ordered tile matrix set. */
export function tileMatrixSet(descriptor: TileMatrixSetDescriptor): TileMatrixSet {

    if (typeof descriptor.id !== 'string' || descriptor.id.length === 0 ||
        typeof descriptor.crs !== 'string' || descriptor.crs.length === 0 ||
        (descriptor.title !== undefined && typeof descriptor.title !== 'string') ||
        (descriptor.uri !== undefined && typeof descriptor.uri !== 'string') ||
        (descriptor.wellKnownScaleSet !== undefined &&
            typeof descriptor.wellKnownScaleSet !== 'string') ||
        descriptor.orderedAxes.length !== 2 ||
        descriptor.orderedAxes.some(axis => typeof axis !== 'string' || axis.length === 0) ||
        descriptor.tileMatrices.length === 0 ||
        !validBoundingBox(descriptor.boundingBox)) {
        return throwTileMatrixSetInvalid(descriptor.id, 'Tile matrix set metadata is invalid.', descriptor)
    }
    const ids = new Set<string>()
    const matrices = descriptor.tileMatrices.map(input => {
        if (!validMatrix(input) || ids.has(input.id)) {
            return throwTileMatrixSetInvalid(
                descriptor.id,
                'Tile matrices require unique ids and finite positive dimensions.',
                input
            )
        }
        ids.add(input.id)
        return Object.freeze({
            ...input,
            pointOfOrigin: Object.freeze([ ...input.pointOfOrigin ]) as readonly [number, number],
        })
    })
    const byId = new Map(matrices.map(matrix => [ matrix.id, matrix ]))
    const result: TileMatrixSet = {
        kind: 'tile-matrix-set',
        id: descriptor.id,
        ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
        ...(descriptor.uri === undefined ? {} : { uri: descriptor.uri }),
        crs: descriptor.crs,
        ...(descriptor.wellKnownScaleSet === undefined ? {} : {
            wellKnownScaleSet: descriptor.wellKnownScaleSet,
        }),
        orderedAxes: Object.freeze([ ...descriptor.orderedAxes ]) as readonly [string, string],
        boundingBox: freezeBoundingBox(descriptor.boundingBox),
        tileMatrices: Object.freeze(matrices),
        matrix(id) {

            const matrix = byId.get(id)
            if (matrix === undefined) {
                return throwGeoDiagnostic({
                    code: 'GEO_TILE_MATRIX_UNKNOWN',
                    phase: 'coordinate',
                    subject: { kind: 'tile-matrix-set', id: descriptor.id },
                    message: 'Tile matrix id is not present in the selected tile matrix set.',
                    expected: { matrixIds: [ ...byId.keys() ] },
                    actual: { matrixId: id },
                })
            }
            return matrix
        },
        tile(input) {

            const matrix = result.matrix(input.matrixId)
            if (!validTileCoordinate(input, matrix)) {
                return throwGeoDiagnostic({
                    code: 'GEO_TILE_COORDINATE_INVALID',
                    phase: 'coordinate',
                    subject: { kind: 'tile-matrix', id: input.matrixId },
                    message: 'Tile row and column must be inside their global tile matrix.',
                    expected: {
                        tileRow: [ 0, matrix.matrixHeight - 1 ],
                        tileCol: [ 0, matrix.matrixWidth - 1 ],
                    },
                    actual: input,
                })
            }
            return Object.freeze({
                kind: 'tile-coordinate',
                tileMatrixSetId: descriptor.id,
                matrixId: input.matrixId,
                tileRow: input.tileRow,
                tileCol: input.tileCol,
                key: `${input.matrixId}/${input.tileRow}/${input.tileCol}`,
            })
        },
        parent(input) {

            const child = result.tile(input)
            const childIndex = matrices.findIndex(matrix => matrix.id === child.matrixId)
            if (childIndex <= 0) return undefined
            const childMatrix = matrices[childIndex]!
            const parentMatrix = matrices[childIndex - 1]!
            return result.tile({
                matrixId: parentMatrix.id,
                tileRow: scaleTileCoordinate(
                    child.tileRow,
                    parentMatrix.matrixHeight,
                    childMatrix.matrixHeight
                ),
                tileCol: scaleTileCoordinate(
                    child.tileCol,
                    parentMatrix.matrixWidth,
                    childMatrix.matrixWidth
                ),
            })
        },
    }
    return Object.freeze(result)
}

/** Creates finite source coverage over an existing tile matrix set. */
export function tileMatrixCoverage(descriptor: TileMatrixCoverageDescriptor): TileMatrixCoverage {

    return new TileMatrixCoverage(descriptor)
}

function validMatrix(value: TileMatrixDescriptor): boolean {

    return typeof value.id === 'string' && value.id.length > 0 &&
        Number.isFinite(value.scaleDenominator) && value.scaleDenominator > 0 &&
        Number.isFinite(value.cellSize) && value.cellSize > 0 &&
        value.pointOfOrigin.length === 2 && value.pointOfOrigin.every(Number.isFinite) &&
        (value.cornerOfOrigin === 'topLeft' || value.cornerOfOrigin === 'bottomLeft') &&
        positiveSafeInteger(value.tileWidth) && positiveSafeInteger(value.tileHeight) &&
        positiveSafeInteger(value.matrixWidth) && positiveSafeInteger(value.matrixHeight)
}

function validBoundingBox(value: TileMatrixSetBoundingBox): boolean {

    return typeof value.crs === 'string' && value.crs.length > 0 &&
        value.lowerCorner.length === 2 && value.upperCorner.length === 2 &&
        value.lowerCorner.every(Number.isFinite) && value.upperCorner.every(Number.isFinite) &&
        value.lowerCorner.every((coordinate, axis) => coordinate < value.upperCorner[axis]!)
}

function validTileCoordinate(value: TileCoordinateDescriptor, matrix: TileMatrix): boolean {

    return nonNegativeSafeInteger(value.tileRow) && value.tileRow < matrix.matrixHeight &&
        nonNegativeSafeInteger(value.tileCol) && value.tileCol < matrix.matrixWidth
}

function validLimit(value: TileMatrixLimits, matrix: TileMatrix): boolean {

    return nonNegativeSafeInteger(value.minTileRow) &&
        nonNegativeSafeInteger(value.maxTileRow) &&
        nonNegativeSafeInteger(value.minTileCol) &&
        nonNegativeSafeInteger(value.maxTileCol) &&
        value.minTileRow <= value.maxTileRow && value.maxTileRow < matrix.matrixHeight &&
        value.minTileCol <= value.maxTileCol && value.maxTileCol < matrix.matrixWidth
}

function containsCoordinate(limit: TileMatrixLimits, value: TileCoordinateDescriptor): boolean {

    return value.matrixId === limit.matrixId && Number.isSafeInteger(value.tileRow) &&
        Number.isSafeInteger(value.tileCol) &&
        value.tileRow >= limit.minTileRow && value.tileRow <= limit.maxTileRow &&
        value.tileCol >= limit.minTileCol && value.tileCol <= limit.maxTileCol
}

function freezeLimit(value: TileMatrixLimits): TileMatrixLimits {

    return Object.freeze({ ...value })
}

function freezeBoundingBox(value: TileMatrixSetBoundingBox): TileMatrixSetBoundingBox {

    return Object.freeze({
        crs: value.crs,
        lowerCorner: Object.freeze([ ...value.lowerCorner ]) as readonly [number, number],
        upperCorner: Object.freeze([ ...value.upperCorner ]) as readonly [number, number],
    })
}

function requireMatrixOrder(
    order: ReadonlyMap<string, number>,
    tileMatrixSetId: string,
    matrixId: string
): number {

    const index = order.get(matrixId)
    if (index === undefined) {
        return throwTileMatrixSetInvalid(tileMatrixSetId, 'Coverage references an unknown matrix.', {
            matrixId,
        })
    }
    return index
}

function matrixNumericId(value: string): number {

    const result = Number(value)
    if (!nonNegativeSafeInteger(result) || result > 0xffff_ffff || String(result) !== value) {
        return throwGeoDiagnostic({
            code: 'GEO_TILE_MATRIX_WGSL_ID_INVALID',
            phase: 'virtual-raster',
            subject: { kind: 'tile-matrix', id: value },
            message: 'WGSL compact coverage currently requires canonical non-negative numeric matrix ids.',
            expected: { matrixId: 'canonical u32 integer string' },
            actual: { matrixId: value },
        })
    }
    return result
}

function normalizeNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        throw new TypeError('WGSL namespace must be a valid identifier.')
    }
    return namespace
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function scaleTileCoordinate(value: number, numerator: number, denominator: number): number {

    return Number(BigInt(value) * BigInt(numerator) / BigInt(denominator))
}

function throwTileMatrixSetInvalid(id: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_TILE_MATRIX_SET_INVALID',
        phase: 'coordinate',
        subject: { kind: 'tile-matrix-set', id },
        message,
        actual,
    })
}

function throwCoverageInvalid(id: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_TILE_MATRIX_COVERAGE_INVALID',
        phase: 'virtual-raster',
        subject: { kind: 'tile-matrix-coverage', id },
        message,
        actual,
    })
}
