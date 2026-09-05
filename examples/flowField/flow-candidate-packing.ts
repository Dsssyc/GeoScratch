import { WebMercatorQuad } from 'geoscratch/geo'
import type { WebMercatorQuadAddressCodec } from 'geoscratch/geo'
import type { FlowCandidateCell } from './flow-demand.ts'

export const FLOW_CANDIDATE_RECORD_BYTES = 32

const PAGE_TEXELS = 256
const I32_MAX = 0x7fff_ffffn
const LIMB_QUANTA = 0x1_0000_0000

type PackedPageOrigin = Readonly<{
    xLow: number
    xHigh: number
    yLow: number
    yHigh: number
    step: number
}>

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
    const pages = new Map<FlowCandidateCell['page'], PackedPageOrigin>()
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!
        let page = pages.get(candidate?.page)
        if (page === undefined) {
            page = preparePage(candidate, codec, cellsPerPageEdge, index)
            pages.set(candidate.page, page)
        }
        if (!Number.isSafeInteger(candidate.requestedLevel) || candidate.requestedLevel < 0 ||
            candidate.requestedLevel >= codec.coverage.limits.length) {
            throw new RangeError(`Flow candidate ${index} requested level is invalid`)
        }
        if (!cellCoordinate(candidate.cellX, cellsPerPageEdge) ||
            !cellCoordinate(candidate.cellY, cellsPerPageEdge)) {
            throw new RangeError(`Flow candidate ${index} cell is invalid`)
        }

        const offset = index * FLOW_CANDIDATE_RECORD_BYTES
        // A cell offset is at most 255 * i32_max, so both sums are exact JS integers.
        // Carry into the high limb before narrowing; never reduce whole-world quanta.
        const xLow = page.xLow + candidate.cellX * page.step
        const yLow = page.yLow + candidate.cellY * page.step
        view.setUint32(offset, xLow % LIMB_QUANTA, true)
        view.setUint32(offset + 4, page.xHigh + Math.floor(xLow / LIMB_QUANTA), true)
        view.setUint32(offset + 8, yLow % LIMB_QUANTA, true)
        view.setUint32(offset + 12, page.yHigh + Math.floor(yLow / LIMB_QUANTA), true)
        view.setUint32(offset + 16, page.step, true)
        view.setUint32(offset + 20, candidate.requestedLevel, true)
        // Reserved words remain zero in the freshly allocated buffer.
    }
    return new Uint8Array(buffer)
}

function preparePage(
    candidate: FlowCandidateCell,
    codec: WebMercatorQuadAddressCodec,
    cellsPerPageEdge: number,
    index: number
): PackedPageOrigin {

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
        throw new TypeError(`Flow candidate ${index} page is invalid`)
    }
    const matrixOrder = codec.coverage.limits.findIndex(limit =>
        limit.matrixId === tile.matrixId
    )
    const expectedLevel = codec.coverage.limits.length - matrixOrder - 1
    if (matrixOrder < 0 || candidate.page.level !== expectedLevel) {
        throw new TypeError(`Flow candidate ${index} level is invalid`)
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
        BigInt(tile.tileCol) * pageQuanta,
        BigInt(tile.tileRow) * pageQuanta,
    ])
    const [ x, y ] = origin.fixed.limbs
    return {
        xLow: x!.low,
        xHigh: x!.high,
        yLow: y!.low,
        yHigh: y!.high,
        step: Number(texelStepQuanta),
    }
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
