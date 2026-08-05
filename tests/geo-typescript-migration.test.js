import { expect } from 'chai'
import { MercatorCoordinate } from 'geoscratch/geo'

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
})
