import { throwGeoDiagnostic } from './diagnostics.js'
import type {
    TileCoordinate,
    TileCoordinateDescriptor,
    TileMatrixSet,
} from './tile-matrix.js'

export type RegularQuadTileTopologyDescriptor = Readonly<{
    id: string
    tileMatrixSet: TileMatrixSet
}>

export type TileTopology = Readonly<{
    kind: 'tile-topology'
    id: string
    tileMatrixSet: TileMatrixSet
    roots: readonly TileCoordinate[]
    matrixLevel(tile: Pick<TileCoordinate, 'tileMatrixSetId' | 'matrixId'>): number
    parent(tile: TileCoordinateDescriptor): TileCoordinate | undefined
    children(tile: TileCoordinateDescriptor): readonly TileCoordinate[]
    childOrdinal(tile: TileCoordinateDescriptor): 0 | 1 | 2 | 3
    path(tile: TileCoordinateDescriptor): readonly number[]
    comparePath(left: TileCoordinateDescriptor, right: TileCoordinateDescriptor): number
    isPathPrefix(prefix: TileCoordinateDescriptor, candidate: TileCoordinateDescriptor): boolean
    normalizedBounds(tile: TileCoordinateDescriptor): Readonly<{
        west: number
        north: number
        east: number
        south: number
    }>
}>

const MAX_ROOTS = 65_536

