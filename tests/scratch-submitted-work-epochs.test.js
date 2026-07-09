import { expect } from 'chai'
import {
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

function accessFacts(access) {

    const facts = {
        stepIndex: access.stepIndex,
        stepKind: access.stepKind,
        commandKind: access.commandKind,
        commandId: access.commandId,
        passId: access.passId,
        resourceId: access.resourceId,
        resourceKind: access.resourceKind,
        label: access.label,
        subject: access.subject,
        access: access.access,
        contentEpochBefore: access.contentEpochBefore,
        contentEpochAfter: access.contentEpochAfter,
        allocationVersion: access.allocationVersion,
    }

    return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined))
}

function producerFacts(epoch) {

    const facts = {
        resourceId: epoch.resourceId,
        resourceKind: epoch.resourceKind,
        label: epoch.label,
        subject: epoch.subject,
        contentEpoch: epoch.contentEpoch,
        allocationVersion: epoch.allocationVersion,
        producedBy: epoch.producedBy,
    }

    return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined))
}

function createBuffer(runtime, label, usage = GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE) {

    return runtime.createBuffer({
        label,
        size: 16,
        usage,
    })
}

function createTexture(runtime, label, usage = GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) {

    return runtime.createTexture({
        label,
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage,
    })
}

function createCompute(runtime, input, output) {

    const bindLayout = runtime.createBindLayout({
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        inputValues: input,
        outputValues: output,
    })
    const program = runtime.createProgram({
        modules: [
            `
                @group(0) @binding(0) var<storage, read> inputValues: array<f32>;
                @group(0) @binding(1) var<storage, read_write> outputValues: array<f32>;
                @compute @workgroup_size(1)
                fn csMain() {
                }
            `,
        ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = runtime.createComputePipeline({
        program,
        bindLayouts: [ bindLayout ],
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'dispatch values',
        pipeline,
        bindSets: [ bindSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ input ],
            write: [ output ],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({
        label: 'compute values',
    })

    return { bindLayout, bindSet, program, pipeline, dispatch, pass }
}

function createRender(runtime, target, resources = { read: [], write: [] }) {

    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        bindLayouts: [],
        targets: [ { format: target.format } ],
    })
    const draw = runtime.createDrawCommand({
        label: 'draw color',
        pipeline,
        count: { vertexCount: 3 },
        resources,
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'draw target',
        color: [
            {
                target,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            },
        ],
    })

    return { program, pipeline, draw, pass }
}

describe('scratch SubmittedWork resource epoch ledger', () => {

    it('records upload target writes and producer epochs', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createBuffer(runtime, 'upload target')
        const upload = runtime.createUploadCommand({
            label: 'upload bytes',
            target,
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: upload.id,
                resourceId: target.id,
                resourceKind: 'BufferResource',
                label: 'upload target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(producerFacts)).to.deep.equal([
            {
                resourceId: target.id,
                resourceKind: 'BufferResource',
                label: 'upload target',
                subject: target.subject,
                contentEpoch: 1,
                allocationVersion: 1,
                producedBy: {
                    stepIndex: 0,
                    stepKind: 'upload',
                    commandKind: 'upload',
                    commandId: upload.id,
                },
            },
        ])

        await submitted.done
    })

    it('records texture upload target writes and producer epochs', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createTexture(runtime, 'texture upload target')
        const upload = runtime.createTextureUploadCommand({
            label: 'upload texture bytes',
            target,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: upload.id,
                resourceId: target.id,
                resourceKind: 'TextureResource',
                label: 'texture upload target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs).to.have.length(1)
        expect(submitted.producerEpochs[0].contentEpoch).to.equal(1)

        await submitted.done
    })

    it('records copy source reads and target writes in order', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createBuffer(runtime, 'copy source')
        const target = createBuffer(runtime, 'copy target')
        const copy = runtime.createCopyCommand({
            label: 'copy bytes',
            source,
            target,
            byteLength: 16,
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .copy(copy)
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'copy',
                commandKind: 'copy',
                commandId: copy.id,
                resourceId: source.id,
                resourceKind: 'BufferResource',
                label: 'copy source',
                subject: source.subject,
                access: 'read',
                contentEpochBefore: 0,
                contentEpochAfter: 0,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'copy',
                commandKind: 'copy',
                commandId: copy.id,
                resourceId: target.id,
                resourceKind: 'BufferResource',
                label: 'copy target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ target.id ])

        await submitted.done
    })

    it('records query resolve destination writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const querySet = runtime.createQuerySet({
            label: 'timing queries',
            type: 'timestamp',
            count: 2,
        })
        const destination = createBuffer(
            runtime,
            'query destination',
            GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC
        )
        const resolve = runtime.createResolveQuerySetCommand({
            label: 'resolve queries',
            querySet,
            queryCount: 2,
            destination,
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .resolve(resolve)
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'resolve',
                commandKind: 'resolve-query-set',
                commandId: resolve.id,
                resourceId: destination.id,
                resourceKind: 'BufferResource',
                label: 'query destination',
                subject: destination.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ destination.id ])

        await submitted.done
    })

    it('records compute dispatch declared reads and writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const input = createBuffer(runtime, 'compute input')
        const output = createBuffer(runtime, 'compute output')
        const compute = createCompute(runtime, input, output)
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .compute(compute.pass, [ compute.dispatch ])
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'compute',
                commandKind: 'dispatch',
                commandId: compute.dispatch.id,
                passId: compute.pass.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'compute input',
                subject: input.subject,
                access: 'read',
                contentEpochBefore: 0,
                contentEpochAfter: 0,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'compute',
                commandKind: 'dispatch',
                commandId: compute.dispatch.id,
                passId: compute.pass.id,
                resourceId: output.id,
                resourceKind: 'BufferResource',
                label: 'compute output',
                subject: output.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(producerFacts)).to.deep.equal([
            {
                resourceId: output.id,
                resourceKind: 'BufferResource',
                label: 'compute output',
                subject: output.subject,
                contentEpoch: 1,
                allocationVersion: 1,
                producedBy: {
                    stepIndex: 0,
                    stepKind: 'compute',
                    commandKind: 'dispatch',
                    commandId: compute.dispatch.id,
                    passId: compute.pass.id,
                },
            },
        ])

        await submitted.done
    })

    it('records render texture attachment writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createTexture(runtime, 'render target')
        const render = createRender(runtime, target)
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(render.pass, [ render.draw ])
            .submit()

        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'render',
                passId: render.pass.id,
                resourceId: target.id,
                resourceKind: 'TextureResource',
                label: 'render target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ target.id ])

        await submitted.done
    })

    it('records render draw declared reads and writes before pass attachment writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const input = createBuffer(runtime, 'draw input')
        const output = createBuffer(runtime, 'draw output')
        const target = createTexture(runtime, 'draw render target')
        const render = createRender(runtime, target, {
            read: [ input ],
            write: [ output ],
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(render.pass, [ render.draw ])
            .submit()

        expect(output.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: render.draw.id,
                passId: render.pass.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'draw input',
                subject: input.subject,
                access: 'read',
                contentEpochBefore: 0,
                contentEpochAfter: 0,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: render.draw.id,
                passId: render.pass.id,
                resourceId: output.id,
                resourceKind: 'BufferResource',
                label: 'draw output',
                subject: output.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'render',
                passId: render.pass.id,
                resourceId: target.id,
                resourceKind: 'TextureResource',
                label: 'draw render target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ output.id, target.id ])

        await submitted.done
    })

    it('preserves deterministic step order for mixed submissions', async() => {

        const { runtime } = await createRuntimeFixture()
        const uploadTarget = createBuffer(runtime, 'ordered upload target')
        const copyTarget = createBuffer(runtime, 'ordered copy target')
        const computeOutput = createBuffer(runtime, 'ordered compute output')
        const renderTarget = createTexture(runtime, 'ordered render target')
        const upload = runtime.createUploadCommand({
            target: uploadTarget,
            data: new Uint8Array(16),
        })
        const copy = runtime.createCopyCommand({
            source: uploadTarget,
            target: copyTarget,
            byteLength: 16,
        })
        const compute = createCompute(runtime, copyTarget, computeOutput)
        const render = createRender(runtime, renderTarget, {
            read: [ computeOutput ],
            write: [],
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .compute(compute.pass, [ compute.dispatch ])
            .render(render.pass, [ render.draw ])
            .submit()

        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            access: access.access,
            label: access.label,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'upload', access: 'write', label: 'ordered upload target' },
            { stepIndex: 1, stepKind: 'copy', access: 'read', label: 'ordered upload target' },
            { stepIndex: 1, stepKind: 'copy', access: 'write', label: 'ordered copy target' },
            { stepIndex: 2, stepKind: 'compute', access: 'read', label: 'ordered copy target' },
            { stepIndex: 2, stepKind: 'compute', access: 'write', label: 'ordered compute output' },
            { stepIndex: 3, stepKind: 'render', access: 'read', label: 'ordered compute output' },
            { stepIndex: 3, stepKind: 'render', access: 'write', label: 'ordered render target' },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.producedBy.stepIndex)).to.deep.equal([ 0, 1, 2, 3 ])

        await submitted.done
    })

    it('keeps content epochs separate from allocation versions', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createBuffer(runtime, 'stable allocation target')
        const upload = runtime.createUploadCommand({
            target,
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(target.contentEpoch).to.equal(1)
        expect(target.allocationVersion).to.equal(1)
        expect(submitted.resourceAccesses[0]).to.include({
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 1,
        })

        await submitted.done
    })

    it('keeps submitted reports compatible with the existing empty report behavior', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createBuffer(runtime, 'reported target')
        const upload = runtime.createUploadCommand({
            target,
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(submitted.report).to.deep.equal({
            version: 1,
            diagnostics: [],
            hasErrors: false,
            errorCount: 0,
            warningCount: 0,
        })

        await submitted.done
    })

    it('does not expose mutable ledger storage', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = createBuffer(runtime, 'immutable target')
        const upload = runtime.createUploadCommand({
            target,
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(Object.isFrozen(submitted.resourceAccesses)).to.equal(true)
        expect(Object.isFrozen(submitted.resourceAccesses[0])).to.equal(true)
        expect(Object.isFrozen(submitted.producerEpochs)).to.equal(true)
        expect(Object.isFrozen(submitted.producerEpochs[0])).to.equal(true)

        await submitted.done
    })
})
