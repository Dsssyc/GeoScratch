import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { setResourceContentState } from '../packages/geoscratch/dist/scratch/resource.js'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_INDEX = 0x10
const GPU_BUFFER_USAGE_VERTEX = 0x20
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_INDIRECT = 0x100
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

const readOnlyComputeWgsl = `
@group(0) @binding(0)
var<storage, read> inputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    _ = inputValues[0];
}
`

const readWriteComputeWgsl = `
@group(0) @binding(0)
var<storage, read_write> values: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    values[0] = values[0] + 1u;
}
`

const fixedFunctionWgsl = `
struct VertexInput {
    @location(0) position: vec2f,
};

@vertex
fn vsMain(input: VertexInput) -> @builtin(position) vec4f {
    return vec4f(input.position, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(0.9, 0.3, 0.1, 1.0);
}
`

const passConflictWgsl = `
@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(0.0, 0.5),
        vec2f(-0.5, -0.5),
        vec2f(0.5, -0.5)
    );
    return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(0.9, 0.3, 0.1, 1.0);
}
`

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

async function createRuntime(options = {}) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    return { ...fake, runtime }
}

async function createReadOnlyFixture() {

    const fixture = await createRuntime()
    const bindLayout = await fixture.runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'inputValues',
            type: 'read-storage',
            visibility: [ 'compute' ],
        } ],
    })
    const program = fixture.runtime.createProgram({
        modules: [ readOnlyComputeWgsl ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = await fixture.runtime.createComputePipeline({
        program,
        bindLayouts: [ bindLayout ],
    })
    const pass = fixture.runtime.createComputePass({ label: 'current content pass' })

    return { ...fixture, bindLayout, program, pipeline, pass }
}

async function createInput(fixture, label = 'current content input') {

    return await fixture.runtime.createBuffer({
        label,
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
}

async function createReadCommand(fixture, input, readiness = { whenMissing: 'throw' }, contentEpoch = 'current-at-step') {

    const bindSet = await fixture.runtime.createBindSet(fixture.bindLayout, {
        inputValues: input.region(),
    })
    const command = fixture.runtime.createDispatchCommand({
        label: `read ${input.label}`,
        pipeline: fixture.pipeline,
        bindSets: [ { set: bindSet } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: input, contentEpoch } ],
            write: [],
        },
        ...readiness,
    })

    return { bindSet, command }
}

function createUpload(runtime, target, data = new Uint32Array(4)) {

    return runtime.createUploadCommand({
        label: `upload ${target.label}`,
        target: target.region(),
        data,
    })
}

function commandReads(submitted, command) {

    return submitted.resourceAccesses.filter(access => (
        access.commandId === command.id && access.access === 'read'
    ))
}

describe('scratch current-at-step resource reads', () => {

    it('accepts only the explicit current-at-step sentinel and freezes the declaration', async() => {

        const fixture = await createReadOnlyFixture()
        const input = await createInput(fixture)
        const bindSet = await fixture.runtime.createBindSet(fixture.bindLayout, {
            inputValues: input.region(),
        })
        const create = contentEpoch => fixture.runtime.createDispatchCommand({
            pipeline: fixture.pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: {
                read: [ { resource: input, contentEpoch } ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const current = create('current-at-step')
        expect(current.resources.read[0]).to.deep.equal({
            resource: input,
            contentEpoch: 'current-at-step',
        })
        expect(Object.isFrozen(current.resources.read[0])).to.equal(true)
        expect(create(0).resources.read[0].contentEpoch).to.equal(0)

        for (const invalid of [ 'latest', 'current', () => 0, {}, -1, 0.5, undefined ]) {
            const diagnostic = await expectScratchDiagnostic(() => create(invalid), {
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                phase: 'command',
            })
            expect(diagnostic.actual).to.include({
                reason: 'contentEpoch',
                contentEpoch: invalid,
            })
        }
    })

    it('reuses one upload and dispatch while resolving exact historical epochs', async() => {

        const fixture = await createReadOnlyFixture()
        const input = await createInput(fixture)
        const data = new Uint32Array(4)
        const upload = createUpload(fixture.runtime, input, data)
        const { command } = await createReadCommand(fixture, input)
        const commandId = command.id
        const uploadId = upload.id

        for (let expectedEpoch = 1; expectedEpoch <= 3; expectedEpoch++) {
            data.fill(expectedEpoch)
            const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
                .upload(upload)
                .compute(fixture.pass, [ command ])
                .submit()
            const reads = commandReads(submitted, command)

            expect(command.id).to.equal(commandId)
            expect(upload.id).to.equal(uploadId)
            expect(input.contentEpoch).to.equal(expectedEpoch)
            expect(reads).to.have.length(1)
            expect(reads[0]).to.include({
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: expectedEpoch,
                contentEpochAfter: expectedEpoch,
            })
            expect(submitted.producerEpochs[0]).to.include({
                resourceId: input.id,
                contentEpoch: expectedEpoch,
            })
            expect(Object.isFrozen(reads[0])).to.equal(true)
            expect(JSON.parse(JSON.stringify(reads[0]))).to.deep.equal(reads[0])
            await submitted.done
        }
    })

    it('keeps numeric exact reads strict while current-at-step follows an earlier producer', async() => {

        const fixture = await createReadOnlyFixture()
        const input = await createInput(fixture)
        const upload = createUpload(fixture.runtime, input)
        const exact = (await createReadCommand(fixture, input, { whenMissing: 'throw' }, 1)).command
        const current = (await createReadCommand(fixture, input)).command

        fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(fixture.pass, [ exact ])
            .submit()
        expect(input.contentEpoch).to.equal(1)

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(fixture.pass, [ exact ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_STALE_READ',
            phase: 'submission',
        })
        expect(input.contentEpoch).to.equal(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(fixture.pass, [ current ])
            .submit()
        expect(commandReads(submitted, current)[0]).to.include({
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: 2,
        })
        expect(input.contentEpoch).to.equal(2)
    })

    it('does not look ahead and preserves throw, skip-command, and skip-pass readiness policies', async() => {

        const fixture = await createReadOnlyFixture()
        const throwInput = await createInput(fixture, 'throw input')
        const throwCommand = (await createReadCommand(fixture, throwInput)).command
        const throwUpload = createUpload(fixture.runtime, throwInput)
        const encoderCount = fixture.calls.commandEncoders.length
        const writeCount = fixture.calls.queueWrites.length

        const diagnostic = await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ throwCommand ])
            .upload(throwUpload)
            .submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            phase: 'command',
        })
        expect(diagnostic.actual).to.include({
            requiredContentEpoch: 'current-at-step',
            simulatedContentEpoch: 0,
        })
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        expect(fixture.calls.queueWrites).to.have.length(writeCount)

        const skipInput = await createInput(fixture, 'skip command input')
        const skipCommand = (await createReadCommand(fixture, skipInput, { whenMissing: 'skip-command' })).command
        const skipped = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [ skipCommand ])
            .upload(createUpload(fixture.runtime, skipInput))
            .submit()
        expect(skipped.executionOutcomes.find(outcome => outcome.outcomeKind === 'command')).to.include({
            requestedCommandId: skipCommand.id,
            status: 'skipped-command',
        })
        expect(commandReads(skipped, skipCommand)).to.deep.equal([])
        expect(skipInput.contentEpoch).to.equal(1)

        const skipPassInput = await createInput(fixture, 'skip pass input')
        const skipPassCommand = (await createReadCommand(fixture, skipPassInput, { whenMissing: 'skip-pass' })).command
        const skippedPass = fixture.runtime.createSubmission({ validation: 'warn' })
            .compute(fixture.pass, [ skipPassCommand ])
            .submit()
        expect(skippedPass.executionOutcomes.find(outcome => outcome.outcomeKind === 'pass')).to.include({
            passId: fixture.pass.id,
            status: 'skipped-pass',
        })
        expect(commandReads(skippedPass, skipPassCommand)).to.deep.equal([])
    })

    it('resolves current-at-step on the selected fallback command only', async() => {

        const fixture = await createReadOnlyFixture()
        const missing = await createInput(fixture, 'missing primary')
        const ready = await createInput(fixture, 'ready fallback')
        fixture.runtime.createSubmission().upload(createUpload(fixture.runtime, ready)).submit()
        const fallback = (await createReadCommand(fixture, ready)).command
        const primary = (await createReadCommand(fixture, missing, {
            whenMissing: 'use-fallback',
            fallback,
        })).command

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [ primary ])
            .submit()
        const outcome = submitted.executionOutcomes.find(candidate => candidate.outcomeKind === 'command')
        const reads = commandReads(submitted, fallback)

        expect(outcome).to.include({
            requestedCommandId: primary.id,
            executedCommandId: fallback.id,
            status: 'fallback-executed',
        })
        expect(outcome.attempts[0].missing[0]).to.include({
            resourceId: missing.id,
            requiredContentEpoch: 'current-at-step',
        })
        expect(reads).to.have.length(1)
        expect(reads[0]).to.include({
            resourceId: ready.id,
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: 1,
        })
        expect(submitted.resourceAccesses.some(access => access.resourceId === missing.id)).to.equal(false)
    })

    it('resolves reads before writes from the same reusable command', async() => {

        const fixture = await createRuntime()
        const values = await fixture.runtime.createBuffer({
            label: 'read write values',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const bindLayout = await fixture.runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'values',
                type: 'storage',
                visibility: [ 'compute' ],
            } ],
        })
        const bindSet = await fixture.runtime.createBindSet(bindLayout, { values: values.region() })
        const program = fixture.runtime.createProgram({
            modules: [ readWriteComputeWgsl ],
            entryPoints: { compute: 'csMain' },
        })
        const pipeline = await fixture.runtime.createComputePipeline({ program, bindLayouts: [ bindLayout ] })
        const pass = fixture.runtime.createComputePass()
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline,
            bindSets: [ { set: bindSet } ],
            count: { workgroups: [ 1 ] },
            resources: {
                read: [ { resource: values, contentEpoch: 'current-at-step' } ],
                write: [ values ],
            },
            whenMissing: 'throw',
        })
        const upload = createUpload(fixture.runtime, values)

        const first = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(pass, [ dispatch ])
            .submit()
        expect(first.resourceAccesses.filter(access => access.commandId === dispatch.id)).to.deep.include.members([
            {
                ...commandReads(first, dispatch)[0],
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            first.resourceAccesses.find(access => access.commandId === dispatch.id && access.access === 'write'),
        ])
        expect(values.contentEpoch).to.equal(2)

        const second = fixture.runtime.createSubmission({ validation: 'off' })
            .compute(pass, [ dispatch ])
            .submit()
        expect(commandReads(second, dispatch)[0]).to.include({
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: 2,
        })
        expect(second.resourceAccesses.find(access => access.commandId === dispatch.id && access.access === 'write')).to.include({
            contentEpochBefore: 2,
            contentEpochAfter: 3,
        })
        expect(values.contentEpoch).to.equal(3)
    })

    it('resolves current-at-step in throw, warn, and off modes', async() => {

        const fixture = await createReadOnlyFixture()
        const input = await createInput(fixture)
        fixture.runtime.createSubmission().upload(createUpload(fixture.runtime, input)).submit()
        const command = (await createReadCommand(fixture, input)).command

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const submitted = fixture.runtime.createSubmission({ validation })
                .compute(fixture.pass, [ command ])
                .submit()
            expect(submitted.report.diagnostics).to.deep.equal([])
            expect(commandReads(submitted, command)[0]).to.include({
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            })
        }
    })

    it('hard-rejects current-at-step reads from indeterminate content in off mode', async() => {

        const fixture = await createReadOnlyFixture()
        const input = await createInput(fixture)
        const command = (await createReadCommand(fixture, input)).command
        setResourceContentState(input, 'indeterminate', 3)
        const encoderCount = fixture.calls.commandEncoders.length

        const diagnostic = await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ command ])
            .submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
            phase: 'command',
        })
        expect(diagnostic.actual).to.include({
            requiredContentEpoch: 'current-at-step',
            contentEpoch: 3,
        })
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
    })

    it('preserves render pass-conflict disposition in throw, warn, and off modes', async() => {

        const fixture = await createRuntime()
        const target = await fixture.runtime.createTexture({
            label: 'current content conflict target',
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        advanceResourceContentEpochForTest(target)
        const program = fixture.runtime.createProgram({
            modules: [ passConflictWgsl ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const pipeline = await fixture.runtime.createRenderPipeline({
            program,
            targets: [ { format: target.format } ],
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: target.view(),
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline,
            count: { vertexCount: 3 },
            resources: {
                read: [ { resource: target, contentEpoch: 'current-at-step' } ],
                write: [],
            },
            whenMissing: 'throw',
        })

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            phase: 'submission',
        })
        expect(target.contentEpoch).to.equal(1)

        const warned = fixture.runtime.createSubmission({ validation: 'warn' })
            .render(pass, [ draw ])
            .submit()
        expect(warned.diagnostics).to.have.length(1)
        expect(warned.diagnostics[0]).to.include({
            code: 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT',
            phase: 'submission',
        })
        expect(commandReads(warned, draw)[0]).to.include({
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: 1,
        })
        expect(target.contentEpoch).to.equal(2)
        await warned.done

        const off = fixture.runtime.createSubmission({ validation: 'off' })
            .render(pass, [ draw ])
            .submit()
        expect(off.diagnostics).to.deep.equal([])
        expect(commandReads(off, draw)[0]).to.include({
            declaredContentEpoch: 'current-at-step',
            contentEpochBefore: 2,
        })
        expect(target.contentEpoch).to.equal(3)
        await off.done
    })

    it('uses current-at-step for vertex, index, and indirect fixed-function reads', async() => {

        const fixture = await createRuntime()
        const vertex = await fixture.runtime.createBuffer({
            label: 'fixed vertex',
            size: 24,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_VERTEX,
        })
        const index = await fixture.runtime.createBuffer({
            label: 'fixed index',
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDEX,
        })
        const indirect = await fixture.runtime.createBuffer({
            label: 'fixed indirect',
            size: 20,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDIRECT,
        })
        const target = await fixture.runtime.createTexture({
            label: 'fixed target',
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const program = fixture.runtime.createProgram({
            modules: [ fixedFunctionWgsl ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const pipeline = await fixture.runtime.createRenderPipeline({
            program,
            targets: [ { format: target.format } ],
            vertexBuffers: [ {
                arrayStride: 8,
                attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
            } ],
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: target.view(),
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const draw = fixture.runtime.createDrawCommand({
            pipeline,
            vertexBuffers: [ { slot: 0, region: vertex.region() } ],
            indexBuffer: { region: index.region(), format: 'uint16' },
            count: { indirect: indirect.region() },
            resources: {
                read: [ vertex, index, indirect ].map(resource => ({
                    resource,
                    contentEpoch: 'current-at-step',
                })),
                write: [],
            },
            whenMissing: 'throw',
        })
        const uploads = [
            createUpload(fixture.runtime, vertex, new Float32Array([ 0, 0.5, -0.5, -0.5, 0.5, -0.5 ])),
            createUpload(fixture.runtime, index, new Uint16Array([ 0, 1, 2, 0 ])),
            createUpload(fixture.runtime, indirect, new Uint32Array([ 3, 1, 0, 0, 0 ])),
        ]

        for (const expectedEpoch of [ 1, 2 ]) {
            const submission = fixture.runtime.createSubmission({ validation: 'throw' })
            for (const upload of uploads) submission.upload(upload)
            const submitted = submission.render(pass, [ draw ]).submit()
            const reads = commandReads(submitted, draw)

            expect(reads).to.have.length(3)
            expect(reads.map(read => read.resourceId)).to.deep.equal([ vertex.id, index.id, indirect.id ])
            expect(reads.every(read => read.declaredContentEpoch === 'current-at-step')).to.equal(true)
            expect(reads.every(read => read.contentEpochBefore === expectedEpoch)).to.equal(true)
            expect(fixture.calls.maps).to.deep.equal([])
        }
    })
})
