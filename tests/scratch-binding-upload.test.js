import { expect } from 'chai'
import {
    BindLayout,
    BindSet,
    ScratchDiagnosticError,
    ScratchRuntime,
    UploadCommand,
} from 'geoscratch'
import {
    createFakeCanvas,
    createFakeGpu,
    replaceResourceAllocationForTest,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_UNIFORM = 0x40

const uniformTriangleWgsl = `
struct TriangleUniforms {
    color: vec4f,
};

@group(0) @binding(0)
var<uniform> uniforms: TriangleUniforms;

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
    return uniforms.color;
}
`

function createUniformData() {

    return new Float32Array([ 0.12, 0.72, 0.58, 1 ])
}

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

async function createUniformFixture(format = 'bgra8unorm') {

    const fake = createFakeGpu()
    const canvas = createFakeCanvas()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const surface = runtime.createSurface(canvas.canvas, {
        format,
        size: { width: 64, height: 64 },
    })
    const uniformBuffer = runtime.createBuffer({
        label: 'triangle uniforms',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    })
    const bindLayout = runtime.createBindLayout({
        label: 'triangle uniforms layout',
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
    const bindSet = runtime.createBindSet(bindLayout, {
        uniforms: uniformBuffer,
    }, {
        label: 'triangle uniforms set',
    })
    const program = runtime.createProgram({
        modules: [ uniformTriangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        label: 'uniform triangle pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        bindSets: [ bindSet ],
        count: { vertexCount: 3 },
        resources: {
            read: [ readResource(uniformBuffer, 1) ],
            write: [],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            },
        ],
    })
    const upload = runtime.createUploadCommand({
        label: 'upload triangle uniforms',
        target: uniformBuffer,
        data: createUniformData(),
        offset: 0,
    })

    return {
        ...fake,
        ...canvas,
        runtime,
        surface,
        uniformBuffer,
        bindLayout,
        bindSet,
        program,
        pipeline,
        draw,
        pass,
        upload,
    }
}

describe('scratch BindLayout, BindSet, and UploadCommand', () => {

    it('creates explicit uniform bind layouts and bind sets with allocation-version caching', async() => {

        const fixture = await createUniformFixture()

        expect(fixture.bindLayout).to.be.instanceOf(BindLayout)
        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.bindLayout.runtime).to.equal(fixture.runtime)
        expect(fixture.bindLayout.group).to.equal(0)
        expect(fixture.bindLayout.entries).to.deep.equal([
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ])
        expect(fixture.calls.bindGroupLayouts).to.have.length(1)
        expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
            label: 'triangle uniforms layout',
            entries: [
                {
                    binding: 0,
                    visibility: 3,
                    buffer: { type: 'uniform' },
                },
            ],
        })

        const firstBindGroup = fixture.bindSet.getBindGroup()
        const secondBindGroup = fixture.bindSet.getBindGroup()
        fixture.uniformBuffer._advanceContentEpoch()
        const afterContentChange = fixture.bindSet.getBindGroup()

        expect(firstBindGroup).to.equal(secondBindGroup)
        expect(afterContentChange).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.bindGroups[0].descriptor).to.deep.equal({
            label: 'triangle uniforms set',
            layout: fixture.bindLayout.gpuBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: fixture.uniformBuffer.gpuBuffer,
                    },
                },
            ],
        })

        replaceResourceAllocationForTest(fixture.uniformBuffer)
        const afterAllocationChange = fixture.bindSet.getBindGroup()

        expect(afterAllocationChange).not.to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('uploads uniform data explicitly and encodes bind groups before draw', async() => {

        const fixture = await createUniformFixture()

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .render(fixture.pass, [ fixture.draw ])
            .submit()

        expect(fixture.upload).to.be.instanceOf(UploadCommand)
        expect(fixture.uniformBuffer.contentEpoch).to.equal(1)
        expect(fixture.calls.queueWrites).to.have.length(1)
        expect(fixture.calls.queueWrites[0]).to.deep.include({
            buffer: fixture.uniformBuffer.gpuBuffer,
            offset: 0,
            dataOffset: undefined,
            size: undefined,
        })
        expect(fixture.calls.queueWrites[0].data).to.be.instanceOf(Uint8Array)
        expect(fixture.calls.queueWrites[0].data.byteLength).to.equal(fixture.upload.byteLength)
        expect(fixture.calls.pipelineLayouts[0].descriptor).to.deep.equal({
            label: 'uniform triangle pipeline layout',
            bindGroupLayouts: [ fixture.bindLayout.gpuBindGroupLayout ],
        })
        expect(fixture.calls.renderPasses[0].actions).to.deep.equal([
            { type: 'setPipeline', pipeline: fixture.pipeline.gpuPipeline },
            { type: 'setBindGroup', group: 0, bindGroup: fixture.bindSet.getBindGroup() },
            {
                type: 'draw',
                call: {
                    vertexCount: 3,
                    instanceCount: 1,
                    firstVertex: 0,
                    firstInstance: 0,
                },
            },
            { type: 'end' },
        ])

        await submitted.done
    })

    it('rejects invalid bind set entries with structured diagnostics', async() => {

        const fixture = await createUniformFixture()

        try {
            fixture.runtime.createBindSet(fixture.bindLayout, {}, {
                label: 'missing uniforms',
            })
            throw new Error('expected missing bind slot to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING',
                severity: 'error',
                phase: 'binding',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'BindLayoutEntry',
                group: 0,
                binding: 0,
                name: 'uniforms',
            })
        }

        try {
            fixture.runtime.createBindSet(fixture.bindLayout, {
                uniforms: fixture.uniformBuffer,
                extra: fixture.uniformBuffer,
            })
            throw new Error('expected unknown bind slot to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_UNKNOWN_ENTRY',
                severity: 'error',
                phase: 'binding',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                names: [ 'uniforms' ],
            })
            expect(error.diagnostic.actual).to.deep.equal({
                name: 'extra',
            })
        }
    })

    it('rejects wrong-runtime and disposed binding objects with structured diagnostics', async() => {

        const fixtureA = await createUniformFixture()
        const fixtureB = await createUniformFixture()

        try {
            fixtureA.runtime.createRenderPipeline({
                program: fixtureA.program,
                bindLayouts: [ fixtureB.bindLayout ],
                targets: [ { format: fixtureA.surface.format } ],
            })
            throw new Error('expected wrong-runtime bind layout to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'binding',
            })
        }

        try {
            fixtureA.runtime.createBindSet(fixtureA.bindLayout, {
                uniforms: fixtureB.uniformBuffer,
            })
            throw new Error('expected wrong-runtime resource binding to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
        }

        try {
            fixtureA.runtime.createDrawCommand({
                pipeline: fixtureA.pipeline,
                bindSets: [ fixtureB.bindSet ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(fixtureA.uniformBuffer, 1) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected wrong-runtime bind set to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'binding',
            })
        }

        fixtureA.uniformBuffer.dispose()

        try {
            fixtureA.bindSet.getBindGroup()
            throw new Error('expected disposed bound resource to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_DISPOSED',
                severity: 'error',
                phase: 'resource',
            })
        }

        fixtureA.bindSet.dispose()

        try {
            fixtureA.runtime.createDrawCommand({
                pipeline: fixtureA.pipeline,
                bindSets: [ fixtureA.bindSet ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(fixtureA.uniformBuffer, 1) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected disposed bind set to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_BIND_DISPOSED',
                severity: 'error',
                phase: 'binding',
            })
        }
    })

    it('rejects wrong-runtime upload submission with structured diagnostics', async() => {

        const fixtureA = await createUniformFixture()
        const fixtureB = await createUniformFixture()

        try {
            fixtureA.runtime.createSubmission({ validation: 'throw' })
                .upload(fixtureB.upload)
                .submit()
            throw new Error('expected wrong-runtime upload submission to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: fixtureB.runtime.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: fixtureA.runtime.id })
        }
    })

    it('rejects bind set and pipeline layout mismatches with structured diagnostics', async() => {

        const fixture = await createUniformFixture()
        const otherLayout = fixture.runtime.createBindLayout({
            group: 0,
            entries: [
                {
                    binding: 1,
                    name: 'otherUniforms',
                    type: 'uniform',
                    visibility: [ 'fragment' ],
                },
            ],
        })
        const otherBuffer = fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
        })
        const otherSet = fixture.runtime.createBindSet(otherLayout, {
            otherUniforms: otherBuffer,
        })

        try {
            fixture.runtime.createDrawCommand({
                pipeline: fixture.pipeline,
                bindSets: [ otherSet ],
                count: { vertexCount: 3 },
                resources: {
                    read: [ readResource(otherBuffer) ],
                    write: [],
                },
                whenMissing: 'throw',
            })
            throw new Error('expected bind layout mismatch to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
            })
        }
    })

    it('rejects invalid and disposed uploads with structured diagnostics', async() => {

        const fixture = await createUniformFixture()

        for (const descriptor of [
            { target: fixture.uniformBuffer, data: createUniformData(), offset: -1 },
            { target: fixture.uniformBuffer, data: 'not bytes', offset: 0 },
        ]) {
            try {
                fixture.runtime.createUploadCommand(descriptor)
                throw new Error('expected invalid upload descriptor to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID',
                    severity: 'error',
                    phase: 'command',
                })
            }
        }

        fixture.upload.dispose()

        try {
            fixture.runtime.createSubmission({ validation: 'throw' })
                .upload(fixture.upload)
                .submit()
            throw new Error('expected disposed upload command to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
            })
        }
    })
})
