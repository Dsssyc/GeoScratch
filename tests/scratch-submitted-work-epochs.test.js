import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    advanceQuerySlotContentEpochForTest,
    advanceResourceContentEpochForTest,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

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

function readResource(resource, contentEpoch = resource.contentEpoch) {

    return { resource, contentEpoch }
}

function copySource(resource, contentEpoch = resource.contentEpoch, region = {}) {

    return resource.resourceKind === 'BufferResource'
        ? { region: resource.region(region), contentEpoch }
        : { resource, contentEpoch }
}

function copyDestination(resource, region = {}) {

    return resource.resourceKind === 'BufferResource'
        ? resource.region(region)
        : resource
}

function querySlots(indices, contentEpoch) {

    return indices.map(index => ({ index, contentEpoch }))
}

async function createBuffer(runtime, label, usage = GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE) {

    return await runtime.createBuffer({
        label,
        size: 16,
        usage,
    })
}

async function createTexture(runtime, label, usage = GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) {

    return await runtime.createTexture({
        label,
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage,
    })
}

async function createCompute(runtime, input, output, readContentEpoch = input.contentEpoch) {

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
        inputValues: input.region(),
        outputValues: output.region(),
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
    const pipeline = await runtime.createComputePipeline({
        program,
        bindLayouts: [ bindLayout ],
    })
    const dispatch = runtime.createDispatchCommand({
        label: 'dispatch values',
        pipeline,
        bindSets: [ bindSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ readResource(input, readContentEpoch) ],
            write: [ output ],
        },
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({
        label: 'compute values',
    })

    return { bindLayout, bindSet, program, pipeline, dispatch, pass }
}

async function createRender(runtime, target, resources = { read: [], write: [] }) {

    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
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
                target: target.view(),
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
        const target = await createBuffer(runtime, 'upload target')
        const upload = runtime.createUploadCommand({
            label: 'upload bytes',
            target: target.region(),
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()

        expect(target.state).to.equal('ready')
        expect(target.isReady).to.equal(true)
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
        const target = await createTexture(runtime, 'texture upload target')
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

        expect(target.state).to.equal('ready')
        expect(target.isReady).to.equal(true)
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
        const source = await createBuffer(runtime, 'copy source')
        const target = await createBuffer(runtime, 'copy target')
        advanceResourceContentEpochForTest(source)
        const copy = runtime.createCopyCommand({
            label: 'copy bytes',
            source: copySource(source, 1),
            target: copyDestination(target),
            whenMissing: 'throw',
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
                contentEpochBefore: 1,
                contentEpochAfter: 1,
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
        expect(target.state).to.equal('ready')
        expect(target.isReady).to.equal(true)

        await submitted.done
    })

    it('records texture copy source reads and target writes in order', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createTexture(
            runtime,
            'texture copy source',
            GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const target = await createTexture(
            runtime,
            'texture copy target',
            GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        advanceResourceContentEpochForTest(source)
        const copy = runtime.createCopyCommand({
            label: 'copy texture',
            source: copySource(source, 1),
            target: copyDestination(target),
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
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
                resourceKind: 'TextureResource',
                label: 'texture copy source',
                subject: source.subject,
                access: 'read',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 0,
                stepKind: 'copy',
                commandKind: 'copy',
                commandId: copy.id,
                resourceId: target.id,
                resourceKind: 'TextureResource',
                label: 'texture copy target',
                subject: target.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ target.id ])
        expect(target.state).to.equal('ready')
        expect(target.isReady).to.equal(true)

        await submitted.done
    })

    it('rejects copy reads of an empty source before creating a command encoder in every validation mode', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createBuffer(runtime, `empty copy source ${validation}`)
            const target = await createBuffer(runtime, `empty copy target ${validation}`)
            const copy = runtime.createCopyCommand({
                label: `copy empty source ${validation}`,
                source: copySource(source, 0),
                target: copyDestination(target),
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .copy(copy)

            const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
                severity: 'error',
                phase: 'command',
            })

            expect(diagnostic.subject).to.deep.equal(copy.subject)
            expect(diagnostic.related).to.deep.include(source.subject)
            expect(diagnostic.related).to.deep.include(builder.subject)
            expect(diagnostic.related).to.not.deep.include(target.subject)
            expect(diagnostic.expected).to.deep.equal({ resourceState: 'ready' })
            expect(diagnostic.actual).to.deep.include({
                stepIndex: 0,
                commandId: copy.id,
                commandKind: 'copy',
                access: 'read',
                role: 'source',
                resourceId: source.id,
                resourceKind: 'BufferResource',
                resourceState: 'empty',
                requiredContentEpoch: 0,
                simulatedContentEpoch: 0,
                currentContentEpoch: 0,
                allocationVersion: 1,
                whenMissing: 'throw',
            })
            expect(source.contentEpoch).to.equal(0)
            expect(target.contentEpoch).to.equal(0)
            expect(source.state).to.equal('empty')
            expect(target.state).to.equal('empty')
            expect(calls.commandEncoders).to.have.length(0)
            expect(calls.copies).to.have.length(0)
            expect(calls.queueSubmissions).to.have.length(0)
        }
    })

    it('rejects texture copy reads of an empty source before creating a command encoder in every validation mode', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createTexture(
                runtime,
                `empty texture copy source ${validation}`,
                GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            const target = await createTexture(
                runtime,
                `empty texture copy target ${validation}`,
                GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            const copy = runtime.createCopyCommand({
                label: `copy empty texture source ${validation}`,
                source: copySource(source, 0),
                target: copyDestination(target),
                size: { width: 2, height: 2 },
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .copy(copy)

            const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
                severity: 'error',
                phase: 'command',
            })

            expect(diagnostic.subject).to.deep.equal(copy.subject)
            expect(diagnostic.related).to.deep.include(source.subject)
            expect(diagnostic.related).to.deep.include(builder.subject)
            expect(diagnostic.related).to.not.deep.include(target.subject)
            expect(diagnostic.expected).to.deep.equal({ resourceState: 'ready' })
            expect(diagnostic.actual).to.deep.include({
                stepIndex: 0,
                commandId: copy.id,
                commandKind: 'copy',
                access: 'read',
                role: 'source',
                resourceId: source.id,
                resourceKind: 'TextureResource',
                resourceState: 'empty',
                requiredContentEpoch: 0,
                simulatedContentEpoch: 0,
                currentContentEpoch: 0,
                allocationVersion: 1,
                whenMissing: 'throw',
            })
            expect(source.contentEpoch).to.equal(0)
            expect(target.contentEpoch).to.equal(0)
            expect(source.state).to.equal('empty')
            expect(target.state).to.equal('empty')
            expect(calls.commandEncoders).to.have.length(0)
            expect(calls.textureCopies).to.have.length(0)
            expect(calls.queueSubmissions).to.have.length(0)
        }
    })

    it('applies validation mode to copy read-before-write diagnostics', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createBuffer(runtime, `future copy source ${validation}`)
            const target = await createBuffer(runtime, `future copy target ${validation}`)
            advanceResourceContentEpochForTest(source)
            const copy = runtime.createCopyCommand({
                label: `copy future source ${validation}`,
                source: copySource(source, 2),
                target: copyDestination(target),
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .copy(copy)

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(copy.subject)
                expect(diagnostic.related).to.deep.include(source.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 2 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 0,
                    commandId: copy.id,
                    commandKind: 'copy',
                    access: 'read',
                    role: 'source',
                    resourceId: source.id,
                    resourceKind: 'BufferResource',
                    resourceState: 'ready',
                    requiredContentEpoch: 2,
                    simulatedContentEpoch: 1,
                    currentContentEpoch: 1,
                    allocationVersion: 1,
                    whenMissing: 'throw',
                })
                expect(source.contentEpoch).to.equal(1)
                expect(target.contentEpoch).to.equal(0)
                expect(calls.commandEncoders).to.have.length(0)
                expect(calls.copies).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 2 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(source.contentEpoch).to.equal(1)
            expect(target.contentEpoch).to.equal(1)
            expect(calls.commandEncoders).to.have.length(1)
            expect(calls.copies).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('applies validation mode to copy stale-read diagnostics without mutating on throw', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createBuffer(runtime, `stale copy source ${validation}`)
            const target = await createBuffer(runtime, `stale copy target ${validation}`)
            advanceResourceContentEpochForTest(source)
            const upload = runtime.createUploadCommand({
                label: `refresh copy source ${validation}`,
                target: (source).region(),
                data: new Uint8Array(16),
            })
            const copy = runtime.createCopyCommand({
                label: `copy stale source ${validation}`,
                source: copySource(source, 1),
                target: copyDestination(target),
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .upload(upload)
                .copy(copy)

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(copy.subject)
                expect(diagnostic.related).to.deep.include(source.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 1,
                    commandId: copy.id,
                    commandKind: 'copy',
                    access: 'read',
                    role: 'source',
                    resourceId: source.id,
                    resourceKind: 'BufferResource',
                    resourceState: 'ready',
                    requiredContentEpoch: 1,
                    simulatedContentEpoch: 2,
                    currentContentEpoch: 1,
                    allocationVersion: 1,
                    whenMissing: 'throw',
                })
                expect(source.contentEpoch).to.equal(1)
                expect(target.contentEpoch).to.equal(0)
                expect(source.allocationVersion).to.equal(1)
                expect(target.allocationVersion).to.equal(1)
                expect(calls.queueWrites).to.have.length(0)
                expect(calls.commandEncoders).to.have.length(0)
                expect(calls.copies).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 1 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(source.contentEpoch).to.equal(2)
            expect(target.contentEpoch).to.equal(1)
            expect(calls.queueWrites).to.have.length(1)
            expect(calls.copies).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('applies validation mode to texture copy read-before-write diagnostics', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createTexture(
                runtime,
                `future texture copy source ${validation}`,
                GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            const target = await createTexture(
                runtime,
                `future texture copy target ${validation}`,
                GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            advanceResourceContentEpochForTest(source)
            const copy = runtime.createCopyCommand({
                label: `copy future texture source ${validation}`,
                source: copySource(source, 2),
                target: copyDestination(target),
                size: { width: 2, height: 2 },
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .copy(copy)

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(copy.subject)
                expect(diagnostic.related).to.deep.include(source.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 2 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 0,
                    commandId: copy.id,
                    commandKind: 'copy',
                    access: 'read',
                    role: 'source',
                    resourceId: source.id,
                    resourceKind: 'TextureResource',
                    resourceState: 'ready',
                    requiredContentEpoch: 2,
                    simulatedContentEpoch: 1,
                    currentContentEpoch: 1,
                    allocationVersion: 1,
                    whenMissing: 'throw',
                })
                expect(source.contentEpoch).to.equal(1)
                expect(target.contentEpoch).to.equal(0)
                expect(calls.commandEncoders).to.have.length(0)
                expect(calls.textureCopies).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 2 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(source.contentEpoch).to.equal(1)
            expect(target.contentEpoch).to.equal(1)
            expect(calls.commandEncoders).to.have.length(1)
            expect(calls.textureCopies).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('applies validation mode to texture copy stale-read diagnostics without mutating on throw', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const source = await createTexture(
                runtime,
                `stale texture copy source ${validation}`,
                GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            const target = await createTexture(
                runtime,
                `stale texture copy target ${validation}`,
                GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
            )
            advanceResourceContentEpochForTest(source)
            const upload = runtime.createTextureUploadCommand({
                label: `refresh texture copy source ${validation}`,
                target: source,
                data: new Uint8Array(16),
                layout: { bytesPerRow: 8, rowsPerImage: 2 },
                size: { width: 2, height: 2 },
            })
            const copy = runtime.createCopyCommand({
                label: `copy stale texture source ${validation}`,
                source: copySource(source, 1),
                target: copyDestination(target),
                size: { width: 2, height: 2 },
                whenMissing: 'throw',
            })
            const builder = runtime.createSubmission({ validation })
                .upload(upload)
                .copy(copy)

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(copy.subject)
                expect(diagnostic.related).to.deep.include(source.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 1,
                    commandId: copy.id,
                    commandKind: 'copy',
                    access: 'read',
                    role: 'source',
                    resourceId: source.id,
                    resourceKind: 'TextureResource',
                    resourceState: 'ready',
                    requiredContentEpoch: 1,
                    simulatedContentEpoch: 2,
                    currentContentEpoch: 1,
                    allocationVersion: 1,
                    whenMissing: 'throw',
                })
                expect(source.contentEpoch).to.equal(1)
                expect(target.contentEpoch).to.equal(0)
                expect(calls.queueTextureWrites).to.have.length(0)
                expect(calls.textureCopies).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 1 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(source.contentEpoch).to.equal(2)
            expect(target.contentEpoch).to.equal(1)
            expect(calls.queueTextureWrites).to.have.length(1)
            expect(calls.textureCopies).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('allows same-submission upload to satisfy a copy source requiring the produced epoch', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createBuffer(runtime, 'same submission copy source')
        const target = await createBuffer(runtime, 'same submission copy target')
        const upload = runtime.createUploadCommand({
            label: 'produce copy source',
            target: (source).region(),
            data: new Uint8Array(16),
        })
        const copy = runtime.createCopyCommand({
            label: 'copy produced source',
            source: copySource(source, 1),
            target: copyDestination(target),
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            resourceId: access.resourceId,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                resourceId: source.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'read',
                resourceId: source.id,
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'write',
                resourceId: target.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])

        await submitted.done
    })

    it('allows same-submission texture upload to satisfy a texture copy source requiring the produced epoch', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createTexture(
            runtime,
            'same submission texture copy source',
            GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const target = await createTexture(
            runtime,
            'same submission texture copy target',
            GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const upload = runtime.createTextureUploadCommand({
            label: 'produce texture copy source',
            target: source,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const copy = runtime.createCopyCommand({
            label: 'copy produced texture source',
            source: copySource(source, 1),
            target: copyDestination(target),
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            resourceId: access.resourceId,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                resourceId: source.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'read',
                resourceId: source.id,
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'write',
                resourceId: target.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])

        await submitted.done
    })

    it('records buffer-to-texture copy source reads and target texture writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await runtime.createBuffer({
            label: 'buffer texture ledger source',
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const target = await createTexture(
            runtime,
            'buffer texture ledger target',
            GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const upload = runtime.createUploadCommand({
            label: 'produce buffer texture ledger source',
            target: source.region({ size: 16 }),
            data: new Uint8Array(16),
        })
        const copy = runtime.createCopyCommand({
            label: 'copy buffer texture ledger',
            source: copySource(source, 1),
            sourceLayout: { bytesPerRow: 256, rowsPerImage: 2 },
            target: copyDestination(target),
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            resourceId: access.resourceId,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                resourceId: source.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'read',
                resourceId: source.id,
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'write',
                resourceId: target.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ source.id, target.id ])

        await submitted.done
    })

    it('records texture-to-buffer copy source reads and target buffer writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createTexture(
            runtime,
            'texture buffer ledger source',
            GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const target = await runtime.createBuffer({
            label: 'texture buffer ledger target',
            size: 1024,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const upload = runtime.createTextureUploadCommand({
            label: 'produce texture buffer ledger source',
            target: source,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const copy = runtime.createCopyCommand({
            label: 'copy texture buffer ledger',
            source: copySource(source, 1),
            target: copyDestination(target),
            targetLayout: { bytesPerRow: 256, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            resourceId: access.resourceId,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                resourceId: source.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'read',
                resourceId: source.id,
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'copy',
                commandKind: 'copy',
                access: 'write',
                resourceId: target.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ source.id, target.id ])

        await submitted.done
    })

    it('allows same-submission render attachment writes to satisfy later texture copy sources', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createTexture(
            runtime,
            'rendered texture copy source',
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const target = await createTexture(
            runtime,
            'rendered texture copy target',
            GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const render = await createRender(runtime, source)
        const copy = runtime.createCopyCommand({
            label: 'copy rendered texture source',
            source: copySource(source, 1),
            target: copyDestination(target),
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(render.pass, [ render.draw ])
            .copy(copy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            label: access.label,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'render', commandKind: undefined, access: 'write', label: 'rendered texture copy source' },
            { stepIndex: 1, stepKind: 'copy', commandKind: 'copy', access: 'read', label: 'rendered texture copy source' },
            { stepIndex: 1, stepKind: 'copy', commandKind: 'copy', access: 'write', label: 'rendered texture copy target' },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ source.id, target.id ])

        await submitted.done
    })

    it('allows same-submission texture copy targets to satisfy later draw reads', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createTexture(
            runtime,
            'draw texture copy source',
            GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const copied = await createTexture(
            runtime,
            'draw texture copy target',
            GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const renderTarget = await createTexture(runtime, 'draw after texture copy render target')
        advanceResourceContentEpochForTest(source)
        const copy = runtime.createCopyCommand({
            label: 'copy before draw read',
            source: copySource(source, 1),
            target: copyDestination(copied),
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const render = await createRender(runtime, renderTarget, {
            read: [ readResource(copied, 1) ],
            write: [],
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .copy(copy)
            .render(render.pass, [ render.draw ])
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(copied.contentEpoch).to.equal(1)
        expect(renderTarget.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            label: access.label,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', access: 'read', label: 'draw texture copy source' },
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', access: 'write', label: 'draw texture copy target' },
            { stepIndex: 1, stepKind: 'render', commandKind: 'draw', access: 'read', label: 'draw texture copy target' },
            { stepIndex: 1, stepKind: 'render', commandKind: undefined, access: 'write', label: 'draw after texture copy render target' },
        ])

        await submitted.done
    })

    it('allows a same-submission copy target to satisfy a later copy source required epoch', async() => {

        const { runtime } = await createRuntimeFixture()
        const firstSource = await createBuffer(runtime, 'copy chain source')
        const firstTarget = await createBuffer(runtime, 'copy chain middle')
        const secondTarget = await createBuffer(runtime, 'copy chain target')
        advanceResourceContentEpochForTest(firstSource)
        const firstCopy = runtime.createCopyCommand({
            label: 'first copy in chain',
            source: copySource(firstSource, 1),
            target: copyDestination(firstTarget),
            whenMissing: 'throw',
        })
        const secondCopy = runtime.createCopyCommand({
            label: 'second copy in chain',
            source: copySource(firstTarget, 1),
            target: copyDestination(secondTarget),
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .copy(firstCopy)
            .copy(secondCopy)
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(firstSource.contentEpoch).to.equal(1)
        expect(firstTarget.contentEpoch).to.equal(1)
        expect(secondTarget.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            label: access.label,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', access: 'read', label: 'copy chain source' },
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', access: 'write', label: 'copy chain middle' },
            { stepIndex: 1, stepKind: 'copy', commandKind: 'copy', access: 'read', label: 'copy chain middle' },
            { stepIndex: 1, stepKind: 'copy', commandKind: 'copy', access: 'write', label: 'copy chain target' },
        ])
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ firstTarget.id, secondTarget.id ])

        await submitted.done
    })

    it('does not let a same-command copy target write satisfy its own source required epoch', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const buffer = await runtime.createBuffer({
            label: 'self copy buffer',
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        advanceResourceContentEpochForTest(buffer)
        const copy = runtime.createCopyCommand({
            label: 'self non-overlap copy',
            source: copySource(buffer, 2, { offset: 0, size: 16 }),
            target: copyDestination(buffer, { offset: 16, size: 16 }),
            whenMissing: 'throw',
        })
        const builder = runtime.createSubmission({ validation: 'throw' })
            .copy(copy)

        await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
            severity: 'error',
            phase: 'submission',
        })

        expect(buffer.contentEpoch).to.equal(1)
        expect(calls.commandEncoders).to.have.length(0)
        expect(calls.copies).to.have.length(0)
        expect(calls.queueSubmissions).to.have.length(0)
    })

    it('records query resolve destination writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const querySet = runtime.createQuerySet({
            label: 'timing queries',
            type: 'timestamp',
            count: 2,
        })
        advanceQuerySlotContentEpochForTest(querySet, 0)
        advanceQuerySlotContentEpochForTest(querySet, 1)
        const destination = await createBuffer(
            runtime,
            'query destination',
            GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC
        )
        const resolve = runtime.createResolveQuerySetCommand({
            label: 'resolve queries',
            source: {
                querySet,
                slots: querySlots([ 0, 1 ], 1),
            },
            destination: destination.region(),
            whenMissing: 'throw',
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
        expect(submitted.resourceAccesses.map(access => access.resourceId)).to.not.include(querySet.id)
        expect(querySet.slots().map(slot => slot.contentEpoch)).to.deep.equal([ 1, 1 ])
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'ready', 'ready' ])
        expect(destination.state).to.equal('ready')
        expect(destination.isReady).to.equal(true)

        await submitted.done
    })

    it('rejects dispatch reads of an empty buffer before creating a command encoder in every validation mode', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const input = await createBuffer(runtime, `empty compute input ${validation}`)
            const output = await createBuffer(runtime, `empty compute output ${validation}`)
            const compute = await createCompute(runtime, input, output)
            const builder = runtime.createSubmission({ validation })
                .compute(compute.pass, [ compute.dispatch ])

            const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
                severity: 'error',
                phase: 'command',
            })

            expect(diagnostic.subject).to.deep.equal(compute.dispatch.subject)
            expect(diagnostic.related).to.deep.include(input.subject)
            expect(diagnostic.related).to.deep.include(compute.pass.subject)
            expect(diagnostic.related).to.deep.include(builder.subject)
            expect(diagnostic.expected).to.deep.equal({ resourceState: 'ready' })
            expect(diagnostic.actual).to.deep.include({
                stepIndex: 0,
                commandId: compute.dispatch.id,
                commandKind: 'dispatch',
                access: 'read',
                resourceId: input.id,
                resourceKind: 'BufferResource',
                resourceState: 'empty',
                contentEpoch: 0,
                allocationVersion: 1,
                whenMissing: 'throw',
            })
            expect(input.contentEpoch).to.equal(0)
            expect(output.contentEpoch).to.equal(0)
            expect(input.state).to.equal('empty')
            expect(output.state).to.equal('empty')
            expect(calls.commandEncoders).to.have.length(0)
            expect(calls.computePasses).to.have.length(0)
            expect(calls.dispatchCalls).to.have.length(0)
            expect(calls.queueSubmissions).to.have.length(0)
        }
    })

    it('does not mutate real resource readiness when a simulated producer precedes a failing read', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const staged = await createBuffer(runtime, 'simulated upload target')
        const input = await createBuffer(runtime, 'failing compute input')
        const output = await createBuffer(runtime, 'failing compute output')
        const upload = runtime.createUploadCommand({
            label: 'simulated upload',
            target: (staged).region(),
            data: new Uint8Array(16),
        })
        const compute = await createCompute(runtime, input, output, 1)
        const builder = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .compute(compute.pass, [ compute.dispatch ])

        await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_COMMAND_RESOURCE_NOT_READY',
            severity: 'error',
            phase: 'command',
        })

        expect(staged.contentEpoch).to.equal(0)
        expect(input.contentEpoch).to.equal(0)
        expect(output.contentEpoch).to.equal(0)
        expect(staged.state).to.equal('empty')
        expect(input.state).to.equal('empty')
        expect(output.state).to.equal('empty')
        expect(calls.queueWrites).to.have.length(0)
        expect(calls.commandEncoders).to.have.length(0)
        expect(calls.computePasses).to.have.length(0)
        expect(calls.queueSubmissions).to.have.length(0)
    })

    it('applies validation mode to dispatch read-before-write diagnostics', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const input = await createBuffer(runtime, `future compute input ${validation}`)
            const output = await createBuffer(runtime, `future compute output ${validation}`)
            advanceResourceContentEpochForTest(input)
            const compute = await createCompute(runtime, input, output, 2)
            const builder = runtime.createSubmission({ validation })
                .compute(compute.pass, [ compute.dispatch ])

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(compute.dispatch.subject)
                expect(diagnostic.related).to.deep.include(input.subject)
                expect(diagnostic.related).to.deep.include(compute.pass.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 2 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 0,
                    commandId: compute.dispatch.id,
                    commandKind: 'dispatch',
                    access: 'read',
                    resourceId: input.id,
                    resourceKind: 'BufferResource',
                    resourceState: 'ready',
                    simulatedContentEpoch: 1,
                    currentContentEpoch: 1,
                    whenMissing: 'throw',
                })
                expect(input.contentEpoch).to.equal(1)
                expect(output.contentEpoch).to.equal(0)
                expect(calls.commandEncoders).to.have.length(0)
                expect(calls.computePasses).to.have.length(0)
                expect(calls.dispatchCalls).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 2 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(input.contentEpoch).to.equal(1)
            expect(output.contentEpoch).to.equal(1)
            expect(calls.computePasses).to.have.length(1)
            expect(calls.dispatchCalls).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('applies validation mode to dispatch stale-read diagnostics without mutating on throw', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const { runtime, calls } = await createRuntimeFixture()
            const input = await createBuffer(runtime, `stale compute input ${validation}`)
            const output = await createBuffer(runtime, `stale compute output ${validation}`)
            advanceResourceContentEpochForTest(input)
            const upload = runtime.createUploadCommand({
                label: 'refresh stale input',
                target: (input).region(),
                data: new Uint8Array(16),
            })
            const compute = await createCompute(runtime, input, output, 1)
            const builder = runtime.createSubmission({ validation })
                .upload(upload)
                .compute(compute.pass, [ compute.dispatch ])

            if (validation === 'throw') {
                const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })

                expect(diagnostic.subject).to.deep.equal(compute.dispatch.subject)
                expect(diagnostic.related).to.deep.include(input.subject)
                expect(diagnostic.related).to.deep.include(compute.pass.subject)
                expect(diagnostic.related).to.deep.include(builder.subject)
                expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
                expect(diagnostic.actual).to.deep.include({
                    stepIndex: 1,
                    commandId: compute.dispatch.id,
                    commandKind: 'dispatch',
                    access: 'read',
                    resourceId: input.id,
                    resourceKind: 'BufferResource',
                    resourceState: 'ready',
                    simulatedContentEpoch: 2,
                    currentContentEpoch: 1,
                    whenMissing: 'throw',
                })
                expect(input.contentEpoch).to.equal(1)
                expect(output.contentEpoch).to.equal(0)
                expect(input.allocationVersion).to.equal(1)
                expect(output.allocationVersion).to.equal(1)
                expect(calls.queueWrites).to.have.length(0)
                expect(calls.commandEncoders).to.have.length(0)
                expect(calls.computePasses).to.have.length(0)
                expect(calls.dispatchCalls).to.have.length(0)
                expect(calls.queueSubmissions).to.have.length(0)
                continue
            }

            const submitted = builder.submit()

            if (validation === 'warn') {
                expect(submitted.diagnostics).to.have.length(1)
                expect(submitted.diagnostics[0]).to.include({
                    code: 'SCRATCH_SUBMISSION_STALE_READ',
                    severity: 'error',
                    phase: 'submission',
                })
                expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: 1 })
            } else {
                expect(submitted.diagnostics).to.deep.equal([])
            }
            expect(input.contentEpoch).to.equal(2)
            expect(output.contentEpoch).to.equal(1)
            expect(calls.queueWrites).to.have.length(1)
            expect(calls.computePasses).to.have.length(1)
            expect(calls.dispatchCalls).to.have.length(1)
            expect(calls.queueSubmissions).to.have.length(1)

            await submitted.done
        }
    })

    it('allows same-submission upload to satisfy a dispatch read requiring the produced epoch', async() => {

        const { runtime } = await createRuntimeFixture()
        const input = await createBuffer(runtime, 'same submission input')
        const output = await createBuffer(runtime, 'same submission output')
        const uploadInput = runtime.createUploadCommand({
            label: 'produce dispatch input',
            target: (input).region(),
            data: new Uint8Array(16),
        })
        const compute = await createCompute(runtime, input, output, 1)
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadInput)
            .compute(compute.pass, [ compute.dispatch ])
            .submit()

        expect(submitted.diagnostics).to.deep.equal([])
        expect(input.contentEpoch).to.equal(1)
        expect(output.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            resourceId: access.resourceId,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                resourceId: input.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'compute',
                commandKind: 'dispatch',
                access: 'read',
                resourceId: input.id,
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'compute',
                commandKind: 'dispatch',
                access: 'write',
                resourceId: output.id,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
        ])

        await submitted.done
    })

    it('records compute dispatch declared reads and writes', async() => {

        const { runtime } = await createRuntimeFixture()
        const input = await createBuffer(runtime, 'compute input')
        const output = await createBuffer(runtime, 'compute output')
        const compute = await createCompute(runtime, input, output, 1)
        const uploadInput = runtime.createUploadCommand({
            label: 'upload compute input',
            target: (input).region(),
            data: new Uint8Array(16),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadInput)
            .compute(compute.pass, [ compute.dispatch ])
            .submit()

        expect(input.state).to.equal('ready')
        expect(output.state).to.equal('ready')
        expect(input.isReady).to.equal(true)
        expect(output.isReady).to.equal(true)
        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadInput.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'compute input',
                subject: input.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'compute',
                commandKind: 'dispatch',
                commandId: compute.dispatch.id,
                passId: compute.pass.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'compute input',
                subject: input.subject,
                access: 'read',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 1,
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
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'compute input',
                subject: input.subject,
                contentEpoch: 1,
                allocationVersion: 1,
                producedBy: {
                    stepIndex: 0,
                    stepKind: 'upload',
                    commandKind: 'upload',
                    commandId: uploadInput.id,
                },
            },
            {
                resourceId: output.id,
                resourceKind: 'BufferResource',
                label: 'compute output',
                subject: output.subject,
                contentEpoch: 1,
                allocationVersion: 1,
                producedBy: {
                    stepIndex: 1,
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
        const target = await createTexture(runtime, 'render target')
        const render = await createRender(runtime, target)
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
        const input = await createBuffer(runtime, 'draw input')
        const output = await createBuffer(runtime, 'draw output')
        const target = await createTexture(runtime, 'draw render target')
        const uploadInput = runtime.createUploadCommand({
            label: 'upload draw input',
            target: (input).region(),
            data: new Uint8Array(16),
        })
        const render = await createRender(runtime, target, {
            read: [ readResource(input, 1) ],
            write: [ output ],
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadInput)
            .render(render.pass, [ render.draw ])
            .submit()

        expect(input.state).to.equal('ready')
        expect(output.state).to.equal('ready')
        expect(target.state).to.equal('ready')
        expect(output.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(accessFacts)).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadInput.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'draw input',
                subject: input.subject,
                access: 'write',
                contentEpochBefore: 0,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: render.draw.id,
                passId: render.pass.id,
                resourceId: input.id,
                resourceKind: 'BufferResource',
                label: 'draw input',
                subject: input.subject,
                access: 'read',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
                allocationVersion: 1,
            },
            {
                stepIndex: 1,
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
                stepIndex: 1,
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
        expect(submitted.producerEpochs.map(epoch => epoch.resourceId)).to.deep.equal([ input.id, output.id, target.id ])

        await submitted.done
    })

    it('preserves deterministic step order for mixed submissions', async() => {

        const { runtime } = await createRuntimeFixture()
        const uploadTarget = await createBuffer(runtime, 'ordered upload target')
        const copyTarget = await createBuffer(runtime, 'ordered copy target')
        const computeOutput = await createBuffer(runtime, 'ordered compute output')
        const renderTarget = await createTexture(runtime, 'ordered render target')
        const upload = runtime.createUploadCommand({
            target: (uploadTarget).region(),
            data: new Uint8Array(16),
        })
        const copy = runtime.createCopyCommand({
            source: copySource(uploadTarget, 1),
            target: copyDestination(copyTarget),
            whenMissing: 'throw',
        })
        const compute = await createCompute(runtime, copyTarget, computeOutput, 1)
        const render = await createRender(runtime, renderTarget, {
            read: [ readResource(computeOutput, 1) ],
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
        const target = await createBuffer(runtime, 'stable allocation target')
        const upload = runtime.createUploadCommand({
            target: target.region(),
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

    it('records replacement allocation facts without rewriting historical work', async() => {

        const { runtime } = await createRuntimeFixture()
        const texture = await createTexture(
            runtime,
            'historical resized texture',
            GPU_TEXTURE_USAGE_COPY_SRC |
                GPU_TEXTURE_USAGE_COPY_DST |
                GPU_TEXTURE_USAGE_TEXTURE_BINDING
        )
        const initialUpload = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const initialWork = runtime.createSubmission({ validation: 'throw' })
            .upload(initialUpload)
            .submit()
        const initialAccessFacts = initialWork.resourceAccesses.map(accessFacts)
        const initialProducerFacts = initialWork.producerEpochs.map(producerFacts)

        await texture.resize([ 4, 2 ])
        expect(texture.contentEpoch).to.equal(1)
        expect(texture.allocationVersion).to.equal(2)
        expect(texture.state).to.equal('empty')

        const readbackBuffer = await runtime.createBuffer({
            label: 'resized texture copy destination',
            size: 512,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const replacementUpload = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array(32),
            layout: { bytesPerRow: 16, rowsPerImage: 2 },
            size: { width: 4, height: 2 },
        })
        const copy = runtime.createCopyCommand({
            source: copySource(texture, 2),
            target: copyDestination(readbackBuffer),
            targetLayout: { bytesPerRow: 256, rowsPerImage: 2 },
            size: { width: 4, height: 2 },
            whenMissing: 'throw',
        })
        const replacementWork = runtime.createSubmission({ validation: 'throw' })
            .upload(replacementUpload)
            .copy(copy)
            .submit()

        expect(initialWork.resourceAccesses.map(accessFacts)).to.deep.equal(initialAccessFacts)
        expect(initialWork.producerEpochs.map(producerFacts)).to.deep.equal(initialProducerFacts)
        expect(initialWork.resourceAccesses[0]).to.include({
            resourceId: texture.id,
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 1,
        })
        expect(initialWork.producerEpochs[0]).to.include({
            resourceId: texture.id,
            contentEpoch: 1,
            allocationVersion: 1,
        })

        const replacementTextureAccesses = replacementWork.resourceAccesses
            .filter(access => access.resourceId === texture.id)
        expect(replacementTextureAccesses.map(access => ({
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
            allocationVersion: access.allocationVersion,
        }))).to.deep.equal([
            {
                access: 'write',
                contentEpochBefore: 1,
                contentEpochAfter: 2,
                allocationVersion: 2,
            },
            {
                access: 'read',
                contentEpochBefore: 2,
                contentEpochAfter: 2,
                allocationVersion: 2,
            },
        ])
        expect(replacementWork.producerEpochs
            .find(epoch => epoch.resourceId === texture.id)).to.include({
                contentEpoch: 2,
                allocationVersion: 2,
            })
        expect(texture.contentEpoch).to.equal(2)
        expect(texture.allocationVersion).to.equal(2)
        expect(texture.state).to.equal('ready')

        await Promise.all([ initialWork.done, replacementWork.done ])
    })

    it('keeps submitted reports compatible with the existing empty report behavior', async() => {

        const { runtime } = await createRuntimeFixture()
        const target = await createBuffer(runtime, 'reported target')
        const upload = runtime.createUploadCommand({
            target: target.region(),
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
        const target = await createBuffer(runtime, 'immutable target')
        const upload = runtime.createUploadCommand({
            target: target.region(),
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
