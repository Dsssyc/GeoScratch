/** Provides stateless longitude/latitude conversion to normalized Web Mercator coordinates. */
export class MercatorCoordinate {

    static mercatorXfromLon(lon: number): number {

        return (180. + lon) / 360.
    }

    static mercatorYfromLat(lat: number): number {

        return (180. - (180. / Math.PI * Math.log(Math.tan(Math.PI / 4. + lat * Math.PI / 360.)))) / 360.
    }

    static fromLonLat(lonLat: readonly [number, number]): [number, number] {

        const x = MercatorCoordinate.mercatorXfromLon(lonLat[0])
        const y = MercatorCoordinate.mercatorYfromLat(lonLat[1])

        return [ x, y ]
    }

    static toNDC(coords: readonly [number, number]): [number, number] {

        return [
            coords[0] * 2. - 1.,
            1. - coords[1] * 2.,
        ]
    }

    static lonFromMercatorX(x: number): number {

        return x * 360. - 180.
    }

    static latFromMercatorY(y: number): number {

        const y2 = 180.0 - y * 360.0
        return 360.0 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180.0)) - 90.0
    }

    static fromXY(xy: readonly [number, number]): [number, number] {

        const [ x, y ] = xy
        const lon = MercatorCoordinate.lonFromMercatorX(x)
        const lat = MercatorCoordinate.latFromMercatorY(y)
        return [ lon, lat ]
    }

    static fromNDC(xy: readonly [number, number]): [number, number] {

        let [ x, y ] = xy
        x = (x + 1.) / 2.
        y = (1. - y) / 2.
        return MercatorCoordinate.fromXY([ x, y ])
    }
}
