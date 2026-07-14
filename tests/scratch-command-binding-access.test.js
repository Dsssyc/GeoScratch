import { expect } from 'chai'
import {
    DispatchCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_STORAGE_BINDING = 0x8

const computeWgsl = `
@compute @workgroup_size(1)
fn csMain() {
}
`

function readResource(resource) {

    return { resource, contentEpoch: resource.contentEpoch }
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

async function createPipeline(runtime, bindLayout) {

    const program = runtime.createProgram({
        modules: [ computeWgsl ],
        entryPoints: { compute: 'csMain' },
    })
    return await runtime.createComputePipeline({
        program,
        bindLayouts: [ bindLayout ],
    })
}

function createDispatch(runtime, pipeline, bindSet, resources) {

    return runtime.createDispatchCommand({
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources,
        whenMissing: 'throw',
    })
}

describe('Scratch Command bound resource access', () => {

    it('requires read-write storage buffers in both read and write declarations', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 256,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'values',
                type: 'storage',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(bindLayout, {
            values: buffer.region(),
        })
        const pipeline = await createPipeline(runtime, bindLayout)

        const diagnostic = expectDiagnostic(() => {
            createDispatch(runtime, pipeline, bindSet, {
                read: [ readResource(buffer) ],
                write: [],
            })
        }, {
            code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
            severity: 'error',
            phase: 'command',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 0,
            binding: 0,
            name: 'values',
        })
        expect(diagnostic.expected).to.deep.include({
            access: { read: true, write: true },
            resourceId: buffer.id,
        })
        expect(diagnostic.actual.missing).to.deep.equal({
            read: false,
            write: true,
        })
        expect(fake.calls.commandEncoders).to.have.length(0)

        const missingRead = expectDiagnostic(() => {
            createDispatch(runtime, pipeline, bindSet, {
                read: [],
                write: [ buffer ],
            })
        }, {
            code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
            severity: 'error',
            phase: 'command',
        })
        expect(missingRead.actual.missing).to.deep.equal({
            read: true,
            write: false,
        })

        const command = createDispatch(runtime, pipeline, bindSet, {
            read: [ readResource(buffer) ],
            write: [ buffer ],
        })
        expect(command).to.be.instanceOf(DispatchCommand)
    })

    it('rejects empty read-write storage buffers during submission readiness validation', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 256,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'values',
                type: 'storage',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(bindLayout, { values: buffer.region() })
        const pipeline = await createPipeline(runtime, bindLayout)
        const command = createDispatch(runtime, pipeline, bindSet, {
            read: [ readResource(buffer) ],
            write: [ buffer ],
        })

        const pass = runtime.createComputePass()
        const submission = runtime.createSubmission().compute(pass, [ command ])
        expectDiagnostic(() => submission.submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            severity: 'error',
        })
        expect(fake.calls.commandEncoders).to.have.length(0)
    })

    it('requires sampled textures as parent-resource reads', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'image',
                type: 'texture',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(bindLayout, {
            image: texture.view(),
        })
        const pipeline = await createPipeline(runtime, bindLayout)

        const diagnostic = expectDiagnostic(() => {
            createDispatch(runtime, pipeline, bindSet, {
                read: [],
                write: [],
            })
        }, {
            code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
            severity: 'error',
            phase: 'command',
        })

        expect(diagnostic.expected).to.deep.include({
            access: { read: true, write: false },
            resourceId: texture.id,
        })
        expect(fake.calls.commandEncoders).to.have.length(0)
    })

    for (const testCase of [
        { access: 'read-only', read: true, write: false },
        { access: 'write-only', read: false, write: true },
        { access: 'read-write', read: true, write: true },
    ]) {
        it(`maps ${testCase.access} storage textures to explicit parent-resource access`, async() => {

            const fake = createFakeGpu()
            fake.device.features.add('core-features-and-limits')
            fake.device.features.add('texture-formats-tier2')
            const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
            const texture = await runtime.createTexture({
                size: [ 4, 4 ],
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
            })
            const bindLayout = await runtime.createBindLayout({
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'storageImage',
                    type: 'storage-texture',
                    visibility: [ 'compute' ],
                    access: testCase.access,
                    format: 'rgba8unorm',
                } ],
            })
            const bindSet = await runtime.createBindSet(bindLayout, {
                storageImage: texture.view(),
            })
            const pipeline = await createPipeline(runtime, bindLayout)
            const command = createDispatch(runtime, pipeline, bindSet, {
                read: testCase.read ? [ readResource(texture) ] : [],
                write: testCase.write ? [ texture ] : [],
            })

            expect(command).to.be.instanceOf(DispatchCommand)
            expect(fake.calls.commandEncoders).to.have.length(0)
        })
    }
})
