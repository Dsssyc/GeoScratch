import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeCanvas, createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_UNIFORM = 0x40
const GPU_BUFFER_USAGE_STORAGE = 0x80

const renderWgsl = `
@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(0.0, 0.5),
        vec2f(-0.5, -0.5),
        vec2f(0.5, -0.5)
    );
    let p = positions[vertexIndex];
    return vec4f(p, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(1.0, 1.0, 1.0, 1.0);
}
`

const computeWgsl = `
@compute @workgroup_size(1)
fn csMain() {
}
`

function dynamicUniformEntry(overrides = {}) {

    return {
        binding: 0,
        name: 'uniforms',
        type: 'uniform',
        visibility: [ 'vertex', 'fragment' ],
        hasDynamicOffset: true,
        ...overrides,
    }
}

function dynamicReadStorageEntry(overrides = {}) {

    return {
        binding: 0,
        name: 'inputValues',
        type: 'read-storage',
        visibility: [ 'compute' ],
        hasDynamicOffset: true,
        ...overrides,
    }
}

function dynamicStorageEntry(overrides = {}) {

    return {
        binding: 1,
        name: 'outputValues',
        type: 'storage',
        visibility: [ 'compute' ],
        hasDynamicOffset: true,
        ...overrides,
    }
}

function expectDiagnostic(fn, include) {

    let caught
    try {
        fn()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include(include)
    expect(caught.diagnostic.expected).to.not.equal(undefined)
    expect(caught.diagnostic.actual).to.not.equal(undefined)

    return caught.diagnostic
}

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

async function createBufferForEntry(runtime, entry, index = 0) {

    return await runtime.createBuffer({
        label: `${entry.name} buffer`,
        size: 2048,
        usage: GPU_BUFFER_USAGE_COPY_DST |
            (entry.type === 'uniform' ? GPU_BUFFER_USAGE_UNIFORM : GPU_BUFFER_USAGE_STORAGE),
    })
}

async function createBufferBindings(runtime, entries) {

    const bindings = {}
    const buffers = await Promise.all(entries.map((entry, index) =>
        createBufferForEntry(runtime, entry, index)
    ))

    entries.forEach((entry, index) => {
        const buffer = buffers[index]
        bindings[entry.name] = buffer
    })

    return { bindings, buffers }
}

function createUploads(runtime, buffers) {

    return buffers.map((buffer, index) => runtime.createUploadCommand({
        label: `upload ${index}`,
        target: buffer,
        data: new Uint8Array(16),
        offset: 0,
    }))
}

async function createRenderFixture(entries = [ dynamicUniformEntry() ]) {

    const fixture = await createRuntimeFixture()
    const canvas = createFakeCanvas()
    const surface = fixture.runtime.createSurface(canvas.canvas, {
        format: 'bgra8unorm',
        size: { width: 2, height: 2 },
    })
    const bindLayout = fixture.runtime.createBindLayout({
        label: 'dynamic render bind layout',
        group: 0,
        entries,
    })
    const { bindings, buffers } = await createBufferBindings(fixture.runtime, entries)
    const bindSet = fixture.runtime.createBindSet(bindLayout, bindings, {
        label: 'dynamic render bind set',
    })
    const program = fixture.runtime.createProgram({
        modules: [ renderWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await fixture.runtime.createRenderPipeline({
        label: 'dynamic render pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const pass = fixture.runtime.createRenderPass({
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })

    return {
        ...fixture,
        ...canvas,
        surface,
        bindLayout,
        bindSet,
        buffers,
        uploads: createUploads(fixture.runtime, buffers),
        program,
        pipeline,
        pass,
    }
}

async function createComputeFixture(entries = [ dynamicReadStorageEntry(), dynamicStorageEntry() ]) {

    const fixture = await createRuntimeFixture()
    const bindLayout = fixture.runtime.createBindLayout({
        label: 'dynamic compute bind layout',
        group: 1,
        entries,
    })
    const { bindings, buffers } = await createBufferBindings(fixture.runtime, entries)
    const bindSet = fixture.runtime.createBindSet(bindLayout, bindings, {
        label: 'dynamic compute bind set',
    })
    const program = fixture.runtime.createProgram({
        modules: [ computeWgsl ],
        entryPoints: {
            compute: 'csMain',
        },
    })
    const pipeline = await fixture.runtime.createComputePipeline({
        label: 'dynamic compute pipeline',
        program,
        bindLayouts: [ bindLayout ],
    })
    const pass = fixture.runtime.createComputePass({
        label: 'dynamic compute pass',
    })

    return {
        ...fixture,
        bindLayout,
        bindSet,
        buffers,
        uploads: createUploads(fixture.runtime, buffers),
        program,
        pipeline,
        pass,
    }
}

function createDrawCommand(fixture, overrides = {}) {

    return fixture.runtime.createDrawCommand({
        pipeline: fixture.pipeline,
        bindSets: [ fixture.bindSet ],
        count: { vertexCount: 3 },
        resources: {
            read: fixture.buffers.map(buffer => readResource(buffer, 1)),
            write: [],
        },
        whenMissing: 'throw',
        ...overrides,
    })
}

function createDispatchCommand(fixture, overrides = {}) {

    return fixture.runtime.createDispatchCommand({
        pipeline: fixture.pipeline,
        bindSets: [ fixture.bindSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ readResource(fixture.buffers[0], 1) ],
            write: [ fixture.buffers[fixture.buffers.length - 1] ],
        },
        whenMissing: 'throw',
        ...overrides,
    })
}

function submitRender(fixture, commands) {

    const builder = fixture.runtime.createSubmission({ validation: 'throw' })
    for (const upload of fixture.uploads) builder.upload(upload)

    return builder.render(fixture.pass, commands).submit()
}

function submitCompute(fixture, commands) {

    const builder = fixture.runtime.createSubmission({ validation: 'throw' })
    for (const upload of fixture.uploads) builder.upload(upload)

    return builder.compute(fixture.pass, commands).submit()
}

describe('scratch dynamic buffer bind offsets', () => {

    it('accepts dynamic uniform buffer entries', async() => {

        const fixture = await createRuntimeFixture()
        const bindLayout = fixture.runtime.createBindLayout({
            group: 0,
            entries: [ dynamicUniformEntry() ],
        })

        expect(bindLayout.entries).to.deep.equal([
            dynamicUniformEntry(),
        ])
    })

    it('accepts dynamic read-storage and storage buffer entries', async() => {

        const fixture = await createRuntimeFixture()
        const entries = [ dynamicReadStorageEntry(), dynamicStorageEntry() ]
        const bindLayout = fixture.runtime.createBindLayout({
            group: 1,
            entries,
        })

        expect(bindLayout.entries).to.deep.equal(entries)
    })

    it('lowers dynamic buffer entries to WebGPU descriptors', async() => {

        const fixture = await createRuntimeFixture()
        fixture.runtime.createBindLayout({
            label: 'dynamic offsets layout',
            group: 1,
            entries: [
                dynamicReadStorageEntry(),
                dynamicStorageEntry(),
            ],
        })

        expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
            label: 'dynamic offsets layout',
            entries: [
                {
                    binding: 0,
                    visibility: 4,
                    buffer: { type: 'read-only-storage', hasDynamicOffset: true },
                },
                {
                    binding: 1,
                    visibility: 4,
                    buffer: { type: 'storage', hasDynamicOffset: true },
                },
            ],
        })
    })

    it('preserves non-dynamic descriptor output shape', async() => {

        const fixture = await createRuntimeFixture()
        const bindLayout = fixture.runtime.createBindLayout({
            label: 'plain uniforms layout',
            group: 0,
            entries: [
                {
                    binding: 0,
                    name: 'uniforms',
                    type: 'uniform',
                    visibility: [ 'vertex', 'fragment' ],
                },
            ],
        })

        expect(bindLayout.entries).to.deep.equal([
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ])
        expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
            label: 'plain uniforms layout',
            entries: [
                {
                    binding: 0,
                    visibility: 3,
                    buffer: { type: 'uniform' },
                },
            ],
        })
    })

    it('rejects dynamic offset flags on texture and sampler entries', async() => {

        const fixture = await createRuntimeFixture()
        const cases = [
            {
                binding: 0,
                name: 'image',
                type: 'texture',
                visibility: [ 'fragment' ],
                hasDynamicOffset: true,
            },
            {
                binding: 1,
                name: 'sampler',
                type: 'sampler',
                visibility: [ 'fragment' ],
                hasDynamicOffset: true,
            },
        ]

        for (const entry of cases) {
            const diagnostic = expectDiagnostic(() => {
                fixture.runtime.createBindLayout({
                    group: 0,
                    entries: [ entry ],
                })
            }, {
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
                severity: 'error',
                phase: 'binding',
            })

            expect(diagnostic.subject).to.deep.equal({
                kind: 'BindLayoutEntry',
                group: 0,
                binding: entry.binding,
                name: entry.name,
            })
            expect(diagnostic.actual).to.deep.include({
                type: entry.type,
                hasDynamicOffset: true,
            })
        }
    })

    it('passes draw dynamic offsets to render pass setBindGroup', async() => {

        const fixture = await createRenderFixture()
        const draw = createDrawCommand(fixture, {
            dynamicOffsets: { 0: [ 256 ] },
        })
        const submitted = submitRender(fixture, [ draw ])

        expect(fixture.calls.renderPasses[0].actions).to.deep.include({
            type: 'setBindGroup',
            group: 0,
            bindGroup: fixture.bindSet.getBindGroup(),
            dynamicOffsets: [ 256 ],
        })

        await submitted.done
    })

    it('passes dispatch dynamic offsets to compute pass setBindGroup', async() => {

        const fixture = await createComputeFixture()
        const dispatch = createDispatchCommand(fixture, {
            dynamicOffsets: { 1: [ 256, 512 ] },
        })
        const submitted = submitCompute(fixture, [ dispatch ])

        expect(fixture.calls.computePasses[0].actions).to.deep.include({
            type: 'setBindGroup',
            group: 1,
            bindGroup: fixture.bindSet.getBindGroup(),
            dynamicOffsets: [ 256, 512 ],
        })

        await submitted.done
    })

    it('interprets dynamic offsets by bind entry index order', async() => {

        const entries = [
            dynamicUniformEntry({
                binding: 2,
                name: 'uniforms',
                visibility: [ 'vertex' ],
            }),
            dynamicReadStorageEntry({
                binding: 0,
                name: 'inputValues',
                visibility: [ 'vertex' ],
            }),
        ]
        const fixture = await createRenderFixture(entries)
        fixture.device.limits.minStorageBufferOffsetAlignment = 128
        const draw = createDrawCommand(fixture, {
            dynamicOffsets: { 0: [ 128, 256 ] },
        })
        const submitted = submitRender(fixture, [ draw ])

        expect(fixture.calls.renderPasses[0].actions).to.deep.include({
            type: 'setBindGroup',
            group: 0,
            bindGroup: fixture.bindSet.getBindGroup(),
            dynamicOffsets: [ 128, 256 ],
        })

        await submitted.done
    })

    it('rejects missing dynamic offsets with structured diagnostics', async() => {

        const fixture = await createRenderFixture()
        const diagnostic = expectDiagnostic(() => {
            createDrawCommand(fixture)
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_MISSING',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 0,
            binding: 0,
            name: 'uniforms',
        })
        expect(diagnostic.related.map(subject => subject.kind)).to.include.members([ 'Command', 'BindSet', 'BindLayout' ])
        expect(diagnostic.expected).to.deep.equal({
            group: 0,
            count: 1,
            bindings: [ 0 ],
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 0,
            offsets: undefined,
        })
    })

    it('rejects extra dynamic offsets for a non-dynamic bind set', async() => {

        const fixture = await createRenderFixture([
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ])
        const diagnostic = expectDiagnostic(() => {
            createDrawCommand(fixture, {
                dynamicOffsets: { 0: [ 0 ] },
            })
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal(fixture.bindSet.subject)
        expect(diagnostic.expected).to.deep.equal({
            group: 0,
            count: 0,
            bindings: [],
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 0,
            count: 1,
            offsets: [ 0 ],
        })
    })

    it('rejects dynamic offsets for a bind group not used by the command', async() => {

        const fixture = await createRenderFixture()
        const diagnostic = expectDiagnostic(() => {
            createDrawCommand(fixture, {
                dynamicOffsets: {
                    0: [ 256 ],
                    2: [ 256 ],
                },
            })
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            ...fixture.pipeline.subject,
        })
        expect(diagnostic.expected).to.deep.equal({
            groups: [ 0 ],
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 2,
        })
    })

    it('rejects wrong dynamic offset counts with structured diagnostics', async() => {

        const fixture = await createComputeFixture()
        const diagnostic = expectDiagnostic(() => {
            createDispatchCommand(fixture, {
                dynamicOffsets: { 1: [ 256 ] },
            })
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 1,
            binding: 0,
            name: 'inputValues',
        })
        expect(diagnostic.expected).to.deep.equal({
            group: 1,
            count: 2,
            bindings: [ 0, 1 ],
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 1,
            count: 1,
            offsets: [ 256 ],
        })
    })

    it('rejects negative, fractional, and non-number dynamic offsets', async() => {

        const cases = [ -1, 1.5, '256' ]
        for (const offset of cases) {
            const fixture = await createRenderFixture()
            const diagnostic = expectDiagnostic(() => {
                createDrawCommand(fixture, {
                    dynamicOffsets: { 0: [ offset ] },
                })
            }, {
                code: 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID',
                severity: 'error',
                phase: 'binding',
            })

            expect(diagnostic.subject).to.deep.equal({
                kind: 'BindLayoutEntry',
                group: 0,
                binding: 0,
                name: 'uniforms',
            })
            expect(diagnostic.expected).to.deep.equal({
                offset: 'non-negative integer',
            })
            expect(diagnostic.actual).to.deep.equal({
                group: 0,
                binding: 0,
                index: 0,
                offset,
            })
        }
    })

    it('validates uniform dynamic offset alignment', async() => {

        const fixture = await createRenderFixture()
        const diagnostic = expectDiagnostic(() => {
            createDrawCommand(fixture, {
                dynamicOffsets: { 0: [ 128 ] },
            })
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_UNALIGNED',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 0,
            binding: 0,
            name: 'uniforms',
        })
        expect(diagnostic.expected).to.deep.equal({
            alignment: 256,
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 0,
            binding: 0,
            index: 0,
            offset: 128,
        })
    })

    it('validates storage dynamic offset alignment', async() => {

        const fixture = await createComputeFixture()
        const diagnostic = expectDiagnostic(() => {
            createDispatchCommand(fixture, {
                dynamicOffsets: { 1: [ 128, 256 ] },
            })
        }, {
            code: 'SCRATCH_BIND_DYNAMIC_OFFSET_UNALIGNED',
            severity: 'error',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 1,
            binding: 0,
            name: 'inputValues',
        })
        expect(diagnostic.expected).to.deep.equal({
            alignment: 256,
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 1,
            binding: 0,
            index: 0,
            offset: 128,
        })
    })

    it('does not rebuild bind groups when only dynamic offsets differ', async() => {

        const fixture = await createRenderFixture()
        const firstDraw = createDrawCommand(fixture, {
            dynamicOffsets: { 0: [ 256 ] },
        })
        const secondDraw = createDrawCommand(fixture, {
            dynamicOffsets: { 0: [ 512 ] },
        })
        const submitted = submitRender(fixture, [ firstDraw, secondDraw ])
        const bindActions = fixture.calls.renderPasses[0].actions
            .filter(action => action.type === 'setBindGroup')

        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(bindActions).to.deep.equal([
            {
                type: 'setBindGroup',
                group: 0,
                bindGroup: fixture.bindSet.getBindGroup(),
                dynamicOffsets: [ 256 ],
            },
            {
                type: 'setBindGroup',
                group: 0,
                bindGroup: fixture.bindSet.getBindGroup(),
                dynamicOffsets: [ 512 ],
            },
        ])

        await submitted.done
    })
})