export function regularQuadTileTopology(
    descriptor: RegularQuadTileTopologyDescriptor
): TileTopology {

    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        descriptor.tileMatrixSet?.kind !== 'tile-matrix-set') {
        return invalidTopology(
            'A regular quad tile topology requires an id and one TileMatrixSet.',
            { id: 'non-empty string', tileMatrixSet: 'TileMatrixSet' },
            descriptor
        )
    }
    const matrixSet = descriptor.tileMatrixSet
    const matrices = matrixSet.tileMatrices
    for (let index = 1; index < matrices.length; index++) {
        const parent = matrices[index - 1]!
        const child = matrices[index]!
        if (child.matrixWidth !== parent.matrixWidth * 2 ||
            child.matrixHeight !== parent.matrixHeight * 2 ||
            child.tileWidth !== parent.tileWidth ||
            child.tileHeight !== parent.tileHeight ||
            child.cornerOfOrigin !== parent.cornerOfOrigin ||
            child.pointOfOrigin[0] !== parent.pointOfOrigin[0] ||
            child.pointOfOrigin[1] !== parent.pointOfOrigin[1]) {
            return invalidTopology(
                'Adjacent tile matrices must form one regular quadtree level.',
                {
                    matrixWidth: parent.matrixWidth * 2,
                    matrixHeight: parent.matrixHeight * 2,
                    tileSize: [ parent.tileWidth, parent.tileHeight ],
                    cornerOfOrigin: parent.cornerOfOrigin,
                    pointOfOrigin: parent.pointOfOrigin,
                },
                child
            )
        }
    }
    const rootMatrix = matrices[0]!
    const rootCount = rootMatrix.matrixWidth * rootMatrix.matrixHeight
    if (!Number.isSafeInteger(rootCount) || rootCount <= 0 || rootCount > MAX_ROOTS) {
        return invalidTopology(
            'A tile topology root forest must have a finite bounded root count.',
            { minimum: 1, maximum: MAX_ROOTS },
            { rootCount }
        )
    }
    const matrixLevels = new Map(matrices.map((matrix, index) => [ matrix.id, index ]))
    const roots: TileCoordinate[] = []
    for (let row = 0; row < rootMatrix.matrixHeight; row++) {
        for (let column = 0; column < rootMatrix.matrixWidth; column++) {
            roots.push(matrixSet.tile({
                matrixId: rootMatrix.id,
                tileRow: row,
                tileCol: column,
            }))
        }
    }

    const topology: TileTopology = {
        kind: 'tile-topology',
        id: descriptor.id,
        tileMatrixSet: matrixSet,
        roots: Object.freeze(roots),
        matrixLevel(tile) {

            assertMatrixSet(matrixSet, tile)
            const level = matrixLevels.get(tile.matrixId)
            if (level === undefined) matrixSet.matrix(tile.matrixId)
            return level!
        },
        parent(tile) {

            const accepted = acceptTile(matrixSet, tile)
            const level = topology.matrixLevel(accepted)
            if (level === 0) return undefined
            const parentMatrix = matrices[level - 1]!
            return matrixSet.tile({
                matrixId: parentMatrix.id,
                tileRow: Math.floor(accepted.tileRow / 2),
                tileCol: Math.floor(accepted.tileCol / 2),
            })
        },
        children(tile) {

            const accepted = acceptTile(matrixSet, tile)
            const level = topology.matrixLevel(accepted)
            if (level + 1 >= matrices.length) return Object.freeze([])
            const childMatrix = matrices[level + 1]!
            const row = accepted.tileRow * 2
            const column = accepted.tileCol * 2
            return Object.freeze([
                matrixSet.tile({ matrixId: childMatrix.id, tileRow: row, tileCol: column }),
                matrixSet.tile({ matrixId: childMatrix.id, tileRow: row, tileCol: column + 1 }),
                matrixSet.tile({ matrixId: childMatrix.id, tileRow: row + 1, tileCol: column }),
                matrixSet.tile({ matrixId: childMatrix.id, tileRow: row + 1, tileCol: column + 1 }),
            ])
        },
        childOrdinal(tile) {

            const accepted = acceptTile(matrixSet, tile)
            if (topology.matrixLevel(accepted) === 0) {
                return invalidTopology(
                    'A root tile has no quadtree child ordinal.',
                    { matrixLevel: '> 0' },
                    accepted
                )
            }
            return ((accepted.tileRow % 2) * 2 + accepted.tileCol % 2) as 0 | 1 | 2 | 3
        },
        path(tile) {

            const accepted = acceptTile(matrixSet, tile)
            const level = topology.matrixLevel(accepted)
            const scale = 2 ** level
            const rootRow = Math.floor(accepted.tileRow / scale)
            const rootColumn = Math.floor(accepted.tileCol / scale)
            const path = [ rootRow * rootMatrix.matrixWidth + rootColumn ]
            for (let depth = 1; depth <= level; depth++) {
                const shift = level - depth
                const divisor = 2 ** shift
                const rowBit = Math.floor(accepted.tileRow / divisor) % 2
                const columnBit = Math.floor(accepted.tileCol / divisor) % 2
                path.push(rowBit * 2 + columnBit)
            }
            return Object.freeze(path)
        },
        comparePath(left, right) {

            const leftPath = topology.path(left)
            const rightPath = topology.path(right)
            const count = Math.min(leftPath.length, rightPath.length)
            for (let index = 0; index < count; index++) {
                if (leftPath[index] !== rightPath[index]) {
                    return leftPath[index]! - rightPath[index]!
                }
            }
            return leftPath.length - rightPath.length
        },
        isPathPrefix(prefix, candidate) {

            const prefixPath = topology.path(prefix)
            const candidatePath = topology.path(candidate)
            return prefixPath.length <= candidatePath.length && prefixPath.every(
                (part, index) => candidatePath[index] === part
            )
        },
        normalizedBounds(tile) {

            const accepted = acceptTile(matrixSet, tile)
            const matrix = matrixSet.matrix(accepted.matrixId)
            return Object.freeze({
                west: accepted.tileCol / matrix.matrixWidth,
                north: accepted.tileRow / matrix.matrixHeight,
                east: (accepted.tileCol + 1) / matrix.matrixWidth,
                south: (accepted.tileRow + 1) / matrix.matrixHeight,
            })
        },
    }
    return Object.freeze(topology)
}

function acceptTile(
    matrixSet: TileMatrixSet,
    tile: TileCoordinateDescriptor
): TileCoordinate {

    assertMatrixSet(matrixSet, tile)
    return matrixSet.tile(tile)
}

function assertMatrixSet(
    matrixSet: TileMatrixSet,
    tile: Pick<TileCoordinateDescriptor, 'matrixId'> & Partial<Pick<TileCoordinate, 'tileMatrixSetId'>>
): void {

    if (tile.tileMatrixSetId !== undefined && tile.tileMatrixSetId !== matrixSet.id) {
        return invalidTopology(
            'A topology can only evaluate tiles from its TileMatrixSet.',
            { tileMatrixSetId: matrixSet.id },
            tile
        )
    }
}

function invalidTopology(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_TILE_TOPOLOGY_INVALID',
        phase: 'selection',
        subject: { kind: 'tile-topology' },
        message,
        expected,
        actual,
    })
}

