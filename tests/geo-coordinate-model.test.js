import { expect } from 'chai'
import {
    GeoDiagnosticError,
    cellLocalF32Codec,
    coordinateDomain,
    localVector,
    surfaceDomain,
    wideFixedCodec,
} from 'geoscratch/geo'

const expectGeoCode = (action, code) => {

    expect(action).to.throw(GeoDiagnosticError).with.property('diagnostic')
        .that.includes({ code })
}

describe('Geo high-precision coordinate model', () => {

    const planar = coordinateDomain({
        id: 'test.planar',
        intrinsicDimensions: 2,
        embeddingDimensions: 2,
        axes: [
            { name: 'x', unit: 'm' },
            { name: 'y', unit: 'm' },
        ],
        auxiliaryAxes: [ { name: 'time', unit: 's' } ],
    })
    const volume = coordinateDomain({
        id: 'test.volume',
        intrinsicDimensions: 3,
        embeddingDimensions: 3,
        axes: [
            { name: 'x', unit: 'm' },
            { name: 'y', unit: 'm' },
            { name: 'z', unit: 'm' },
        ],
    })

    it('distinguishes intrinsic, embedding, and auxiliary dimensions', () => {

        const terrain = surfaceDomain({
            id: 'test.terrain',
            axes: [
                { name: 'longitude', unit: 'degree' },
                { name: 'latitude', unit: 'degree' },
            ],
            embeddingAxes: [
                { name: 'x', unit: 'm' },
                { name: 'y', unit: 'm' },
                { name: 'z', unit: 'm' },
            ],
            auxiliaryAxes: [ { name: 'lod', unit: 'level' } ],
        })

        expect(terrain.intrinsicDimensions).to.equal(2)
        expect(terrain.embeddingDimensions).to.equal(3)
        expect(terrain.auxiliaryAxes).to.deep.equal([ { name: 'lod', unit: 'level' } ])
        expect(Object.isFrozen(terrain)).to.equal(true)
        expectGeoCode(() => coordinateDomain({
            id: 'bad',
            intrinsicDimensions: 2,
            embeddingDimensions: 3,
            axes: [ { name: 'x', unit: 'm' } ],
        }), 'GEO_COORDINATE_DIMENSION_MISMATCH')
    })

    it('normalizes and advances cell-local-f32 positions across cells', () => {

        const codec = cellLocalF32Codec({
            domain: planar,
            cellExtent: [ 1024, 1024 ],
            maxLocalUlp: 0.0002,
        })
        const start = codec.normalize({
            cells: [ 12, -5 ],
            local: [ 1023.75, -0.25 ],
        })

        expect(start.cells).to.deep.equal([ 12, -6 ])
        expect(start.local).to.deep.equal([ 1023.75, 1023.75 ])

        const velocity = localVector(planar, [ 0.5, -2048.5 ], {
            unit: 'm',
            basis: 'test.planar',
        })
        const advanced = codec.advance(start, velocity)

        expect(advanced.cells).to.deep.equal([ 13, -8 ])
        expect(advanced.local).to.deep.equal([ 0.25, 1023.25 ])
        expect(codec.difference(advanced, start)).to.deep.equal([ 0.5, -2048.5 ])
    })

    it('computes camera-relative differences before f32 conversion and rebases', () => {

        const codec = cellLocalF32Codec({ domain: volume, cellExtent: 4096 })
        const camera = codec.normalize({
            cells: [ 1_000_000, -1_000_000, 20 ],
            local: [ 4095.75, 0.25, 100 ],
        })
        const target = codec.normalize({
            cells: [ 1_000_001, -1_000_001, 20 ],
            local: [ 0.25, 4095.75, 100.125 ],
        })

        expect(codec.cameraRelative(target, camera)).to.deep.equal([ 0.5, -0.5, 0.125 ])
        expect(codec.rebase(target, camera)).to.deep.equal({
            cells: [ 0, -1, 0 ],
            local: [ 0.5, 4095.5, 0.125 ],
            dimensions: 3,
            encoding: 'cell-local-f32',
        })
        expect(codec.facts).to.include({
            dimensions: 3,
            encoding: 'cell-local-f32',
            bytesPerPosition: 24,
            overflowPolicy: 'error',
            wrapPolicy: 'none',
        })
    })

    it('packs 2D and 3D cell-local values and exposes matching WGSL', () => {

        for (const [ domain, position ] of [
            [ planar, { cells: [ -2, 7 ], local: [ 1.25, 511.5 ] } ],
            [ volume, { cells: [ -2, 7, 9 ], local: [ 1.25, 511.5, 2.75 ] } ],
        ]) {
            const codec = cellLocalF32Codec({ domain, cellExtent: 1024 })
            const normalized = codec.normalize(position)
            const packed = codec.pack([ normalized ])

            expect(packed.byteLength).to.equal(codec.facts.bytesPerPosition)
            expect(codec.unpack(packed)).to.deep.equal([ normalized ])
            const wgsl = codec.wgslModule({ namespace: `Cell${domain.intrinsicDimensions}D` })
            expect(wgsl).to.include(`struct Cell${domain.intrinsicDimensions}DPosition`)
            expect(wgsl).to.include(`fn Cell${domain.intrinsicDimensions}D_normalize`)
            expect(wgsl).to.include(`fn Cell${domain.intrinsicDimensions}D_advance`)
            expect(wgsl).to.include(`fn Cell${domain.intrinsicDimensions}D_difference`)
            expect(wgsl).to.not.include('f64')
            expect(wgsl).to.not.include('i64')
        }
    })

    it('rejects basis mismatches, precision-budget failures, and cell overflow', () => {

        const strict = cellLocalF32Codec({
            domain: planar,
            cellExtent: 1_048_576,
            maxLocalUlp: 0.01,
        })
        expectGeoCode(() => strict.advance(
            strict.normalize({ cells: [ 0, 0 ], local: [ 0, 0 ] }),
            localVector(planar, [ 1, 1 ], { unit: 'm', basis: 'another-domain' }),
        ), 'GEO_COORDINATE_VECTOR_BASIS_MISMATCH')
        expectGeoCode(() => strict.assertPrecisionBudget(0.001),
            'GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED')
        expectGeoCode(() => strict.normalize({
            cells: [ 2_147_483_647, 0 ],
            local: [ 1_048_576, 0 ],
        }), 'GEO_COORDINATE_CELL_OVERFLOW')
    })

    it('uses two u32 limbs per axis for signed wide-fixed arithmetic', () => {

        const codec = wideFixedCodec({ domain: volume, quantum: 0.001 })
        const start = codec.fromQuanta([
            (1n << 53n) + 17n,
            -((1n << 48n) + 9n),
            4_294_967_295n,
        ])
        const advanced = codec.add(start, [ 4_294_967_296n, -3n, 2n ])

        expect(codec.toQuanta(advanced)).to.deep.equal([
            (1n << 53n) + 17n + 4_294_967_296n,
            -((1n << 48n) + 12n),
            4_294_967_297n,
        ])
        expect(codec.difference(advanced, start)).to.deep.equal([
            4_294_967_296n,
            -3n,
            2n,
        ])
        expect(codec.subtract(advanced, [ 4_294_967_296n, -3n, 2n ])).to.deep.equal(start)
        expect(codec.facts).to.include({
            dimensions: 3,
            encoding: 'wide-fixed',
            bytesPerPosition: 24,
            fixedQuantum: 0.001,
        })
    })

    it('decomposes wide-fixed positions into transient LoD addresses', () => {

        const codec = wideFixedCodec({ domain: planar, quantum: 1 })
        const position = codec.fromQuanta([ 123_457n, -1n ])
        const address = codec.decomposeLod(position, { lod: 3, pageSize: 256 })

        expect(address).to.deep.equal([
            { page: 60n, texel: 72, subTexel: 1n },
            { page: -1n, texel: 255, subTexel: 7n },
        ])
        expect(Object.isFrozen(address)).to.equal(true)
    })

    it('packs wide-fixed limbs bit-exactly and exposes carry/borrow WGSL', () => {

        for (const domain of [ planar, volume ]) {
            const codec = wideFixedCodec({ domain, quantum: 0.25 })
            const position = codec.fromQuanta(
                Array.from({ length: domain.intrinsicDimensions }, (_, index) =>
                    index % 2 === 0 ? (1n << 40n) + BigInt(index) : -9n,
                ),
            )
            const packed = codec.pack([ position ])

            expect(packed.byteLength).to.equal(codec.facts.bytesPerPosition)
            expect(codec.unpack(packed)).to.deep.equal([ position ])
            const wgsl = codec.wgslModule({ namespace: `Fixed${domain.intrinsicDimensions}D` })
            expect(wgsl).to.include('low: u32')
            expect(wgsl).to.include('high: u32')
            expect(wgsl).to.include('select(0u, 1u')
            expect(wgsl).to.include(`fn Fixed${domain.intrinsicDimensions}D_add`)
            expect(wgsl).to.include(`fn Fixed${domain.intrinsicDimensions}D_subtract`)
            expect(wgsl).to.not.include('f64')
            expect(wgsl).to.not.include('i64')
        }
    })

    it('reports signed fixed overflow instead of wrapping silently', () => {

        const codec = wideFixedCodec({ domain: planar, quantum: 1 })
        const maximum = codec.fromQuanta([ (1n << 63n) - 1n, 0n ])

        expectGeoCode(() => codec.add(maximum, [ 1n, 0n ]),
            'GEO_COORDINATE_FIXED_OVERFLOW')
    })
})
