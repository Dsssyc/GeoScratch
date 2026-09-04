import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'flow-contour.ts'
)).href
const sourcePath = path.join(
    process.cwd(), 'examples', 'flowField', 'flow-contour.ts'
)
const computeShaderPath = path.join(
    process.cwd(), 'examples', 'flowField', 'shaders', 'contour.compute.wgsl'
)
const renderShaderPath = path.join(
    process.cwd(), 'examples', 'flowField', 'shaders', 'contour.wgsl'
)

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

    it('locks fixed candidate segment indirect overflow and view ABIs', async() => {

        const contour = await import(`${moduleUrl}?gpu-abi=1`)
        expect(contour.FLOW_CONTOUR_CANDIDATE_BYTE_LENGTH).to.equal(32)
        expect(contour.FLOW_CONTOUR_SEGMENT_BYTE_LENGTH).to.equal(32)
        expect(contour.FLOW_CONTOUR_INDIRECT_BYTE_LENGTH).to.equal(16)
        expect(contour.FLOW_CONTOUR_OVERFLOW_BYTE_LENGTH).to.equal(4)
        expect(contour.FLOW_CONTOUR_VIEW_UNIFORM_BYTE_LENGTH).to.equal(112)

        const source = fs.readFileSync(sourcePath, 'utf8')
        for (const label of [
            'Flow Field contour candidates',
            'Flow Field contour segments',
            'Initialize Flow Field contour segments',
            'Flow Field contour indirect arguments',
            'Flow Field contour overflow',
            'Flow Field contour uniform',
        ]) {
            expect(source).to.include(label)
        }
        expect(source).to.include('candidateBytes: ArrayBufferView')
        expect(source).to.include('candidateStaging.set(new Uint8Array(')
        expect(source).to.include('builder.upload(candidateUpload)')
        expect(source).to.include('usage: BUFFER_COPY_DST | BUFFER_STORAGE')
        expect(source).to.include('builder.clear(clearSegments)')
        expect(source).to.include("{ resource: segments, contentEpoch: 'current-at-step' }")
        expect(source).to.include('segmentCapacity * FLOW_CONTOUR_SEGMENT_BYTE_LENGTH')
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
    })

    it('injects borrowed temporal and draw-view bindings without owning them', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('temporal: FlowContourTemporalBinding')
        expect(source).to.include('view: FlowContourViewBinding')
        expect(source).to.include('temporal.module.code')
        expect(source).to.include('bindLayouts: [ computeLayout, temporal.layout ]')
        expect(source).to.include('bindLayouts: [ segmentLayout, view.bindLayout ]')
        expect(source).to.include('temporalFrame: FlowTemporalReadyBindingFrame')
        expect(source).to.not.include('temporal.frame()')
        expect(source).to.include('temporalFrame.pairGeneration !== snapshot.generation')
        expect(source).to.include('{ set: temporalFrame.bindSet }')
        expect(source).to.include('temporalSet !== temporalFrame.bindSet')
        expect(source).to.include('generate?.dispose()')
        expect(source).to.include('{ set: view.bindSet }')
        expect(source).to.include('...currentReads(temporalFrame.resources)')
        expect(source).to.include('...currentReads(view.resources)')
        expect(source).to.not.include('temporal.layout.dispose()')
        expect(source).to.not.include('view.bindSet.dispose()')
        expect(source).to.not.include('view.bindLayout.dispose()')
    })

    it('encodes bounded compute and overflow observation before exposing indirect draw', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        const candidates = source.indexOf('builder.upload(candidateUpload)')
        const uniform = source.indexOf('builder.upload(uniformUpload)')
        const indirect = source.indexOf('builder.upload(indirectReset)')
        const overflow = source.indexOf('builder.clear(clearOverflow)')
        const compute = source.indexOf('builder.compute(computePass, [ generate ])')
        const readback = source.indexOf('builder.readback(overflowReadback)')
        expect(candidates).to.be.greaterThan(-1)
        expect(uniform).to.be.greaterThan(candidates)
        expect(indirect).to.be.greaterThan(uniform)
        expect(overflow).to.be.greaterThan(indirect)
        expect(compute).to.be.greaterThan(overflow)
        expect(readback).to.be.greaterThan(compute)
        expect(source).to.include("primitive: { topology: 'line-list' }")
        expect(source).to.include('count: { indirect: indirect.region() }')
        expect(source).to.include('retain: \'consume-on-read\'')
        expect(source).to.include('region: overflow.region()')
    })

    it('observes exactly one overflow word and rejects any nonzero flag', async() => {

        const { assertFlowContourOverflow } = await import(`${moduleUrl}?overflow-word=1`)
        expect(() => assertFlowContourOverflow(new Uint32Array([ 0 ]))).not.to.throw()
        expect(() => assertFlowContourOverflow(new Uint32Array([ 1 ])))
            .to.throw('Flow contour segment capacity was exceeded')
        expect(() => assertFlowContourOverflow(new Uint32Array([ 0, 0 ])))
            .to.throw('Flow contour overflow observation must contain one u32')

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('overflowReadback.result({ after: submitted })')
        expect(source).to.include('toArray(Uint32Array)')
        expect(source).not.to.match(/segmentsReadback|readbackSegments|toArray\(Float32Array\)/)
    })

    it('generates half-open cells with the same deterministic 5 and 10 decider on GPU', () => {

        const shader = fs.readFileSync(computeShaderPath, 'utf8')
        expect(shader).to.include('struct FlowContourCandidateCell')
        expect(shader).to.include('origin: FlowVelocityAddressFixedPosition')
        expect(shader).to.include('texelStepQuanta: u32')
        expect(shader).to.include('requestedLevel: u32')
        expect(shader).to.include('candidateIndex >= contourUniform.candidateCount')
        expect(shader).to.include('FlowVelocity_sample(')
        expect(shader).to.include('sample.speed - contourUniform.activityKill')
        expect(shader).to.include('let determinant = values[0] * values[2] - values[1] * values[3]')
        expect(shader).to.match(/case 5u:[\s\S]*determinant >= 0\.0/)
        expect(shader).to.match(/case 10u:[\s\S]*determinant >= 0\.0/)
        expect(shader).to.include('atomicStore(&overflow.value, 1u)')
        expect(shader).to.not.match(/textureStore|boundary|depth|wet|sdf/i)
    })

    it('stores wide-fixed endpoints and projects only camera-relative differences at draw', () => {

        const shader = fs.readFileSync(renderShaderPath, 'utf8')
        expect(shader).to.include('struct FlowContourEndpoint')
        expect(shader).to.include('x: vec2u')
        expect(shader).to.include('y: vec2u')
        expect(shader).to.include('clipFromRelativeWorld: mat4x4f')
        expect(shader).to.include('cameraX: vec2u')
        expect(shader).to.include('cameraY: vec2u')
        expect(shader).to.include('cameraZ: vec2f')
        expect(shader).to.include('metersPerQuantum: f32')
        expect(shader).to.include('fixedDifferenceMeters(')
        expect(shader).to.include('contourView.clipFromRelativeWorld * relative')
        expect(shader).to.not.match(/normalizedWorld|worldPosition:\s*vec2f/)
    })
})
