import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'temporal-velocity-raster.ts'
)).href

describe('Flow Field temporal velocity WGSL', () => {

    it('generates two public samplers with one shared address module and common-level retry', async() => {

        const { temporalVelocityWgslModule } = await import(`${moduleUrl}?wgsl=1`)
        const wrapper = fs.readFileSync(path.join(
            process.cwd(),
            'examples',
            'flowField',
            'shaders',
            'temporal-velocity.wgsl'
        ), 'utf8')
        const current = velocityModel('current')
        const next = velocityModel('next')
        const module = temporalVelocityWgslModule(current, next, {
            group: 2,
            currentPageTableBinding: 0,
            currentAtlasBinding: 1,
            nextPageTableBinding: 2,
            nextAtlasBinding: 3,
            wrapper,
        })

        expect(module.bindings).to.deep.equal({
            group: 2,
            current: { pageTable: 0, atlas: 1 },
            next: { pageTable: 2, atlas: 3 },
        })
        expect(module.sampleRegistration).to.equal('global-texel-lattice')
        expect(module.code).to.include('fn FlowVelocityCurrent_sample_compute(')
        expect(module.code).to.include('fn FlowVelocityNext_sample_compute(')
        expect(module.code.match(/struct FlowVelocityAddressFixedPosition/g)).to.have.length(1)
        expect(module.code).to.include('fn FlowVelocity_sample(')
        expect(module.code).to.include('fn FlowVelocity_source_contains(')
        expect(module.code).to.include('if (!FlowVelocity_source_contains(position))')
        expect(module.code).to.include('fn FlowVelocityRegistration_position(')
        expect(module.code).to.not.include('FlowVelocityRegistration_half_texel')
        expect(module.code).to.include(
            'let registered_position = FlowVelocityRegistration_position(position, common_level);'
        )
        expect(module.code).to.include(
            'return FlowVelocityCurrent_sample_compute(position, level);'
        )
        expect(module.code).to.include(
            'return FlowVelocityNext_sample_compute(position, level);'
        )
        expect(module.code).to.include(
            'let current = FlowVelocityRegistration_sample_current('
        )
        expect(module.code).to.include(
            'let next = FlowVelocityRegistration_sample_next('
        )
        expect(module.code).to.include('resolved_level <= common_level')
        expect(module.code).to.include(
            'resolved_level >= FlowVelocityCurrent_level_count'
        )
        expect(module.code).to.include(
            'let velocity = mix(current.value.xy, next.value.xy, temporal.progress);'
        )
        expect(module.code).to.not.match(/slot[_-]?table/i)
        expect(module.code).to.not.match(/prefetch/i)

        const explicitGlobal = temporalVelocityWgslModule(current, next, {
            group: 2,
            currentPageTableBinding: 0,
            currentAtlasBinding: 1,
            nextPageTableBinding: 2,
            nextAtlasBinding: 3,
            wrapper,
            sampleRegistration: 'global-texel-lattice',
        })
        expect(explicitGlobal.code).to.equal(module.code)
    })

    it('adds wide-fixed registration only for explicit pixel-center sampling', async() => {

        const { temporalVelocityWgslModule } = await import(`${moduleUrl}?pixel-center=1`)
        const wrapper = fs.readFileSync(path.join(
            process.cwd(),
            'examples',
            'flowField',
            'shaders',
            'temporal-velocity.wgsl'
        ), 'utf8')
        const current = velocityModel('pixel-current')
        const next = velocityModel('pixel-next')
        const options = {
            group: 2,
            currentPageTableBinding: 0,
            currentAtlasBinding: 1,
            nextPageTableBinding: 2,
            nextAtlasBinding: 3,
            wrapper,
        }
        const module = temporalVelocityWgslModule(current, next, {
            ...options,
            sampleRegistration: 'pixel-center',
        })

        expect(module.sampleRegistration).to.equal('pixel-center')
        expect(module.code).to.include('const FlowVelocityRegistration_half_texel')
        expect(module.code).to.include('FlowVelocityAddressFixed_subtract_axis(value, delta)')
        expect(module.code).to.include('fn FlowVelocityRegistration_current_resolution(')
        expect(module.code).to.include('fn FlowVelocityRegistration_next_resolution(')
        expect(module.code).to.include(
            'FlowVelocityCurrent_edge_blend_weight(position, level) < 1.0f'
        )
        expect(module.code).to.include(
            'return FlowVelocityCurrent_sample_level(position, level);'
        )
        expect(module.code).to.not.include(
            'FlowVelocityAddress_advance_i32(position, vec2i(-half_texel))'
        )
        const loop = module.code.slice(module.code.lastIndexOf(
            'for (var iteration = 0u; iteration < FlowVelocityCurrent_level_count; iteration++)'
        ))
        expect(loop.indexOf('FlowVelocityRegistration_position(position, common_level)'))
            .to.be.lessThan(loop.indexOf('FlowVelocityRegistration_sample_current('))
        expect(loop.indexOf('FlowVelocityRegistration_sample_current('))
            .to.be.lessThan(loop.indexOf('FlowVelocityRegistration_sample_next('))
        expect(loop).to.not.include(
            'FlowVelocityCurrent_sample_compute(position, common_level)'
        )
        expect(loop).to.not.include(
            'FlowVelocityNext_sample_compute(position, common_level)'
        )
        expect(() => temporalVelocityWgslModule(current, next, {
            ...options,
            sampleRegistration: 'half-texel',
        })).to.throw(TypeError, /sampleRegistration/)
    })
})

function velocityModel(id) {

    const limits = Array.from({ length: 6 }, (_value, index) => {
        const matrixId = String(index + 4)
        const tile = WebMercatorQuad.tileFromLonLat([ 121, 31 ], matrixId)
        return {
            matrixId,
            minTileRow: tile.tileRow,
            maxTileRow: tile.tileRow,
            minTileCol: tile.tileCol,
            maxTileCol: tile.tileCol,
        }
    })
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
    return webMercatorVirtualRasterField({
        id: `flow-velocity.${id}`,
        addressSpaceId: `flow-velocity-address.${id}`,
        sourceRevision: 'test-v1',
        coverage,
        geographicBounds: [ 120.5, 30.5, 121.5, 31.5 ],
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        interpolation: 'linear',
    })
}
