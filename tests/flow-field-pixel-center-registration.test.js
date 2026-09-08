import { expect } from 'chai'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import {
    flowPixelCenterRegistrationWgslModule,
} from '../examples/flowField/flow-pixel-center-registration.ts'

describe('Flow Field pixel-center registration', () => {

    it('maps Virtual Raster levels to exact wide-fixed half-texel quanta', () => {

        const module = flowPixelCenterRegistrationWgslModule(
            velocityModel([ '8', '9' ], 40),
            registrationOptions('ProofAddress', 'ProofRegistration')
        )

        expect(module).to.deep.include({
            kind: 'flow-pixel-center-registration-wgsl-module',
            namespace: 'ProofRegistration',
            addressNamespace: 'ProofAddress',
            positionFunction: 'ProofRegistration_position',
            currentSampleFunction: 'ProofRegistration_sample_current',
            nextSampleFunction: 'ProofRegistration_sample_next',
        })
        expect(module.levels).to.deep.equal([
            { level: 0, matrixId: '9', halfTexelQuanta: { low: 4_194_304, high: 0 } },
            { level: 1, matrixId: '8', halfTexelQuanta: { low: 8_388_608, high: 0 } },
        ])
        expect(module.code).to.include(
            'ProofAddressFixedAxis(4194304u, 0u), ' +
            'ProofAddressFixedAxis(8388608u, 0u)'
        )
        expect(module.code).to.include('ProofAddressFixed_subtract_axis(value, delta)')
        expect(module.code).to.include('return ProofAddressFixedAxis(0u, 0u)')
        expect(module.code).to.include(
            'registered.axes[0] = ProofRegistration_subtract_clamped(position.axes[0], half_texel)'
        )
        expect(module.code).to.include(
            'registered.axes[1] = ProofRegistration_subtract_clamped(position.axes[1], half_texel)'
        )
        expect(module.code).to.not.include('fn ProofRegistration_current_resolution(')
        expect(module.code).to.not.include('fn ProofRegistration_next_resolution(')
        expect(module.code).to.include('ProofCurrent_load_global(base, level)')
        expect(module.code).to.include('ProofNext_load_global(base, level)')
        expect(module.code).to.include('ProofCurrent_edge_blend_weight(position, level) < 1.0f')
        expect(module.code).to.not.include('ProofCurrent_sample_level(position, level)')
        expect(module.code).to.not.include('ProofCurrent_sample_compute(position, level)')
        expect(module.code.indexOf('if (ProofRegistration_axis_less(value, delta))'))
            .to.be.lessThan(module.code.indexOf(
                'ProofAddressFixed_subtract_axis(value, delta)'
            ))
        expect(module.code).to.not.include('advance_i32')
        expect(module.code).to.not.include('vec2f')
        expect(Object.isFrozen(module.levels)).to.equal(true)
    })

    it('uses both wide-fixed limbs instead of narrowing coarse offsets to i32', () => {

        const module = flowPixelCenterRegistrationWgslModule(
            velocityModel([ '4' ], 52),
            registrationOptions('WideAddress')
        )

        expect(module.levels).to.deep.equal([
            { level: 0, matrixId: '4', halfTexelQuanta: { low: 0, high: 128 } },
        ])
        expect(module.code).to.include('WideAddressFixedAxis(0u, 128u)')
    })

    it('aligns both sides of a page seam to the declared pixel-center lattice', () => {

        const model = velocityModel([ '9' ], 40)
        const module = flowPixelCenterRegistrationWgslModule(
            model,
            registrationOptions('SeamAddress')
        )
        const half = BigInt(module.levels[0].halfTexelQuanta.low)
        const texel = half * 2n
        const northing = 128n * texel + half

        for (const globalTexel of [ 255n, 256n ]) {
            const physical = model.addressCodec.fromWorldQuanta([
                globalTexel * texel + half,
                northing,
            ])
            expect(model.addressCodec.address(physical, '9').subTexel)
                .to.deep.equal([ 0.5, 0.5 ])

            const registered = model.addressCodec.advance(physical, [ -half, -half ])
            const address = model.addressCodec.address(registered, '9')
            expect(address.tile.tileCol).to.equal(Number(globalTexel / 256n))
            expect(address.texel[0]).to.equal(Number(globalTexel % 256n))
            expect(address.subTexel).to.deep.equal([ 0, 0 ])

            const west = model.addressCodec.address(
                model.addressCodec.advance(registered, [ -1n, 0n ]),
                '9'
            )
            const east = model.addressCodec.address(
                model.addressCodec.advance(registered, [ 1n, 0n ]),
                '9'
            )
            expect(west.subTexel[0]).to.be.closeTo(1 - 1 / Number(texel), 1e-12)
            expect(east.subTexel[0]).to.equal(1 / Number(texel))
        }
    })

    it('reuses four complete samples while preserving status, fallback and transition priority', () => {

        const module = flowPixelCenterRegistrationWgslModule(
            velocityModel([ '8', '9' ], 40),
            registrationOptions('SeamAddress', 'SeamRegistration')
        )
        const sampler = module.code.slice(
            module.code.indexOf('fn SeamRegistration_sample_current('),
            module.code.indexOf('fn SeamRegistration_sample_next(')
        )
        for (const texel of ['base', 'base + vec2i(1, 0)', 'base + vec2i(0, 1)', 'base + vec2i(1, 1)']) {
            expect(sampler).to.include(`ProofCurrent_load_global(${texel}, level)`)
        }
        expect(sampler.match(/ProofCurrent_load_global\(/g)).to.have.length(4)
        expect(module.code.match(/(?:ProofCurrent|ProofNext)_load_global\(/g)).to.have.length(8)
        expect(module.code).to.not.match(/(?:ProofCurrent|ProofNext)_(?:resolution_global|sample_level|sample_compute)\(/)
        expect(module.code).to.not.match(/(?:page_table|textureLoad|_atlas)/)
        const order = ['let br = ProofCurrent_load_global(', 'tl.status == 4u', 'tl.status == 0u',
            'tl.status == 3u', 'if (resolved_level < level', 'if (resolved_level > level)',
            'ProofCurrent_edge_blend_weight(position, level)', 'let value = mix(']
        for (let index = 1; index < order.length; index++) {
            expect(sampler.indexOf(order[index - 1]), order[index - 1]).to.be.at.least(0)
            expect(sampler.indexOf(order[index - 1]), `${order[index - 1]} before ${order[index]}`)
                .to.be.lessThan(sampler.indexOf(order[index]))
        }
        expect(sampler).to.include(
            'return ProofCurrentSample(vec4f(0.0), 2u, level, level + 1u)'
        )
        expect(sampler).to.include('mix(mix(tl.value, tr.value, address.sub_texel.x),')
        expect(sampler).to.include('mix(bl.value, br.value, address.sub_texel.x), address.sub_texel.y)')
        expect(sampler).to.include('max(max(tl.status, tr.status), max(bl.status, br.status)), level, level)')
    })

    it('requires one more coordinate bit than integer-texel addressing', () => {

        expect(() => flowPixelCenterRegistrationWgslModule(
            velocityModel([ '24' ], 32),
            registrationOptions('TightAddress')
        )).to.throw(RangeError, /requires at least 33 coordinate bits/)

        const exact = flowPixelCenterRegistrationWgslModule(
            velocityModel([ '24' ], 33),
            registrationOptions('ExactAddress')
        )
        expect(exact.levels[0].halfTexelQuanta).to.deep.equal({ low: 1, high: 0 })
    })

    it('rejects invalid WGSL namespaces at the adapter boundary', () => {

        const model = velocityModel([ '9' ], 40)
        expect(() => flowPixelCenterRegistrationWgslModule(
            model,
            registrationOptions('ProofAddress', 'not-valid!')
        )).to.throw(TypeError, /identifiers/)
        expect(() => flowPixelCenterRegistrationWgslModule(
            model,
            registrationOptions('also-not-valid!')
        )).to.throw(TypeError, /identifiers/)
    })

    it('rejects a NoData sentinel instead of confusing it with exact-zero support', () => {

        expect(() => flowPixelCenterRegistrationWgslModule(
            velocityModel([ '9' ], 40, 0),
            registrationOptions('NoDataAddress')
        )).to.throw(TypeError, /without a NoData sentinel/)
    })
})

function registrationOptions(addressNamespace, namespace) {

    return {
        ...(namespace === undefined ? {} : { namespace }),
        addressNamespace,
        currentSamplerNamespace: 'ProofCurrent',
        nextSamplerNamespace: 'ProofNext',
    }
}

function velocityModel(matrixIds, coordinateBits, noData) {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: matrixIds.map(matrixId => ({
            matrixId,
            minTileRow: 0,
            maxTileRow: 0,
            minTileCol: 0,
            maxTileCol: 0,
        })),
    })
    return webMercatorVirtualRasterField({
        id: `flow-registration-${matrixIds.join('-')}-${coordinateBits}`,
        addressSpaceId: `flow-registration-address-${matrixIds.join('-')}-${coordinateBits}`,
        sourceRevision: 'test-v1',
        coverage,
        geographicBounds: [ -180, 0, -179, 1 ],
        coordinateBits,
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        ...(noData === undefined ? {} : { noData }),
        interpolation: 'linear',
    })
}
