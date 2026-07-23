import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    DrawCommand,
    DispatchCommand,
    Program,
    ScratchComputePipeline,
    ScratchDiagnosticError,
    ScratchRenderPipeline,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80

const renderWgsl = `
@vertex
fn vsMain() -> @builtin(position) vec4f {
    return vec4f(0.0, 0.0, 0.0, 1.0);
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

function createParticleCodec(name = 'Particle') {

    return layoutCodec({
        label: `${name} buffer`,
        name,
        fields: [
            { name: 'position', type: 'vec3f' },
            { name: 'mass', type: 'f32' },
        ],
    }, {
        usage: [ 'storage', 'readback' ],
    })
}

function createAbiMismatchCodec(name = 'WideParticle') {

    return layoutCodec({
        label: `${name} buffer`,
        name,
        fields: [
            { name: 'position', type: 'vec4f' },
            { name: 'mass', type: 'f32' },
        ],
    }, {
        usage: [ 'storage', 'readback' ],
    })
}

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

function createRequirement(codec, overrides = {}) {

    return {
        group: 0,
        binding: 0,
        name: 'particles',
        type: 'storage',
        visibility: [ 'compute' ],
        hasDynamicOffset: false,
        layout: codec.artifact,
        ...overrides,
    }
}

async function createProgram(runtime, codec, overrides = {}) {

    return await createTestProgram(runtime, {
        label: 'particle program',
        sourceParts: [ computeWgsl ],
        compute: 'csMain',
        layoutRequirements: [ createRequirement(codec, overrides) ],
    })
}

async function createRenderProgram(runtime, codec, overrides = {}) {

    return await createTestProgram(runtime, {
        label: 'particle render program',
        sourceParts: [ renderWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
        layoutRequirements: [
        createRequirement(codec, {
        type: 'read-storage',
        visibility: [ 'vertex' ],
        ...overrides,
        }),
        ],
    })
}

function createBindLayout(runtime, overrides = {}) {

    const visibility = overrides.visibility ?? [ 'compute' ]
    const type = overrides.type ?? (visibility.includes('vertex') ? 'read-storage' : 'storage')
    return runtime.createBindLayout({
        label: 'particle bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'particles',
                type,
                visibility,
                ...overrides,
            },
        ],
    })
}

async function createLayoutBuffer(runtime, codec) {

    const buffer = await runtime.createBuffer({
        label: 'particles',
        size: codec.artifact.stride * 2,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })

    return buffer.region({ layout: codec.artifact })
}

async function createRawBuffer(runtime, size = 32) {

    const buffer = await runtime.createBuffer({
        label: 'raw bytes',
        size,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })

    return buffer.region()
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

    return caught.diagnostic
}

function expectProgramLayoutDiagnostic(fn) {

    return expectDiagnostic(fn, {
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
    })
}

async function expectAsyncProgramLayoutDiagnostic(fn) {

    let caught
    try {
        await fn()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include({
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
    })
    return caught.diagnostic
}

describe('scratch Program buffer layout requirements', () => {

    it('accepts and exposes normalized buffer layout requirements', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const program = await createProgram(runtime, codec)

        expect(program).to.be.instanceOf(Program)
        expect(program.layoutRequirements).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'particles',
                type: 'storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: false,
                layout: codec.artifact,
            },
        ])
        expect(Object.isFrozen(program.layoutRequirements)).to.equal(true)
        expect(Object.isFrozen(program.layoutRequirements[0])).to.equal(true)
        expect(Object.isFrozen(program.layoutRequirements[0].visibility)).to.equal(true)
        expect(program.bindSets).to.equal(undefined)
        expect(program.resources).to.equal(undefined)
        expect(program.drawCount).to.equal(undefined)
        expect(program.dispatchCount).to.equal(undefined)
    })

    it('keeps programs without layout requirements valid', async() => {

        const { runtime } = await createRuntimeFixture()
        const program = await createTestProgram(runtime, {
            sourceParts: [ computeWgsl ],
            compute: 'csMain',
        })

        expect(program.layoutRequirements).to.deep.equal([])
    })

    it('rejects invalid requirement layouts with structured diagnostics', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()

        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async () => {
            await createProgram(runtime, codec, {
                layout: {
                    kind: 'LayoutArtifact',
                    name: 'Broken',
                    fields: [],
                },
            })
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'ShaderBinding',
            group: 0,
            binding: 0,
            name: 'particles',
            stage: 'buffer',
        })
        expect(diagnostic.expected).to.deep.equal({ layout: 'LayoutArtifact' })
        expect(diagnostic.actual).to.deep.equal({ layout: 'object' })
    })

    it('rejects invalid group, binding, type, and visibility descriptors', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const cases = [
            {
                overrides: { group: -1 },
                expected: { group: 'non-negative integer' },
                actual: { group: -1 },
            },
            {
                overrides: { binding: -1 },
                expected: { binding: 'non-negative integer' },
                actual: { binding: -1 },
            },
            {
                overrides: { type: 'texture' },
                expected: { type: [ 'uniform', 'read-storage', 'storage' ] },
                actual: { type: 'texture' },
            },
            {
                overrides: { visibility: [] },
                expected: { visibility: 'non-empty stage array' },
                actual: { visibility: [] },
            },
            {
                overrides: { visibility: [ 'compute', 'task' ] },
                expected: { visibility: [ 'vertex', 'fragment', 'compute' ] },
                actual: { visibility: [ 'compute', 'task' ] },
            },
            {
                overrides: { hasDynamicOffset: undefined },
                expected: { hasDynamicOffset: 'boolean' },
                actual: { hasDynamicOffset: undefined },
            },
            {
                overrides: { hasDynamicOffset: 0 },
                expected: { hasDynamicOffset: 'boolean' },
                actual: { hasDynamicOffset: 0 },
            },
        ]

        for (const testCase of cases) {
            const diagnostic = await expectAsyncProgramLayoutDiagnostic(async () => {
                await createProgram(runtime, codec, testCase.overrides)
            })
            expect(diagnostic.expected).to.deep.equal(testCase.expected)
            expect(diagnostic.actual).to.deep.equal(testCase.actual)
        }
    })

    it('rejects duplicate group and binding requirements', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()

        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async () => {
            await createTestProgram(runtime, {
                sourceParts: [ computeWgsl ],
                compute: 'csMain',
                layoutRequirements: [
                createRequirement(codec),
                createRequirement(codec, { name: 'duplicateParticles' }),
                ],
            })
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'ShaderBinding',
            group: 0,
            binding: 0,
            name: 'duplicateParticles',
            stage: 'buffer',
        })
        expect(diagnostic.expected).to.deep.equal({ unique: [ 'group', 'binding' ] })
        expect(diagnostic.actual).to.deep.equal({ group: 0, binding: 0 })
    })

    it('accepts matching render and compute pipeline bind layouts', async() => {

        const { runtime } = await createRuntimeFixture()
        const renderCodec = createParticleCodec('RenderParticle')
        const computeCodec = createParticleCodec('ComputeParticle')
        const renderProgram = await createRenderProgram(runtime, renderCodec)
        const computeProgram = await createProgram(runtime, computeCodec)
        const renderLayout = await createBindLayout(runtime, {
            visibility: [ 'vertex', 'fragment' ],
        })
        const computeLayout = await createBindLayout(runtime, {
            visibility: [ 'compute' ],
        })

        const renderPipeline = await runtime.createRenderPipeline({
            program: renderProgram,
            layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePipeline = await runtime.createComputePipeline({
            program: computeProgram,
            layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        })

        expect(renderPipeline).to.be.instanceOf(ScratchRenderPipeline)
        expect(computePipeline).to.be.instanceOf(ScratchComputePipeline)
    })

    it('rejects pipeline creation when a required bind layout group is missing', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const program = await createProgram(runtime, codec)

        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async() => {
            await runtime.createComputePipeline({
                program,
                layout: { mode: 'explicit', bindLayouts: [] },
            })
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'ShaderBinding',
            group: 0,
            binding: 0,
            name: 'particles',
            stage: 'buffer',
        })
        expect(diagnostic.expected).to.deep.equal({
            group: 0,
            binding: 0,
            name: 'particles',
            type: 'storage',
            visibility: [ 'compute' ],
            hasDynamicOffset: false,
            abiByteLength: codec.artifact.byteLength,
            minBindingSize: `0 or >= ${codec.artifact.byteLength}`,
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(diagnostic.actual).to.deep.equal({ group: undefined })
    })

    it('rejects pipeline creation when a required bind layout entry is missing', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const program = await createProgram(runtime, codec, { binding: 1 })
        const bindLayout = await createBindLayout(runtime)

        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async() => {
            await runtime.createComputePipeline({
                program,
                layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            })
        })

        expect(diagnostic.expected).to.include({
            group: 0,
            binding: 1,
            name: 'particles',
        })
        expect(diagnostic.actual).to.deep.equal({
            group: 0,
            bindings: [ 0 ],
        })
    })

    it('rejects pipeline creation when bind layout name, type, or visibility do not satisfy the requirement', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const cases = [
            {
                requirement: {},
                entry: { name: 'otherParticles' },
                actual: { name: 'otherParticles' },
            },
            {
                requirement: {},
                entry: { type: 'read-storage' },
                actual: { type: 'read-storage' },
            },
            {
                requirement: { visibility: [ 'compute', 'vertex' ] },
                entry: { visibility: [ 'compute' ] },
                actual: { visibility: [ 'compute' ] },
            },
        ]

        for (const testCase of cases) {
            const program = await createProgram(runtime, codec, testCase.requirement)
            const bindLayout = await createBindLayout(runtime, testCase.entry)
            const diagnostic = await expectAsyncProgramLayoutDiagnostic(async() => {
                await runtime.createComputePipeline({
                    program,
                    layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
                })
            })
            expect(diagnostic.actual).to.deep.equal(testCase.actual)
        }
    })

    it('rejects pipeline creation when the dynamic-offset contract differs', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const program = await createProgram(runtime, codec)
        const bindLayout = await createBindLayout(runtime, {
            hasDynamicOffset: true,
        })
        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async() => {
            await runtime.createComputePipeline({
                program,
                layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            })
        })

        expect(diagnostic.expected).to.deep.include({ hasDynamicOffset: false })
        expect(diagnostic.actual).to.deep.equal({ hasDynamicOffset: true })
    })

    it('enforces the Program ABI lower bound only for nonzero minBindingSize', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const program = await createProgram(runtime, codec)
        const deferredLayout = await createBindLayout(runtime, {
            minBindingSize: 0,
        })
        const tooSmallLayout = await createBindLayout(runtime, {
            minBindingSize: codec.artifact.byteLength - 4,
        })

        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ deferredLayout ] },
        })
        const diagnostic = await expectAsyncProgramLayoutDiagnostic(async() => {
            await runtime.createComputePipeline({
                program,
                layout: { mode: 'explicit', bindLayouts: [ tooSmallLayout ] },
            })
        })

        expect(pipeline).to.be.instanceOf(ScratchComputePipeline)
        expect(diagnostic.expected).to.deep.include({
            abiByteLength: codec.artifact.byteLength,
            minBindingSize: `0 or >= ${codec.artifact.byteLength}`,
        })
        expect(diagnostic.actual).to.deep.equal({
            minBindingSize: codec.artifact.byteLength - 4,
        })
    })

    it('accepts draw and dispatch commands with matching bind sets and buffer layouts', async() => {

        const { runtime } = await createRuntimeFixture()
        const renderCodec = createParticleCodec('RenderCommandParticle')
        const computeCodec = createParticleCodec('ComputeCommandParticle')
        const renderLayout = await createBindLayout(runtime, {
            visibility: [ 'vertex', 'fragment' ],
        })
        const computeLayout = await createBindLayout(runtime, {
            visibility: [ 'compute' ],
        })
        const renderProgram = await createRenderProgram(runtime, renderCodec)
        const computeProgram = await createProgram(runtime, computeCodec)
        const renderPipeline = await runtime.createRenderPipeline({
            program: renderProgram,
            layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePipeline = await runtime.createComputePipeline({
            program: computeProgram,
            layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        })
        const renderSet = await runtime.createBindSet(renderLayout, {
            particles: await createLayoutBuffer(runtime, renderCodec),
        })
        const computeSet = await runtime.createBindSet(computeLayout, {
            particles: await createLayoutBuffer(runtime, computeCodec),
        })

        const draw = runtime.createDrawCommand({
            pipeline: renderPipeline,
            bindSets: [ { set: renderSet } ],
            count: { vertexCount: 3 },
            resources: {
                read: [ readResource(renderSet.bindings.get('particles').resource.buffer) ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const dispatch = runtime.createDispatchCommand({
            pipeline: computePipeline,
            bindSets: [ { set: computeSet } ],
            count: { workgroups: [ 1 ] },
            resources: {
                read: [ readResource(computeSet.bindings.get('particles').resource.buffer) ],
                write: [ computeSet.bindings.get('particles').resource.buffer ],
            },
            whenMissing: 'throw',
        })

        expect(draw).to.be.instanceOf(DrawCommand)
        expect(dispatch).to.be.instanceOf(DispatchCommand)
    })

    it('snapshots Program layout requirements into immutable pipeline command contracts', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const layout = await createBindLayout(runtime)
        const program = await createProgram(runtime, codec)
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'explicit', bindLayouts: [ layout ] },
        })
        const bindSet = await runtime.createBindSet(layout, {
            particles: await createRawBuffer(runtime),
        })

        expect(() => {
            program.layoutRequirements = []
        }).to.throw(TypeError)

        const diagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDispatchCommand({
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ readResource(bindSet.bindings.get('particles').resource.buffer) ],
                    write: [ bindSet.bindings.get('particles').resource.buffer ],
                },
                whenMissing: 'throw',
            })
        })

        expect(diagnostic.expected).to.include({
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(diagnostic.actual).to.deep.equal({ abiHash: undefined, schemaHash: undefined })
    })

    it('rejects draw and dispatch commands when a required bind set group is missing', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const renderLayout = await createBindLayout(runtime, {
            visibility: [ 'vertex', 'fragment' ],
        })
        const computeLayout = await createBindLayout(runtime, {
            visibility: [ 'compute' ],
        })
        const renderPipeline = await runtime.createRenderPipeline({
            program: await createRenderProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePipeline = await runtime.createComputePipeline({
            program: await createProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        })

        const drawDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDrawCommand({
                pipeline: renderPipeline,
                bindSets: [],
                count: { vertexCount: 3 },
                resources: {
                    read: [],
                    write: [],
                },
                whenMissing: 'throw',
            })
        })
        const dispatchDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDispatchCommand({
                pipeline: computePipeline,
                bindSets: [],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [],
                    write: [],
                },
                whenMissing: 'throw',
            })
        })

        expect(drawDiagnostic.actual).to.deep.equal({ bindSetGroups: [] })
        expect(dispatchDiagnostic.actual).to.deep.equal({ bindSetGroups: [] })
    })

    it('rejects draw and dispatch commands when a bound buffer has no layout artifact', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const renderLayout = await createBindLayout(runtime, {
            visibility: [ 'vertex', 'fragment' ],
        })
        const computeLayout = await createBindLayout(runtime, {
            visibility: [ 'compute' ],
        })
        const renderPipeline = await runtime.createRenderPipeline({
            program: await createRenderProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePipeline = await runtime.createComputePipeline({
            program: await createProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        })
        const renderSet = await runtime.createBindSet(renderLayout, {
            particles: await createRawBuffer(runtime),
        })
        const computeSet = await runtime.createBindSet(computeLayout, {
            particles: await createRawBuffer(runtime),
        })

        const drawDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDrawCommand({
                pipeline: renderPipeline,
                bindSets: [ { set: renderSet } ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(renderSet.bindings.get('particles').resource.buffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
        })
        const dispatchDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDispatchCommand({
                pipeline: computePipeline,
                bindSets: [ { set: computeSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ readResource(computeSet.bindings.get('particles').resource.buffer) ],
                    write: [ computeSet.bindings.get('particles').resource.buffer ],
                },
                whenMissing: 'throw',
            })
        })

        expect(drawDiagnostic.expected).to.include({
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(drawDiagnostic.actual).to.deep.equal({ abiHash: undefined, schemaHash: undefined })
        expect(dispatchDiagnostic.actual).to.deep.equal({ abiHash: undefined, schemaHash: undefined })
    })

    it('rejects draw and dispatch commands when bound buffer layout hashes differ', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const otherCodec = createParticleCodec('OtherParticle')
        const renderLayout = await createBindLayout(runtime, {
            visibility: [ 'vertex', 'fragment' ],
        })
        const computeLayout = await createBindLayout(runtime, {
            visibility: [ 'compute' ],
        })
        const renderPipeline = await runtime.createRenderPipeline({
            program: await createRenderProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ renderLayout ] },
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePipeline = await runtime.createComputePipeline({
            program: await createProgram(runtime, codec),
            layout: { mode: 'explicit', bindLayouts: [ computeLayout ] },
        })
        const renderSet = await runtime.createBindSet(renderLayout, {
            particles: await createLayoutBuffer(runtime, otherCodec),
        })
        const computeSet = await runtime.createBindSet(computeLayout, {
            particles: await createLayoutBuffer(runtime, otherCodec),
        })

        const drawDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDrawCommand({
                pipeline: renderPipeline,
                bindSets: [ { set: renderSet } ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(renderSet.bindings.get('particles').resource.buffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
        })
        const dispatchDiagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDispatchCommand({
                pipeline: computePipeline,
                bindSets: [ { set: computeSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ readResource(computeSet.bindings.get('particles').resource.buffer) ],
                    write: [ computeSet.bindings.get('particles').resource.buffer ],
                },
                whenMissing: 'throw',
            })
        })

        expect(drawDiagnostic.expected).to.include({
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(drawDiagnostic.actual).to.deep.include({
            abiHash: otherCodec.artifact.abiHash,
            schemaHash: otherCodec.artifact.schemaHash,
        })
        expect(dispatchDiagnostic.actual).to.deep.include({
            abiHash: otherCodec.artifact.abiHash,
            schemaHash: otherCodec.artifact.schemaHash,
        })
        expect(drawDiagnostic.actual.difference.path).to.match(/^schema/)
        expect(dispatchDiagnostic.actual.difference.path).to.match(/^schema/)
    })

    it('reports ABI incompatibility before exact schema incompatibility', async() => {

        const { runtime } = await createRuntimeFixture()
        const expectedCodec = createParticleCodec()
        const actualCodec = createAbiMismatchCodec()
        const bindLayout = await createBindLayout(runtime)
        const pipeline = await runtime.createComputePipeline({
            program: await createProgram(runtime, expectedCodec),
            layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
        })
        const bindSet = await runtime.createBindSet(bindLayout, {
            particles: await createLayoutBuffer(runtime, actualCodec),
        })

        const diagnostic = expectProgramLayoutDiagnostic(() => {
            runtime.createDispatchCommand({
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ readResource(bindSet.bindings.get('particles').resource.buffer) ],
                    write: [ bindSet.bindings.get('particles').resource.buffer ],
                },
                whenMissing: 'throw',
            })
        })

        expect(diagnostic.actual).to.deep.include({
            abiHash: actualCodec.artifact.abiHash,
            schemaHash: actualCodec.artifact.schemaHash,
        })
        expect(diagnostic.actual.difference.path).to.match(/^abi/)
    })
})
