import { expect } from 'chai'
import {
    BeginOcclusionQueryCommand,
    BindSet,
    EndOcclusionQueryCommand,
    QuerySetResource,
    ReadbackOperation,
    ResolveQuerySetCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_BUFFER_USAGE_UNIFORM = 0x40
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createOcclusionFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const querySet = runtime.createQuerySet({
        label: 'visibility queries',
        type: 'occlusion',
        count: 4,
    })
    const destination = runtime.createBuffer({
        label: 'visibility resolve destination',
        size: 512,
        usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_UNIFORM,
    })
    const target = runtime.createTexture({
        label: 'visibility render target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pass = runtime.createRenderPass({
        label: 'visibility pass',
        color: [ {
            target,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
        occlusionQuerySet: querySet,
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        targets: [ { format: target.format } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        whenMissing: 'throw',
    })
    const begin = runtime.createBeginOcclusionQueryCommand({
        label: 'begin tile visibility',
        querySet,
        index: 2,
    })
    const end = runtime.createEndOcclusionQueryCommand({
        label: 'end tile visibility',
    })
    const resolve = runtime.createResolveQuerySetCommand({
        label: 'resolve tile visibility',
        querySet,
        firstQuery: 2,
        queryCount: 1,
        destination,
        destinationOffset: 0,
    })
    const bindLayout = runtime.createBindLayout({
        label: 'visibility destination bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'visibilityUniforms',
                type: 'uniform',
                visibility: [ 'vertex' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        visibilityUniforms: destination,
    }, {
        label: 'visibility destination bind set',
    })

    return { ...fake, runtime, querySet, destination, target, pass, program, pipeline, draw, begin, end, resolve, bindLayout, bindSet }
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

describe('scratch occlusion query bracket commands', () => {

    it('creates public begin/end commands and lowers render pass occlusionQuerySet', async() => {

        const fixture = await createOcclusionFixture()
        const descriptor = fixture.pass.createRenderPassDescriptor()

        expect(fixture.querySet).to.be.instanceOf(QuerySetResource)
        expect(fixture.querySet.type).to.equal('occlusion')
        expect(fixture.begin).to.be.instanceOf(BeginOcclusionQueryCommand)
        expect(fixture.begin.commandKind).to.equal('begin-occlusion-query')
        expect(fixture.begin.querySet).to.equal(fixture.querySet)
        expect(fixture.begin.index).to.equal(2)
        expect(fixture.end).to.be.instanceOf(EndOcclusionQueryCommand)
        expect(fixture.end.commandKind).to.equal('end-occlusion-query')
        expect(fixture.runtime.beginOcclusionQueryCommand({
            querySet: fixture.querySet,
            index: 1,
        })).to.be.instanceOf(BeginOcclusionQueryCommand)
        expect(fixture.runtime.endOcclusionQueryCommand()).to.be.instanceOf(EndOcclusionQueryCommand)
        expect(fixture.pass.occlusionQuerySet).to.equal(fixture.querySet)
        expect(descriptor.occlusionQuerySet).to.equal(fixture.querySet.gpuQuerySet)
    })

    it('records begin, draw, and end in explicit render command order', async() => {

        const fixture = await createOcclusionFixture()
        const queryAllocationVersion = fixture.querySet.allocationVersion

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.begin, fixture.draw, fixture.end ])
            .submit()

        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.renderPasses[0].descriptor.occlusionQuerySet).to.equal(fixture.querySet.gpuQuerySet)
        expect(fixture.calls.renderPasses[0].actions.map((action) => action.type)).to.deep.equal([
            'beginOcclusionQuery',
            'setPipeline',
            'draw',
            'endOcclusionQuery',
            'end',
        ])
        expect(fixture.calls.occlusionQueries).to.deep.equal([
            { type: 'begin', queryIndex: 2 },
            { type: 'end' },
        ])
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 1, 0 ])
        expect(fixture.querySet.allocationVersion).to.equal(queryAllocationVersion)

        await submitted.done
    })

    it('keeps occlusion results GPU-side until explicit resolve and readback', async() => {

        const fixture = await createOcclusionFixture()
        fixture.querySet.gpuQuerySet.values[2] = 1n

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.begin, fixture.draw, fixture.end ])
            .resolve(fixture.resolve)
            .submit()
        const readback = fixture.runtime.createReadback({
            label: 'read resolved visibility',
            source: fixture.destination,
            after: submitted,
            range: { offset: 0, byteLength: 8 },
        })
        const bytes = await readback.toBytes()
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

        expect(fixture.resolve).to.be.instanceOf(ResolveQuerySetCommand)
        expect(readback).to.be.instanceOf(ReadbackOperation)
        expect(fixture.calls.resolveQueries).to.deep.equal([
            {
                querySet: fixture.querySet.gpuQuerySet,
                firstQuery: 2,
                queryCount: 1,
                destination: fixture.destination.gpuBuffer,
                destinationOffset: 0,
            },
        ])
        expect(view.getBigUint64(0, true)).to.equal(1n)
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 1, 0 ])
        expect(fixture.destination.contentEpoch).to.equal(1)
        expect(readback.state).to.equal('consumed')
    })

    it('does not rebuild BindSet only because a resolved occlusion buffer contentEpoch changes', async() => {

        const fixture = await createOcclusionFixture()
        const firstBindGroup = fixture.bindSet.getBindGroup()

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ fixture.begin, fixture.draw, fixture.end ])
            .resolve(fixture.resolve)
            .submit()

        expect(fixture.destination.contentEpoch).to.equal(1)
        expect(fixture.bindSet.getBindGroup()).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects invalid render pass occlusionQuerySet descriptors with structured diagnostics', async() => {

        const fixtureA = await createOcclusionFixture()
        const fixtureB = await createOcclusionFixture()
        const timestampQueries = fixtureA.runtime.createQuerySet({
            type: 'timestamp',
            count: 1,
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ {
                target: fixtureA.target,
                load: 'clear',
                store: 'store',
            } ],
            occlusionQuerySet: {},
        }), {
            code: 'SCRATCH_PASS_OCCLUSION_QUERY_SET_INVALID',
            severity: 'error',
            phase: 'submission',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ {
                target: fixtureA.target,
                load: 'clear',
                store: 'store',
            } ],
            occlusionQuerySet: fixtureB.querySet,
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureB.querySet.dispose()

        await expectScratchDiagnostic(() => fixtureB.runtime.createRenderPass({
            color: [ {
                target: fixtureB.target,
                load: 'clear',
                store: 'store',
            } ],
            occlusionQuerySet: fixtureB.querySet,
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createRenderPass({
            color: [ {
                target: fixtureA.target,
                load: 'clear',
                store: 'store',
            } ],
            occlusionQuerySet: timestampQueries,
        }), {
            code: 'SCRATCH_PASS_OCCLUSION_QUERY_SET_INVALID',
            severity: 'error',
            phase: 'submission',
        })
    })

    it('rejects invalid begin command descriptors with structured diagnostics', async() => {

        const fixtureA = await createOcclusionFixture()
        const fixtureB = await createOcclusionFixture()
        const timestampQueries = fixtureA.runtime.createQuerySet({
            type: 'timestamp',
            count: 4,
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createBeginOcclusionQueryCommand({
            querySet: {},
            index: 0,
        }), {
            code: 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createBeginOcclusionQueryCommand({
            querySet: fixtureB.querySet,
            index: 0,
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureB.querySet.dispose()

        await expectScratchDiagnostic(() => fixtureB.runtime.createBeginOcclusionQueryCommand({
            querySet: fixtureB.querySet,
            index: 0,
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createBeginOcclusionQueryCommand({
            querySet: timestampQueries,
            index: 0,
        }), {
            code: 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID',
            severity: 'error',
            phase: 'command',
        })

        for (const index of [ -1, 1.5, 4 ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createBeginOcclusionQueryCommand({
                querySet: fixtureA.querySet,
                index,
            }), {
                code: 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }
    })

    it('rejects invalid render submission occlusion ordering with structured diagnostics', async() => {

        const fixture = await createOcclusionFixture()
        const passWithoutOcclusion = fixture.runtime.createRenderPass({
            color: [ {
                target: fixture.target,
                load: 'clear',
                store: 'store',
            } ],
        })
        const otherQuerySet = fixture.runtime.createQuerySet({
            type: 'occlusion',
            count: 4,
        })
        const otherBegin = fixture.runtime.createBeginOcclusionQueryCommand({
            querySet: otherQuerySet,
            index: 0,
        })

        for (const commands of [
            [ fixture.end ],
            [ fixture.begin, fixture.begin, fixture.end ],
            [ fixture.begin, fixture.end, fixture.begin, fixture.end ],
            [ fixture.begin ],
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
                .render(fixture.pass, commands)
                .submit(), {
                code: 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(passWithoutOcclusion, [ fixture.begin, fixture.end ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID',
            severity: 'error',
            phase: 'submission',
        })

        await expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ otherBegin, fixture.end ])
            .submit(), {
            code: 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID',
            severity: 'error',
            phase: 'submission',
        })

        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 0, 0 ])
        expect(fixture.calls.renderPasses).to.have.length(0)
    })

    it('rejects occlusion query brackets outside render command streams', async() => {

        const fixtureA = await createOcclusionFixture()
        const fixtureB = await createOcclusionFixture()
        const computePass = fixtureA.runtime.createComputePass()

        for (const command of [ fixtureA.begin, fixtureA.end ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
                .compute(computePass, [ command ])
                .submit(), {
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
            })
        }

        for (const [ step, command ] of [
            [ 'upload', fixtureA.begin ],
            [ 'upload', fixtureA.end ],
            [ 'copy', fixtureA.begin ],
            [ 'copy', fixtureA.end ],
            [ 'resolve', fixtureA.begin ],
            [ 'resolve', fixtureA.end ],
        ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })[step](command).submit(), {
                code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
                severity: 'error',
                phase: 'submission',
            })
        }

        fixtureA.end.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .render(fixtureA.pass, [ fixtureA.end ])
            .submit(), {
            code: 'SCRATCH_COMMAND_DISPOSED',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .render(fixtureA.pass, [ fixtureB.end ])
            .submit(), {
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
        })
    })
})
