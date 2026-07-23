import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    ComputePassSpec,
    DispatchCommand,
    ReadbackOperation,
    ScratchComputePipeline,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_MAP_READ = 0x1
const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

const doubleWgsl = `
@group(0) @binding(0)
var<storage, read> inputValues: array<f32>;

@group(0) @binding(1)
var<storage, read_write> outputValues: array<f32>;

@compute @workgroup_size(4)
fn csMain(@builtin(global_invocation_id) id: vec3u) {
    outputValues[id.x] = inputValues[id.x] * 2.0;
}
`

async function createComputeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const input = await runtime.createBuffer({
        label: 'compute input',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
    const output = await runtime.createBuffer({
        label: 'compute output',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
    const bindLayout = await runtime.createBindLayout({
        label: 'compute storage layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: false,
                minBindingSize: 0,
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: false,
                minBindingSize: 0,
            },
        ],
    })
    const bindSet = await runtime.createBindSet(bindLayout, {
        inputValues: input.region(),
        outputValues: output.region(),
    }, {
        label: 'compute storage set',
    })
    const program = await createTestProgram(runtime, {
        label: 'double compute program',
        sourceParts: [ doubleWgsl ],
        compute: 'csMain',
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'double compute pipeline',
        program,
        layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'dispatch double compute',
        pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1, 1, 1 ] },
        resources: {
            read: [ readResource(input, 1), readResource(output, 1) ],
            write: [ output ],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({
        label: 'double compute pass',
    })
    const upload = runtime.createUploadCommand({
        label: 'upload compute input',
        target: (input).region({ offset: 0 }),
        data: new Float32Array([ 1, 2, 3, 4 ]),
    })
    const initializeOutput = runtime.createUploadCommand({
        label: 'initialize compute output',
        target: output.region(),
        data: new Float32Array(4),
    })

    return {
        ...fake,
        runtime,
        input,
        output,
        bindLayout,
        bindSet,
        program,
        pipeline,
        dispatch,
        pass,
        upload,
        initializeOutput,
    }
}

describe('scratch ComputePipeline, DispatchCommand, and ReadbackOperation', () => {

    it('creates explicit storage bind layouts and bind sets', async() => {

        const fixture = await createComputeFixture()

        expect(fixture.bindLayout.entries).to.deep.equal([
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: false,
                minBindingSize: 0,
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: false,
                minBindingSize: 0,
            },
        ])
        expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
            label: `compute storage layout [scratch:${fixture.bindLayout.id}]`,
            entries: [
                {
                    binding: 0,
                    visibility: 4,
                    buffer: { type: 'read-only-storage', hasDynamicOffset: false, minBindingSize: 0 },
                },
                {
                    binding: 1,
                    visibility: 4,
                    buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
                },
            ],
        })

        expect(fixture.calls.bindGroups[0].descriptor).to.deep.equal({
            label: `compute storage set [scratch:${fixture.bindSet.id}]`,
            layout: fixture.bindLayout.gpuBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: fixture.input.gpuBuffer, offset: 0, size: 16 },
                },
                {
                    binding: 1,
                    resource: { buffer: fixture.output.gpuBuffer, offset: 0, size: 16 },
                },
            ],
        })
        await fixture.bindSet.prepare()
        expect(fixture.calls.bindGroups).to.have.length(1)
    })

    it('builds a compute pipeline from a Program compute entry point', async() => {

        const fixture = await createComputeFixture()

        expect(fixture.pipeline).to.be.instanceOf(ScratchComputePipeline)
        expect(fixture.pipeline.pipelineKind).to.equal('compute')
        expect(fixture.pipeline.compute.entryPoint).to.equal('csMain')
        expect(fixture.calls.computePipelines[0].descriptor).to.deep.include({
            label: `double compute pipeline [scratch:${fixture.pipeline.id}]`,
            layout: fixture.pipeline.pipelineLayout,
        })
        expect(fixture.calls.computePipelines[0].descriptor.compute).to.deep.equal({
            module: fixture.pipeline.compute.module.gpuShaderModule,
            entryPoint: 'csMain',
        })
    })

    it('submits compute-only work and advances written resource content epochs', async() => {

        const fixture = await createComputeFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .upload(fixture.initializeOutput)
            .compute(fixture.pass, [ fixture.dispatch ])
            .submit()

        expect(fixture.pass).to.be.instanceOf(ComputePassSpec)
        expect(fixture.dispatch).to.be.instanceOf(DispatchCommand)
        expect(fixture.dispatch.resources.read).to.deep.equal([
            readResource(fixture.input, 1),
            readResource(fixture.output, 1),
        ])
        expect(fixture.output.contentEpoch).to.equal(2)
        expect(fixture.calls.computePasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            {
                type: 'setBindGroup',
                group: 0,
                bindGroup: fixture.calls.bindGroups[0],
            },
            {
                type: 'dispatchWorkgroups',
                call: { x: 1, y: 1, z: 1 },
            },
            { type: 'end' },
        ])
        expect(fixture.calls.queueSubmissions).to.have.length(1)

        await submitted.done
    })

    it('reads back a submitted buffer range through an explicit operation', async() => {

        const fixture = await createComputeFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .upload(fixture.initializeOutput)
            .compute(fixture.pass, [ fixture.dispatch ])
            .submit()

        new Float32Array(fixture.output.gpuBuffer.data.buffer).set([ 2, 4, 6, 8 ])

        const readback = fixture.runtime.createReadback({
            label: 'read doubled output',
            source: fixture.output.region(),
            after: submitted,
        })
        const values = await readback.toArray(Float32Array)

        expect(readback).to.be.instanceOf(ReadbackOperation)
        expect(readback.source.buffer).to.equal(fixture.output)
        expect(readback.contentEpoch).to.equal(2)
        expect([ ...values ]).to.deep.equal([ 2, 4, 6, 8 ])
        expect(fixture.calls.copies[0]).to.deep.include({
            source: fixture.output.gpuBuffer,
            sourceOffset: 0,
            destinationOffset: 0,
            size: 16,
        })
        expect(fixture.calls.maps[0]).to.deep.include({
            mode: GPU_BUFFER_USAGE_MAP_READ,
            offset: 0,
            size: 16,
        })
        expect(readback.state).to.equal('consumed')
    })

    it('rejects invalid BufferRegion ranges before readback construction', async() => {

        const fixture = await createComputeFixture()

        try {
            fixture.runtime.createReadback({ source: fixture.output.region({ offset: 12, size: 8 }) })
            throw new Error('expected invalid readback range to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BUFFER_REGION_RANGE_INVALID',
                severity: 'error',
                phase: 'resource',
            })
            expect(error.diagnostic.actual).to.deep.include({
                offset: 12,
                size: 8,
                bufferSize: 16,
            })
        }
    })
})
