import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('Geo high-precision virtual-raster architecture contract', () => {

    const adr = read('docs', 'decisions', 'ADR-055-high-precision-virtual-raster-dem.md')

    it('freezes the current primary specification baseline', () => {

        expect(adr).to.include('https://gpuweb.github.io/gpuweb/')
        expect(adr).to.include('https://www.w3.org/TR/WGSL/')
        expect(adr).to.include('https://docs.ogc.org/is/21-026/21-026.html')
        expect(adr).to.include('https://rasterio.readthedocs.io/')
        expect(adr).to.include('https://cogeotiff.github.io/rio-cogeo/')
        expect(adr).to.include('https://cogeotiff.github.io/rio-tiler/9.4.2/')
        expect(adr).to.include('retrieved on 2026-08-05')
    })

    it('keeps coordinate, page, and physical execution ownership separate', () => {

        expect(adr).to.include('Scratch remains the explicit GPU execution kernel')
        expect(adr).to.include('Geo owns coordinate domains')
        expect(adr).to.include('Tile and page IDs')
        expect(adr).to.include('They are never position truth')
        expect(adr).to.include('immutable snapshot at a submission boundary')
    })

    it('requires both executable precision encodings without fictional WGSL types', () => {

        expect(adr).to.include('`cell-local-f32`')
        expect(adr).to.include('`wide-fixed`')
        expect(adr).to.include('no runtime f64 or i64')
        expect(adr).to.include('intrinsic dimension + embedding dimension + auxiliary axes')
        expect(adr).to.include('`SurfaceDomain<2, 3>`')
    })

    it('requires logical cross-page filtering and the bounded DEM/Flow endpoint', () => {

        expect(adr).to.include('Filtering is reconstructed in logical space')
        expect(adr).to.include('Physical page-edge clamping')
        expect(adr).to.include('complete PNG browser upload is removed')
        expect(adr).to.include('262,144')
        expect(adr).to.include('does not migrate the visible Flow page')
    })

    it('reserves stable coordinate diagnostic codes', () => {

        for (const code of [
            'GEO_COORDINATE_DIMENSION_MISMATCH',
            'GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED',
            'GEO_COORDINATE_CELL_OVERFLOW',
            'GEO_COORDINATE_FIXED_OVERFLOW',
            'GEO_COORDINATE_INVALID_DOMAIN',
            'GEO_COORDINATE_TRANSFORM_UNSUPPORTED',
            'GEO_COORDINATE_VECTOR_BASIS_MISMATCH',
        ]) {
            expect(adr).to.include(code)
        }
    })
})
