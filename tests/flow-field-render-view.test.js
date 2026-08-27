import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    WebMercatorQuad,
    createGeoViewSnapshot,
    tileMatrixCoverage,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'
import {
    FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH,
    flowRenderViewValues,
} from '../examples/flowField/flow-render-view.ts'

const sourcePath = path.join(process.cwd(), 'examples', 'flowField', 'flow-render-view.ts')

describe('Flow Field shared render view', () => {

    it('packs authoritative camera facts into the contour-compatible 112-byte ABI', () => {

        const coverage = tileMatrixCoverage({
            tileMatrixSet: WebMercatorQuad,
            limits: [ {
                matrixId: '4', minTileRow: 0, maxTileRow: 15,
                minTileCol: 0, maxTileCol: 15,
            } ],
        })
        const addressCodec = webMercatorQuadAddressCodec({ coverage })
        const view = createGeoViewSnapshot({
            id: 'flow-render-view',
            clipFromRelativeWorld: Array.from({ length: 16 }, (_, index) => index + 1),
            cameraHigh: [ 1000, 2000, 300 ],
            cameraLow: [ 0.25, -0.5, 0.125 ],
            referenceViewport: [ 1280, 720 ],
            verticalFovRadians: Math.PI / 3,
            cameraLatitudeRadians: 0.5,
            cameraPitchRadians: 0.7,
            zoomHint: 9,
            frameEpoch: 7,
            residencySnapshotEpoch: 3,
        })
        const expected = addressCodec.fromProjected([ 1000.25, 1999.5 ]).fixed.limbs
        const values = flowRenderViewValues(view, addressCodec)

        expect(FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH).to.equal(112)
        expect(values.clipFromRelativeWorld).to.deep.equal(view.clipFromRelativeWorld)
        expect(values.cameraX).to.deep.equal([ expected[0].low, expected[0].high ])
        expect(values.cameraY).to.deep.equal([ expected[1].low, expected[1].high ])
        expect(values.cameraZ).to.deep.equal([ 300, 0.125 ])
        expect(values.metersPerQuantum).to.equal(addressCodec.quantumMeters)
    })

    it('owns one group-1 contourView upload binding and no frame authority', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include("name: 'contourView'")
        expect(source).to.include('group: 1')
        expect(source).to.include('minBindingSize: FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH')
        expect(source).to.include("visibility: [ 'vertex' ]")
        expect(source).to.include('builder.upload(upload)')
        expect(source).to.include('const resources = Object.freeze([ buffer ])')
        expect(source).to.not.match(/createGeoFrameController|frameController|mapLibreFrameDriver/)
        expect(source).to.not.match(/runtime\.(?:device|queue)|readback|normalizedWorld/i)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
    })
})
