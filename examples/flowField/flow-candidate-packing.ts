import { WebMercatorQuad } from 'geoscratch/geo'
import type { WebMercatorQuadAddressCodec } from 'geoscratch/geo'
import type { FlowCandidateCell } from './flow-demand.ts'

export const FLOW_CANDIDATE_RECORD_BYTES = 32

const PAGE_TEXELS = 256
const I32_MAX = 0x7fff_ffffn

/** Packs demand-derived logical cells into the shared spawn/contour candidate ABI. */
export function packFlowCandidateCells(
    candidates: readonly FlowCandidateCell[],
    codec: WebMercatorQuadAddressCodec,
    cellsPerPageEdge: number
): Uint8Array<ArrayBuffer> {

    validateInputs(candidates, codec, cellsPerPageEdge)
    const byteLength = candidates.length * FLOW_CANDIDATE_RECORD_BYTES
    if (!Number.isSafeInteger(byteLength)) {
        throw new RangeError('Flow candidate byte length exceeds the safe integer range')
    }
    const buffer = new ArrayBuffer(byteLength)
    const view = new DataView(buffer)
    for (let index = 0; index < candidates.length; index++) {
        packCandidate(view, index * FLOW_CANDIDATE_RECORD_BYTES, candidates[index]!, codec,
            cellsPerPageEdge)
    }
    return new Uint8Array(buffer)
}

function packCandidate(
    view: DataView,
    offset: number,
    candidate: FlowCandidateCell,
    codec: WebMercatorQuadAddressCodec,
    cellsPerPageEdge: number
): void {

    const tile = candidate?.page?.tile
    if (tile === undefined || candidate.page.kind !== 'virtual-raster-page' ||
        candidate.page.dimensions !== 2 ||
        typeof candidate.page.addressSpaceId !== 'string' ||
        candidate.page.addressSpaceId.length === 0 ||
        tile.tileMatrixSetId !== WebMercatorQuad.id ||
        candidate.page.key !== tile.key || candidate.page.coordinates.length !== 2 ||
        candidate.page.coordinates[0] !== tile.tileCol ||
        candidate.page.coordinates[1] !== tile.tileRow ||
        !codec.coverage.contains(tile)) {
        throw new TypeError(`Flow candidate ${offset / FLOW_CANDIDATE_RECORD_BYTES} page is invalid`)
    }
    const matrixOrder = codec.coverage.limits.findIndex(limit =>
        limit.matrixId === tile.matrixId
    )
    const expectedLevel = codec.coverage.limits.length - matrixOrder - 1
    if (matrixOrder < 0 || candidate.page.level !== expectedLevel) {
        throw new TypeError(`Flow candidate ${offset / FLOW_CANDIDATE_RECORD_BYTES} level is invalid`)
    }
    if (!Number.isSafeInteger(candidate.requestedLevel) || candidate.requestedLevel < 0 ||
        candidate.requestedLevel >= codec.coverage.limits.length) {
        throw new RangeError(
            `Flow candidate ${offset / FLOW_CANDIDATE_RECORD_BYTES} requested level is invalid`
        )
    }
    if (!cellCoordinate(candidate.cellX, cellsPerPageEdge) ||
        !cellCoordinate(candidate.cellY, cellsPerPageEdge)) {
        throw new RangeError(`Flow candidate ${offset / FLOW_CANDIDATE_RECORD_BYTES} cell is invalid`)
    }

    const matrix = WebMercatorQuad.matrix(tile.matrixId)
    const matrixWidth = BigInt(matrix.matrixWidth)
    if (codec.worldQuanta % matrixWidth !== 0n) {
        throw new RangeError('Flow candidate page extent is not exact in canonical quanta')
    }
    const pageQuanta = codec.worldQuanta / matrixWidth
    const cellCount = BigInt(cellsPerPageEdge)
    if (pageQuanta % cellCount !== 0n) {
        throw new RangeError('Flow candidate cell step is not exact in canonical quanta')
    }
    const texelStepQuanta = pageQuanta / cellCount
    if (texelStepQuanta <= 0n || texelStepQuanta > I32_MAX) {
        throw new RangeError('Flow candidate cell step does not fit shader i32 advancement')
    }
    const origin = codec.fromWorldQuanta([
        BigInt(tile.tileCol) * pageQuanta + BigInt(candidate.cellX) * texelStepQuanta,
        BigInt(tile.tileRow) * pageQuanta + BigInt(candidate.cellY) * texelStepQuanta,
    ])
    const [ x, y ] = origin.fixed.limbs
    view.setUint32(offset, x!.low, true)
    view.setUint32(offset + 4, x!.high, true)
    view.setUint32(offset + 8, y!.low, true)
    view.setUint32(offset + 12, y!.high, true)
    view.setUint32(offset + 16, Number(texelStepQuanta), true)
    view.setUint32(offset + 20, candidate.requestedLevel, true)
    view.setUint32(offset + 24, 0, true)
    view.setUint32(offset + 28, 0, true)
}

function validateInputs(
    candidates: readonly FlowCandidateCell[],
    codec: WebMercatorQuadAddressCodec,
    cellsPerPageEdge: number
): void {

    if (!Array.isArray(candidates) || codec?.coverage?.tileMatrixSet !== WebMercatorQuad ||
        typeof codec.worldQuanta !== 'bigint' || typeof codec.fromWorldQuanta !== 'function' ||
        !Number.isSafeInteger(cellsPerPageEdge) || cellsPerPageEdge <= 0 ||
        cellsPerPageEdge > PAGE_TEXELS || PAGE_TEXELS % cellsPerPageEdge !== 0) {
        throw new TypeError(
            'Flow candidate packing requires standard coverage and an exact 256-texel cell grid'
        )
    }
}

function cellCoordinate(value: number, cellsPerPageEdge: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value < cellsPerPageEdge
}
