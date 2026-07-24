import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

function uint16At(bytes, offset) {

    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getUint16(offset, true)
}

function expectLayoutDiagnostic(action, code, path) {

    try {
        action()
        throw new Error(`expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({
            code,
            severity: 'error',
            phase: 'layout-codec',
        })
        if (path !== undefined) {
            expect(error.diagnostic.subject).to.include({
                kind: 'LayoutField',
                path,
            })
        }
    }
}

describe('scratch recursive WGSL layout semantics', () => {

    it('matches the official scalar, vector, and matrix alignment table', () => {

        const cases = [
            [ 'i32', 4, 4 ],
            [ 'u32', 4, 4 ],
            [ 'f32', 4, 4 ],
            [ 'f16', 2, 2 ],
            [ 'vec2i', 8, 8 ],
            [ 'vec3i', 16, 12 ],
            [ 'vec4i', 16, 16 ],
            [ 'vec2u', 8, 8 ],
            [ 'vec3u', 16, 12 ],
            [ 'vec4u', 16, 16 ],
            [ 'vec2f', 8, 8 ],
            [ 'vec3f', 16, 12 ],
            [ 'vec4f', 16, 16 ],
            [ 'vec2h', 4, 4 ],
            [ 'vec3h', 8, 6 ],
            [ 'vec4h', 8, 8 ],
        ]
        for (const columns of [ 2, 3, 4 ]) {
            for (const rows of [ 2, 3, 4 ]) {
                const f32ColumnAlignment = rows === 2 ? 8 : 16
                const f16ColumnAlignment = rows === 2 ? 4 : 8
                cases.push([
                    `mat${columns}x${rows}f`,
                    f32ColumnAlignment,
                    columns * f32ColumnAlignment,
                ])
                cases.push([
                    `mat${columns}x${rows}h`,
                    f16ColumnAlignment,
                    columns * f16ColumnAlignment,
                ])
            }
        }

        for (const [ type, alignment, byteLength ] of cases) {
            const codec = layoutCodec({ name: `Layout_${type}`, type })
            expect(codec.artifact).to.include({
                extent: 'fixed',
                alignment,
                byteLength,
                minimumBindingSize: byteLength,
            })
            expect(codec.artifact.type).to.include({
                alignment,
                byteLength,
            })
        }

        const canonical = layoutCodec({
            name: 'CanonicalVector',
            type: { kind: 'vector', component: 'f16', length: 3 },
        })
        const shorthand = layoutCodec({
            name: 'CanonicalVector',
            type: 'vec3h',
        })
        expect(canonical.artifact.abiHash).to.equal(shorthand.artifact.abiHash)
        expect(canonical.artifact.schemaHash).to.equal(shorthand.artifact.schemaHash)
    })

    it('encodes exact IEEE binary16 bytes and preserves column-major matrix padding', () => {

        const codec = layoutCodec({
            name: 'HalfData',
            fields: [
                { name: 'scalar', type: 'f16' },
                { name: 'vector', type: 'vec3h' },
                { name: 'matrix', type: 'mat2x3h' },
            ],
        })

        expect(codec.artifact.requiredDeviceFeatures).to.deep.equal([ 'shader-f16' ])
        expect(codec.artifact.fields.map(field => ({
            name: field.name,
            offset: field.offset,
            byteLength: field.byteLength,
            alignment: field.alignment,
        }))).to.deep.equal([
            { name: 'scalar', offset: 0, byteLength: 2, alignment: 2 },
            { name: 'vector', offset: 8, byteLength: 6, alignment: 8 },
            { name: 'matrix', offset: 16, byteLength: 16, alignment: 8 },
        ])

        const bytes = codec.pack({
            scalar: 1,
            vector: [ -2, 0.5, 0 ],
            matrix: [
                [ 1, 2, 3 ],
                [ 4, 5, 6 ],
            ],
        })
        expect(uint16At(bytes, 0)).to.equal(0x3c00)
        expect(uint16At(bytes, 8)).to.equal(0xc000)
        expect(uint16At(bytes, 10)).to.equal(0x3800)
        expect(uint16At(bytes, 16)).to.equal(0x3c00)
        expect(uint16At(bytes, 20)).to.equal(0x4200)
        expect(uint16At(bytes, 22)).to.equal(0)
        expect(uint16At(bytes, 24)).to.equal(0x4400)
        expect(uint16At(bytes, 28)).to.equal(0x4600)
        expect(uint16At(bytes, 30)).to.equal(0)

        expect(codec.createReadbackView(bytes).toObject()).to.deep.equal({
            scalar: 1,
            vector: [ -2, 0.5, 0 ],
            matrix: [
                [ 1, 2, 3 ],
                [ 4, 5, 6 ],
            ],
        })
    })

    it('rounds binary16 ties, subnormals, overflow, and special values exactly', () => {

        const codec = layoutCodec({
            name: 'HalfBoundaries',
            type: {
                kind: 'array',
                element: 'f16',
                count: 10,
            },
        })
        const bytes = codec.pack([
            -0,
            2 ** -24,
            2 ** -25,
            3 * 2 ** -25,
            1,
            1 + 2 ** -11,
            1 + 3 * 2 ** -11,
            65504,
            Infinity,
            NaN,
        ])
        expect(Array.from(
            { length: 10 },
            (_, index) => uint16At(bytes, index * 2)
        )).to.deep.equal([
            0x8000,
            0x0001,
            0x0000,
            0x0002,
            0x3c00,
            0x3c00,
            0x3c02,
            0x7bff,
            0x7c00,
            0x7e00,
        ])
        const values = codec.createReadbackView(bytes).toValue()
        expect(Object.is(values[0], -0)).to.equal(true)
        expect(values.slice(1, 9)).to.deep.equal([
            2 ** -24,
            0,
            2 ** -23,
            1,
            1,
            1 + 2 ** -9,
            65504,
            Infinity,
        ])
        expect(Number.isNaN(values[9])).to.equal(true)
    })

    it('packs nested structures, recursive arrays, and explicit member layout', () => {

        const inner = {
            kind: 'struct',
            name: 'Inner',
            fields: [
                { name: 'weight', type: 'f32' },
                { name: 'axis', type: 'vec2f' },
            ],
        }
        const codec = layoutCodec({
            name: 'Outer',
            fields: [
                { name: 'id', type: 'u32' },
                { name: 'primary', type: inner, align: 16, size: 32 },
                {
                    name: 'history',
                    type: {
                        kind: 'array',
                        element: inner,
                        count: 2,
                    },
                },
                { name: 'basis', type: 'mat3x2f' },
            ],
        })

        expect(codec.artifact).to.include({
            extent: 'fixed',
            alignment: 16,
            byteLength: 112,
            stride: 112,
        })
        expect(codec.artifact.fields.map(field => ({
            name: field.name,
            offset: field.offset,
            byteLength: field.byteLength,
            alignment: field.alignment,
            explicitAlign: field.explicitAlign,
            explicitSize: field.explicitSize,
        }))).to.deep.equal([
            {
                name: 'id',
                offset: 0,
                byteLength: 4,
                alignment: 4,
                explicitAlign: undefined,
                explicitSize: undefined,
            },
            {
                name: 'primary',
                offset: 16,
                byteLength: 32,
                alignment: 16,
                explicitAlign: 16,
                explicitSize: 32,
            },
            {
                name: 'history',
                offset: 48,
                byteLength: 32,
                alignment: 8,
                explicitAlign: undefined,
                explicitSize: undefined,
            },
            {
                name: 'basis',
                offset: 80,
                byteLength: 24,
                alignment: 8,
                explicitAlign: undefined,
                explicitSize: undefined,
            },
        ])

        const value = {
            id: 7,
            primary: { weight: 1, axis: [ 2, 3 ] },
            history: [
                { weight: 4, axis: [ 5, 6 ] },
                { weight: 7, axis: [ 8, 9 ] },
            ],
            basis: [
                [ 1, 2 ],
                [ 3, 4 ],
                [ 5, 6 ],
            ],
        }
        expect(codec.createReadbackView(codec.pack(value)).toObject()).to.deep.equal(value)
        const wgsl = codec.wgslAccessors({ namespace: 'OuterLayout' })
        expect(wgsl.indexOf('struct Inner {')).to.be.lessThan(wgsl.indexOf('struct Outer {'))
        expect(wgsl).to.include('@align(16) @size(32) primary: Inner,')
        expect(wgsl).to.include('history: array<Inner, 2>,')
    })

    it('distinguishes runtime-tailed artifacts and derives binding counts from exact extents', async () => {

        const codec = layoutCodec({
            name: 'ParticleStore',
            fields: [
                { name: 'declaredCount', type: 'u32' },
                {
                    name: 'particles',
                    type: {
                        kind: 'runtime-array',
                        element: {
                            kind: 'struct',
                            name: 'ParticleRecord',
                            fields: [
                                { name: 'position', type: 'vec3f' },
                                { name: 'mass', type: 'f32' },
                            ],
                        },
                    },
                },
            ],
        }, {
            usage: [ 'storage', 'readback' ],
        })

        expect(codec.artifact).to.include({
            extent: 'runtime',
            alignment: 16,
            fixedPrefixByteLength: 16,
            minimumBindingSize: 32,
        })
        expect(codec.artifact).to.not.have.property('byteLength')
        expect(codec.artifact).to.not.have.property('stride')
        expect(codec.artifact.runtimeTail).to.deep.include({
            path: 'particles',
            offset: 16,
            elementStride: 16,
        })
        expect(codec.byteLength({ runtimeElementCount: 2 })).to.equal(48)

        const value = {
            declaredCount: 2,
            particles: [
                { position: [ 1, 2, 3 ], mass: 4 },
                { position: [ 5, 6, 7 ], mass: 8 },
            ],
        }
        const bytes = codec.pack(value, { runtimeElementCount: 2 })
        const readback = codec.createReadbackView(bytes)
        expect(readback.count).to.equal(1)
        expect(readback.runtimeElementCount).to.equal(2)
        expect(readback.toObject()).to.deep.equal(value)

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 64,
            usage: 0x80,
        })
        const region = buffer.region({
            size: 49,
            layout: codec.artifact,
        })
        expect(region.elementCount).to.equal(2)
        expect(region.runtimeElementCount).to.equal(2)

        expectLayoutDiagnostic(
            () => codec.pack(value, { runtimeElementCount: 1 }),
            'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID',
            'particles'
        )
        runtime.dispose()
    })

    it('keeps atomics storage-only and generates only atomic access helpers', () => {

        const codec = layoutCodec({
            name: 'AtomicCounters',
            fields: [
                { name: 'generation', type: 'u32' },
                {
                    name: 'counts',
                    type: {
                        kind: 'array',
                        element: { kind: 'atomic', component: 'u32' },
                        count: 2,
                    },
                },
            ],
        })

        expect(codec.artifact.type).to.include({
            constructible: false,
            containsAtomic: true,
        })
        expect(codec.artifact.usageCompatibility.uniform.compatible).to.equal(false)
        expect(codec.artifact.usageCompatibility.immediate.compatible).to.equal(false)
        expect(codec.artifact.usageCompatibility.storage).to.include({
            compatible: true,
            requiresMutableStorage: true,
        })

        const bytes = codec.pack({
            generation: 4,
            counts: [ 5, 6 ],
        })
        expect(codec.createReadbackView(bytes).toObject()).to.deep.equal({
            generation: 4,
            counts: [ 5, 6 ],
        })
        const wgsl = codec.wgslAccessors({ namespace: 'CountersLayout' })
        expect(wgsl).to.include('atomicLoad(')
        expect(wgsl).to.include('atomicStore(')
        expect(wgsl).to.include(
            'fn CountersLayout_readGeneration(value: ptr<storage, AtomicCounters, read_write>) -> u32'
        )
        expect(wgsl).to.not.include(
            'fn CountersLayout_readCounts(value: AtomicCounters) -> array<atomic<u32>, 2>'
        )

        const nested = layoutCodec({
            name: 'NestedAtomicCounters',
            fields: [
                {
                    name: 'buckets',
                    type: {
                        kind: 'array',
                        count: 2,
                        element: {
                            kind: 'struct',
                            name: 'AtomicBucket',
                            fields: [
                                {
                                    name: 'counts',
                                    type: {
                                        kind: 'array',
                                        count: 3,
                                        element: {
                                            kind: 'atomic',
                                            component: 'u32',
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        })
        const nestedWgsl = nested.wgslAccessors({
            namespace: 'NestedCountersLayout',
        })
        expect(nestedWgsl).to.include(
            'atomicLoad(&(*value).buckets[index0].counts[index1])'
        )
        expect(nestedWgsl).to.include(
            'atomicStore(&(*value).buckets[index0].counts[index1], next)'
        )
    })

    it('models portable and uniform_buffer_standard_layout contracts separately', () => {

        const spec = {
            name: 'ScalarArray',
            fields: [
                {
                    name: 'values',
                    type: { kind: 'array', element: 'u32', count: 4 },
                },
            ],
        }
        const portable = layoutCodec(spec)
        const standard = layoutCodec(spec, {
            uniformLayout: 'uniform_buffer_standard_layout',
        })

        expect(portable.artifact.capabilityContract).to.deep.equal({
            uniformLayout: 'portable',
        })
        expect(portable.artifact.usageCompatibility.uniform).to.include({
            compatible: false,
        })
        expect(standard.artifact.capabilityContract).to.deep.equal({
            uniformLayout: 'uniform_buffer_standard_layout',
        })
        expect(standard.artifact.usageCompatibility.uniform).to.deep.include({
            compatible: true,
            requiredLanguageFeatures: [ 'uniform_buffer_standard_layout' ],
        })
        expect(standard.artifact.abiHash).to.not.equal(portable.artifact.abiHash)
        expect(standard.artifact.schemaHash).to.not.equal(portable.artifact.schemaHash)

        const portableWrapper = layoutCodec({
            name: 'PortableArray',
            fields: [
                {
                    name: 'values',
                    type: {
                        kind: 'array',
                        element: {
                            kind: 'struct',
                            name: 'AlignedU32',
                            fields: [
                                { name: 'value', type: 'u32', size: 16 },
                            ],
                        },
                        count: 4,
                    },
                },
            ],
        })
        expect(portableWrapper.artifact.usageCompatibility.uniform.compatible).to.equal(true)
    })

    it('models fixed and runtime buffer types with explicit buffer-view contracts', () => {

        const fixed = layoutCodec({
            name: 'FixedRaw',
            type: {
                kind: 'buffer',
                byteLength: 128,
            },
        })
        const runtime = layoutCodec({
            name: 'RuntimeRaw',
            type: {
                kind: 'buffer',
            },
        })
        const runtimeTarget = layoutCodec({
            name: 'RuntimeValues',
            type: {
                kind: 'runtime-array',
                element: 'vec4u',
            },
        })
        const fixedParameter = layoutCodec({
            name: 'FixedRawParameter',
            type: {
                kind: 'buffer',
                byteLength: 64,
            },
        })

        expect(fixed.artifact).to.include({
            extent: 'fixed',
            alignment: null,
            byteLength: 128,
            minimumBindingSize: 128,
        })
        expect(runtime.artifact).to.include({
            extent: 'runtime',
            alignment: null,
            fixedPrefixByteLength: 0,
            minimumBindingSize: 0,
        })
        expect(runtime.artifact.requiredLanguageFeatures).to.deep.equal([ 'buffer_view' ])

        const remaining = runtime.bufferView({
            kind: 'bufferView',
            target: runtimeTarget.artifact,
            addressSpace: 'storage',
            accessMode: 'read',
            byteOffset: 16,
        })
        expect(remaining).to.deep.include({
            kind: 'LayoutBufferViewContract',
            nativeBuiltin: 'bufferView',
            addressSpace: 'storage',
            accessMode: 'read',
            byteOffset: 16,
            requiredAlignment: 16,
            minimumTypeSize: 16,
            arrayOffset: 0,
            arrayStride: 16,
        })
        expect(remaining.requiredLanguageFeatures).to.deep.equal([ 'buffer_view' ])

        const bounded = fixed.bufferView({
            kind: 'bufferArrayView',
            target: runtimeTarget.artifact,
            addressSpace: 'storage',
            accessMode: 'read',
            byteOffset: 16,
            byteLength: 32,
            pointerPath: 'function-parameter',
            parameterBuffers: [ fixedParameter.artifact ],
        })
        expect(bounded).to.deep.include({
            nativeBuiltin: 'bufferArrayView',
            byteOffset: 16,
            byteLength: 32,
            staticBufferByteLength: 64,
        })
        expect(bounded.requiredLanguageFeatures).to.deep.equal([
            'buffer_view',
            'unrestricted_pointer_parameters',
        ])
        const boundedConstants = fixed.wgslBufferViewConstants(bounded, {
            namespace: 'BoundedRawView',
        })
        expect(boundedConstants).to.include(
            'const BoundedRawView_STATIC_BUFFER_LENGTH: u32 = 64u;'
        )

        const narrowedLength = fixed.bufferView({
            kind: 'bufferLength',
            addressSpace: 'storage',
            accessMode: 'read',
            pointerPath: 'function-parameter',
            parameterBuffers: [
                fixedParameter.artifact,
                runtime.artifact,
            ],
        })
        expect(narrowedLength).to.deep.include({
            nativeBuiltin: 'bufferLength',
            staticBufferByteLength: 64,
        })

        const length = runtime.bufferView({
            kind: 'bufferLength',
            addressSpace: 'storage',
            accessMode: 'read',
        })
        expect(length).to.deep.include({
            nativeBuiltin: 'bufferLength',
            minimumTypeSize: 0,
        })
        const constants = runtime.wgslBufferViewConstants(remaining, {
            namespace: 'RuntimeRawView',
        })
        expect(constants).to.include('const RuntimeRawView_REQUIRED_ALIGNMENT: u32 = 16u;')
        expect(constants).to.not.include('bufferView(')

        const workgroupLength = fixed.bufferView({
            kind: 'bufferLength',
            addressSpace: 'workgroup',
            accessMode: 'read_write',
        })
        expect(workgroupLength).to.deep.include({
            addressSpace: 'workgroup',
            accessMode: 'read_write',
        })
    })

    it('rejects invalid recursive, member-layout, and buffer-view combinations by path', () => {

        const invalidTypes = [ 'bool', 'abstract-int', 'ptr<storage, u32>', 'texture_2d<f32>' ]
        for (const type of invalidTypes) {
            expectLayoutDiagnostic(
                () => layoutCodec({
                    name: 'InvalidType',
                    fields: [ { name: 'value', type } ],
                }),
                'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
                'value'
            )
        }

        expectLayoutDiagnostic(
            () => layoutCodec({
                name: 'InvalidAlign',
                fields: [ { name: 'value', type: 'vec4f', align: 8 } ],
            }),
            'SCRATCH_LAYOUT_MEMBER_ATTRIBUTE_INVALID',
            'value'
        )
        expectLayoutDiagnostic(
            () => layoutCodec({
                name: 'InvalidSize',
                fields: [ { name: 'value', type: 'vec4f', size: 8 } ],
            }),
            'SCRATCH_LAYOUT_MEMBER_ATTRIBUTE_INVALID',
            'value'
        )
        expectLayoutDiagnostic(
            () => layoutCodec({
                name: 'InvalidRuntimeMember',
                fields: [
                    {
                        name: 'values',
                        type: { kind: 'runtime-array', element: 'u32' },
                    },
                    { name: 'tail', type: 'u32' },
                ],
            }),
            'SCRATCH_LAYOUT_RUNTIME_ARRAY_INVALID',
            'values'
        )
        expectLayoutDiagnostic(
            () => layoutCodec({
                name: 'InvalidNestedBuffer',
                fields: [
                    {
                        name: 'bytes',
                        type: { kind: 'buffer', byteLength: 16 },
                    },
                ],
            }),
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            'bytes'
        )
        expectLayoutDiagnostic(
            () => layoutCodec({
                name: 'OversizedBuffer',
                type: {
                    kind: 'buffer',
                    byteLength: 0x1_0000_0000,
                },
            }),
            'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            'OversizedBuffer'
        )

        const raw = layoutCodec({
            name: 'Raw',
            type: { kind: 'buffer', byteLength: 64 },
        })
        const target = layoutCodec({
            name: 'Target',
            type: { kind: 'runtime-array', element: 'vec4u' },
        })
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferView',
                target: target.artifact,
                addressSpace: 'storage',
                accessMode: 'read',
                byteOffset: 4,
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferArrayView',
                target: target.artifact,
                addressSpace: 'storage',
                accessMode: 'read',
                byteOffset: 80,
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferArrayView',
                target: target.artifact,
                addressSpace: 'storage',
                accessMode: 'read',
                byteLength: 80,
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferLength',
                addressSpace: 'workgroup',
                accessMode: 'read',
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        const runtimeRaw = layoutCodec({
            name: 'RuntimeOnlyStorage',
            type: { kind: 'buffer' },
        })
        expectLayoutDiagnostic(
            () => runtimeRaw.bufferView({
                kind: 'bufferLength',
                addressSpace: 'uniform',
                accessMode: 'read',
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        const widerParameter = layoutCodec({
            name: 'WiderParameter',
            type: { kind: 'buffer', byteLength: 128 },
        })
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferLength',
                addressSpace: 'storage',
                accessMode: 'read',
                pointerPath: 'function-parameter',
                parameterBuffers: [ widerParameter.artifact ],
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferLength',
                addressSpace: 'storage',
                accessMode: 'read',
                pointerPath: 'function-parameter',
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferArrayView',
                target: target.artifact,
                addressSpace: 'storage',
                accessMode: 'read',
                byteOffset: 16,
                byteLength: 31,
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )

        const atomic = layoutCodec({
            name: 'AtomicTarget',
            fields: [
                { name: 'value', type: { kind: 'atomic', component: 'u32' } },
            ],
        })
        expectLayoutDiagnostic(
            () => raw.bufferView({
                kind: 'bufferView',
                target: atomic.artifact,
                addressSpace: 'storage',
                accessMode: 'read_write',
            }),
            'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
        )

        const integerVector = layoutCodec({
            name: 'IntegerVector',
            type: 'vec2u',
        })
        expectLayoutDiagnostic(
            () => integerVector.pack([ 1.5, 2 ]),
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            'IntegerVector[0]'
        )
        expectLayoutDiagnostic(
            () => integerVector.pack([ 0x1_0000_0000, 2 ]),
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            'IntegerVector[0]'
        )
    })
})
