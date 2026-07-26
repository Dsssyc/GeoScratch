import { expect } from 'chai'
import {
    GeoQuadNode2D,
    MercatorCoordinate,
    Node2D,
} from 'geoscratch/geo'

const boundary = box => [
    box.boundary.x,
    box.boundary.y,
    box.boundary.z,
    box.boundary.w,
]

describe('Geo TypeScript migration behavior', () => {

    it('preserves Mercator and NDC conversion behavior', () => {

        expect(MercatorCoordinate.mercatorXfromLon(-180)).to.equal(0)
        expect(MercatorCoordinate.mercatorXfromLon(180)).to.equal(1)
        expect(MercatorCoordinate.mercatorYfromLat(0)).to.equal(0.5)
        expect(MercatorCoordinate.fromLonLat([ 180, 0 ])).to.deep.equal([ 1, 0.5 ])
        expect(MercatorCoordinate.toNDC([ 0.25, 0.75 ])).to.deep.equal([ -0.5, -0.5 ])

        const lonLat = [ 121.5, 31.2 ]
        const restored = MercatorCoordinate.fromNDC(
            MercatorCoordinate.toNDC(MercatorCoordinate.fromLonLat(lonLat)),
        )

        expect(restored[0]).to.be.closeTo(lonLat[0], 1e-12)
        expect(restored[1]).to.be.closeTo(lonLat[1], 1e-12)
    })

    it('preserves GeoQuadNode2D construction and subdivision behavior', () => {

        expect(Node2D).to.equal(GeoQuadNode2D)

        const root = new GeoQuadNode2D()
        expect(root.level).to.equal(0)
        expect(root.id).to.equal(0)
        expect(root.parent).to.equal(undefined)
        expect(root.size).to.equal(180)
        expect(root.children).to.deep.equal([])
        expect(boundary(root.bBox)).to.deep.equal([ -180, -90, 0, 90 ])

        const child = new GeoQuadNode2D(1, 1, root)
        expect(boundary(child.bBox)).to.deep.equal([ -90, -90, 0, 0 ])
        expect(child.isSubdividable({
            cameraBounds: child.bBox,
            cameraPos: [ -45, -45 ],
            zoomLevel: 1,
        })).to.equal(true)
        expect(child.isSubdividable({
            cameraBounds: child.bBox,
            cameraPos: [ 180, 90 ],
            zoomLevel: 1,
        })).to.equal(false)
    })

    it('preserves explicit release state', () => {

        const node = new GeoQuadNode2D()

        expect(node.release()).to.equal(null)
        expect(node.bBox).to.equal(null)
        expect(node.children).to.equal(null)
        expect(node.parent).to.equal(null)
        expect(node.level).to.equal(null)
        expect(node.size).to.equal(null)
        expect(node.id).to.equal(null)
    })
})
