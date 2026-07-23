import { expect } from 'chai'
import { bRef, mat3f } from 'geoscratch'

describe('legacy data layout dependencies', () => {

    const originalGpuShaderStage = globalThis.GPUShaderStage

    before(() => {

        globalThis.GPUShaderStage = {
            VERTEX: 1,
            FRAGMENT: 2,
            COMPUTE: 4,
        }
    })

    after(() => {

        globalThis.GPUShaderStage = originalGpuShaderStage
    })

    it('preserves WGSL vec3 alignment and padded wgpu-matrix mat3 storage', () => {

        const block = bRef({
            name: 'LegacyLayout',
            map: {
                scalar: { type: 'f32', data: 2 },
                direction: { type: 'vec3f', data: [ 3, 4, 5 ] },
                weight: { type: 'f32', data: 6 },
                basis: mat3f(),
            },
        })

        expect(block.value.byteLength).to.equal(80)
        expect(Array.from(new Float32Array(block.value))).to.deep.equal([
            2, 0, 0, 0,
            3, 4, 5, 6,
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
        ])
    })
})
