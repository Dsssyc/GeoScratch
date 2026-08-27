import { expect } from 'chai'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-contour.ts'
)).href

describe('Flow Field contour reference', () => {

    it('covers every marching-squares case with at most two finite segments', async() => {

        const { flowContourSegments } = await import(moduleUrl)
        for (let code = 0; code < 16; code++) {
            const values = [ 0, 1, 2, 3 ].map(bit => (code & (1 << bit)) === 0 ? -1 : 1)
            const segments = flowContourSegments(values, 0)
            expect(segments.length, `case ${code}`).to.be.at.most(2)
            for (const segment of segments) {
                expect(segment).to.have.length(2)
                for (const point of segment) {
                    expect(point).to.have.length(2)
                    expect(point.every(Number.isFinite)).to.equal(true)
                    expect(point[0]).to.be.within(0, 1)
                    expect(point[1]).to.be.within(0, 1)
                }
            }
        }
        expect(flowContourSegments([ -1, -1, -1, -1 ], 0)).to.deep.equal([])
        expect(flowContourSegments([ 1, 1, 1, 1 ], 0)).to.deep.equal([])
    })

    it('resolves ambiguous cases deterministically from bilinear corner values', async() => {

        const { flowContourSegments } = await import(`${moduleUrl}?ambiguous=1`)
        const positive = flowContourSegments([ 4, -1, 4, -1 ], 0)
        const negative = flowContourSegments([ 1, -4, 1, -4 ], 0)
        expect(positive).to.have.length(2)
        expect(negative).to.have.length(2)
        expect(positive).not.to.deep.equal(negative)
        expect(flowContourSegments([ 4, -1, 4, -1 ], 0)).to.deep.equal(positive)
    })

    it('uses half-open page ownership for cross-page cells', async() => {

        const { ownsFlowContourCell } = await import(`${moduleUrl}?ownership=1`)
        expect(ownsFlowContourCell({
            cellX: 255,
            cellY: 12,
            pageCol: 0,
            pageRow: 0,
            pageSize: 256,
            globalWidth: 512,
            globalHeight: 512,
        })).to.equal(true)
        expect(ownsFlowContourCell({
            cellX: 255,
            cellY: 12,
            pageCol: 1,
            pageRow: 0,
            pageSize: 256,
            globalWidth: 512,
            globalHeight: 512,
        })).to.equal(false)
        expect(ownsFlowContourCell({
            cellX: 511,
            cellY: 12,
            pageCol: 1,
            pageRow: 0,
            pageSize: 256,
            globalWidth: 512,
            globalHeight: 512,
        })).to.equal(false)
    })

    it('reports bounded worst-case segment capacity without truncation', async() => {

        const { flowContourCapacity } = await import(`${moduleUrl}?capacity=1`)
        expect(flowContourCapacity({ candidateCellCount: 100, segmentCapacity: 200 }))
            .to.deep.equal({ requiredMaximum: 200, capacity: 200, overflow: false })
        expect(flowContourCapacity({ candidateCellCount: 101, segmentCapacity: 200 }))
            .to.deep.equal({ requiredMaximum: 202, capacity: 200, overflow: true })
    })
})
