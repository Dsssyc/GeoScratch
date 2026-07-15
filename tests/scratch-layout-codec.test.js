import { expect } from 'chai'
import {
    LayoutCodec,
    ScratchDiagnosticError,
    layoutCodec,
} from 'geoscratch'
import * as scratchCompat from 'geoscratch/scratch'

function bytesOf(view) {

    return [ ...view ]
}

function f32At(bytes, offset) {

    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true)
}

describe('scratch LayoutCodec', () => {

    it('lowers struct fields to deterministic WGSL host-shareable offsets', () => {

        const codec = layoutCodec({
            label: 'camera uniforms',
            name: 'CameraUniforms',
            fields: [
                { name: 'time', type: 'f32' },
                { name: 'position', type: 'vec3f' },
                { name: 'flags', type: 'vec2u' },
                { name: 'viewProjection', type: 'mat4x4f' },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        })

        expect(codec).to.be.instanceOf(LayoutCodec)
        expect(codec.artifact).to.include({
            kind: 'LayoutArtifact',
            name: 'CameraUniforms',
            label: 'camera uniforms',
            alignment: 16,
            byteLength: 112,
            stride: 112,
            alignmentMode: 'host-shareable',
        })
        expect(codec.artifact.usages).to.deep.equal([ 'uniform', 'storage', 'readback' ])
        expect(codec.artifact.usageCompatibility).to.deep.equal({
            uniform: true,
            storage: true,
            readback: true,
            vertex: false,
        })
        expect(codec.artifact.abiHash).to.match(/^layout-abi-[0-9a-f]{16}$/)
        expect(codec.artifact.schemaHash).to.match(/^layout-schema-[0-9a-f]{16}$/)
        const sameArtifact = layoutCodec({
            label: 'camera uniforms',
            name: 'CameraUniforms',
            fields: [
                { name: 'time', type: 'f32' },
                { name: 'position', type: 'vec3f' },
                { name: 'flags', type: 'vec2u' },
                { name: 'viewProjection', type: 'mat4x4f' },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        }).artifact
        expect(sameArtifact.abiHash).to.equal(codec.artifact.abiHash)
        expect(sameArtifact.schemaHash).to.equal(codec.artifact.schemaHash)
        const changedArtifact = layoutCodec({
            name: 'CameraUniforms',
            fields: [
                { name: 'time', type: 'u32' },
                { name: 'position', type: 'vec3f' },
                { name: 'flags', type: 'vec2u' },
                { name: 'viewProjection', type: 'mat4x4f' },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        }).artifact
        expect(changedArtifact.abiHash).to.not.equal(codec.artifact.abiHash)
        expect(changedArtifact.schemaHash).to.not.equal(codec.artifact.schemaHash)
        expect(codec.artifact.fields.map(field => ({
            name: field.name,
            type: field.type,
            offset: field.offset,
            size: field.size,
            alignment: field.alignment,
            padding: field.padding,
        }))).to.deep.equal([
            { name: 'time', type: 'f32', offset: 0, size: 4, alignment: 4, padding: 12 },
            { name: 'position', type: 'vec3f', offset: 16, size: 12, alignment: 16, padding: 4 },
            { name: 'flags', type: 'vec2u', offset: 32, size: 8, alignment: 8, padding: 8 },
            { name: 'viewProjection', type: 'mat4x4f', offset: 48, size: 64, alignment: 16, padding: 0 },
        ])
    })

    it('packs logical values into aligned bytes and returns upload views', () => {

        const codec = layoutCodec({
            name: 'Particle',
            fields: [
                { name: 'position', type: 'vec3f' },
                { name: 'mass', type: 'f32' },
                { name: 'directions', type: { element: 'vec3f', count: 2 } },
            ],
        })

        expect(codec.artifact.byteLength).to.equal(48)
        expect(codec.artifact.fields.map(field => ({
            name: field.name,
            offset: field.offset,
            size: field.size,
            alignment: field.alignment,
            arrayStride: field.arrayStride,
        }))).to.deep.equal([
            { name: 'position', offset: 0, size: 12, alignment: 16, arrayStride: undefined },
            { name: 'mass', offset: 12, size: 4, alignment: 4, arrayStride: undefined },
            { name: 'directions', offset: 16, size: 32, alignment: 16, arrayStride: 16 },
        ])

        const bytes = codec.pack({
            position: [ 1, 2, 3 ],
            mass: 4,
            directions: [
                [ 5, 6, 7 ],
                [ 8, 9, 10 ],
            ],
        })
        const upload = codec.uploadView({
            position: [ 1, 2, 3 ],
            mass: 4,
            directions: [
                [ 5, 6, 7 ],
                [ 8, 9, 10 ],
            ],
        })

        expect(bytes).to.be.instanceOf(Uint8Array)
        expect(bytes.byteLength).to.equal(48)
        expect(upload).to.deep.include({
            byteOffset: 0,
            byteLength: 48,
            artifact: codec.artifact,
        })
        expect(upload.bytes).to.deep.equal(bytes)
        expect(f32At(bytes, 0)).to.equal(1)
        expect(f32At(bytes, 4)).to.equal(2)
        expect(f32At(bytes, 8)).to.equal(3)
        expect(f32At(bytes, 12)).to.equal(4)
        expect(f32At(bytes, 16)).to.equal(5)
        expect(f32At(bytes, 20)).to.equal(6)
        expect(f32At(bytes, 24)).to.equal(7)
        expect(bytesOf(bytes.slice(28, 32))).to.deep.equal(new Array(4).fill(0))
        expect(f32At(bytes, 32)).to.equal(8)
        expect(f32At(bytes, 36)).to.equal(9)
        expect(f32At(bytes, 40)).to.equal(10)
        expect(bytesOf(bytes.slice(44))).to.deep.equal(new Array(4).fill(0))

        const target = new ArrayBuffer(64)
        const written = codec.write(target, {
            position: [ 1, 2, 3 ],
            mass: 4,
            directions: [
                [ 5, 6, 7 ],
                [ 8, 9, 10 ],
            ],
        }, {
            byteOffset: 8,
        })

        expect(written.byteOffset).to.equal(8)
        expect(written.byteLength).to.equal(48)
        expect(f32At(written, 0)).to.equal(1)
        expect(f32At(written, 40)).to.equal(10)
        expect(bytesOf(new Uint8Array(target, 0, 8))).to.deep.equal(new Array(8).fill(0))
    })

    it('reports portable uniform compatibility from WGSL address-space constraints', () => {

        const scalarArray = layoutCodec({
            name: 'ScalarArray',
            fields: [
                { name: 'values', type: { element: 'u32', count: 2 } },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        })
        const vectorArray = layoutCodec({
            name: 'VectorArray',
            fields: [
                { name: 'values', type: { element: 'vec2f', count: 2 } },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        })
        const alignedArray = layoutCodec({
            name: 'AlignedArray',
            fields: [
                { name: 'prefix', type: 'u32' },
                { name: 'values', type: { element: 'vec4f', count: 2 } },
            ],
        }, {
            usage: [ 'uniform', 'storage', 'readback' ],
        })

        expect(scalarArray.artifact.fields[0].arrayStride).to.equal(4)
        expect(vectorArray.artifact.fields[0].arrayStride).to.equal(8)
        expect(scalarArray.artifact.usageCompatibility).to.include({
            uniform: false,
            storage: true,
            readback: true,
        })
        expect(vectorArray.artifact.usageCompatibility.uniform).to.equal(false)
        expect(alignedArray.artifact.fields[1]).to.include({
            offset: 16,
            arrayStride: 16,
        })
        expect(alignedArray.artifact.usageCompatibility.uniform).to.equal(true)
    })

    it('packs arrays with struct stride and creates readback views', () => {

        const codec = layoutCodec({
            name: 'Sample',
            fields: [
                { name: 'direction', type: 'vec3f' },
                { name: 'value', type: 'f32' },
            ],
        })

        const bytes = codec.pack([
            { direction: [ 1, 2, 3 ], value: 4 },
            { direction: [ 5, 6, 7 ], value: 8 },
        ])
        const readback = codec.createReadbackView(bytes)

        expect(codec.artifact.byteLength).to.equal(16)
        expect(bytes.byteLength).to.equal(32)
        expect(readback.count).to.equal(2)
        expect(readback.byteLength).to.equal(32)
        expect(readback.toObject(0)).to.deep.equal({
            direction: [ 1, 2, 3 ],
            value: 4,
        })
        expect(readback.toObject(1)).to.deep.equal({
            direction: [ 5, 6, 7 ],
            value: 8,
        })
        expect(readback.toArray()).to.deep.equal([
            { direction: [ 1, 2, 3 ], value: 4 },
            { direction: [ 5, 6, 7 ], value: 8 },
        ])
    })

    it('generates stable WGSL struct and accessor modules', () => {

        const codec = layoutCodec({
            name: 'Particle',
            fields: [
                { name: 'position', type: 'vec3f' },
                { name: 'ids', type: { element: 'u32', count: 3 } },
            ],
        })

        const wgsl = codec.wgslAccessors({ namespace: 'ParticleLayout' })

        expect(wgsl).to.include('struct Particle {')
        expect(wgsl).to.include('position: vec3f,')
        expect(wgsl).to.include('ids: array<u32, 3>,')
        expect(wgsl).to.include('const ParticleLayout_BYTE_LENGTH: u32 = 32u;')
        expect(wgsl).to.include('const ParticleLayout_POSITION_OFFSET: u32 = 0u;')
        expect(wgsl).to.include('const ParticleLayout_IDS_OFFSET: u32 = 12u;')
        expect(wgsl).to.include('fn ParticleLayout_readPosition(value: Particle) -> vec3f {')
        expect(wgsl).to.include('fn ParticleLayout_readIds(value: Particle) -> array<u32, 3> {')
    })

    it('accepts the WGSL u32 boundary and rejects unsafe layout-size arithmetic', () => {

        const largestAlignedArrayCount = Math.floor(0xffff_ffff / 16)
        const largestU32Array = layoutCodec({
            name: 'LargestU32Layout',
            fields: [ { name: 'values', type: { element: 'u32', count: 0x3fff_ffff } } ],
        })
        expect(largestU32Array.artifact.byteLength).to.equal(0xffff_fffc)
        expect(largestU32Array.wgslAccessors())
            .to.include('const LargestU32Layout_BYTE_LENGTH: u32 = 4294967292u;')

        const cases = [
            {
                spec: {
                    name: 'BeyondWgslU32',
                    fields: [ { name: 'values', type: { element: 'u32', count: 0x4000_0000 } } ],
                },
                reason: 'array-size',
                wgslU32Overflow: true,
            },
            {
                spec: {
                    name: 'UnsafeArrayProduct',
                    fields: [ { name: 'values', type: { element: 'vec4f', count: Number.MAX_SAFE_INTEGER } } ],
                },
                reason: 'array-size',
            },
            {
                spec: {
                    name: 'UnsafeFieldEnd',
                    fields: [
                        { name: 'values', type: { element: 'vec4f', count: largestAlignedArrayCount } },
                        { name: 'tail', type: 'vec4f' },
                    ],
                },
                reason: 'field-end',
            },
            {
                spec: {
                    name: 'UnsafeStructAlignment',
                    fields: [
                        { name: 'values', type: { element: 'vec4f', count: largestAlignedArrayCount } },
                        { name: 'tail', type: 'f32' },
                    ],
                },
                reason: 'struct-size',
            },
        ]

        for (const { spec, reason, wgslU32Overflow = false } of cases) {
            try {
                layoutCodec(spec)
                throw new Error(`expected ${reason} overflow to fail`)
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
                    severity: 'error',
                    phase: 'layout-codec',
                })
                expect(error.diagnostic.actual).to.deep.include({
                    reason,
                    safeIntegerMax: Number.MAX_SAFE_INTEGER,
                })
                if (wgslU32Overflow) {
                    expect(error.diagnostic.actual).to.deep.include({
                        result: 0x1_0000_0000,
                        wgslU32Max: 0xffff_ffff,
                    })
                }
            }
        }
    })

    it('throws structured layout-codec diagnostics for invalid descriptors and bytes', () => {

        expect(() => layoutCodec({
            name: 'Broken',
            fields: [
                { name: 'bad', type: 'vec5f' },
            ],
        })).to.throw(ScratchDiagnosticError)

        try {
            layoutCodec({
                name: 'Broken',
                fields: [
                    { name: 'bad', type: 'vec5f' },
                ],
            })
        } catch (error) {
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
                severity: 'error',
                phase: 'layout-codec',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'LayoutField',
                path: 'bad',
                label: 'bad',
            })
        }

        const codec = layoutCodec({
            name: 'Small',
            fields: [
                { name: 'value', type: 'f32' },
            ],
        })

        try {
            codec.createReadbackView(new Uint8Array(2))
            throw new Error('expected readback byte length validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
                severity: 'error',
                phase: 'layout-codec',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'LayoutArtifact',
                abiHash: codec.artifact.abiHash,
                schemaHash: codec.artifact.schemaHash,
                label: 'Small',
            })
        }
    })

    it('is exported from both package entrypoints', () => {

        expect(scratchCompat.LayoutCodec).to.equal(LayoutCodec)
        expect(scratchCompat.layoutCodec).to.equal(layoutCodec)
    })
})
