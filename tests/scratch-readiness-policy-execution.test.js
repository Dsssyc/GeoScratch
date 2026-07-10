import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createRenderFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })

    return { ...fake, runtime, pipeline }
}

async function createComputeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = runtime.createComputePipeline({
        program,
        compute: 'csMain',
    })

    return { ...fake, runtime, pipeline }
}

async function createRenderSkipPassFixture() {

    const fixture = await createRenderFixture()
    const colorTarget = fixture.runtime.createTexture({
        label: 'skipped color target',
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const depthTarget = fixture.runtime.createTexture({
        label: 'skipped depth target',
        size: { width: 4, height: 4 },
        format: 'depth24plus',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const timestampQuerySet = fixture.runtime.createQuerySet({
        label: 'skipped timestamps',
        type: 'timestamp',
        count: 2,
    })
    const occlusionQuerySet = fixture.runtime.createQuerySet({
        label: 'skipped occlusion',
        type: 'occlusion',
        count: 2,
    })
    const pass = fixture.runtime.createRenderPass({
        label: 'transactional skipped render pass',
        color: [ {
            target: colorTarget,
            load: 'clear',
            store: 'store',
            clear: [ 0.1, 0.2, 0.3, 1 ],
        } ],
        depth: {
            target: depthTarget,
            depthLoad: 'clear',
            depthStore: 'store',
            depthClear: 1,
        },
        timestampWrites: {
            querySet: timestampQuerySet,
            begin: 0,
            end: 1,
        },
        occlusionQuerySet,
    })
    const missing = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
    const draw = createDraw(fixture)
    const trigger = createDraw(fixture, {
        resources: {
            read: [ { resource: missing, contentEpoch: 0 } ],
            write: [],
        },
        whenMissing: 'skip-pass',
    })
    const begin = fixture.runtime.createBeginOcclusionQueryCommand({
        querySet: occlusionQuerySet,
        index: 1,
    })
    const end = fixture.runtime.createEndOcclusionQueryCommand()

    return {
        ...fixture,
        colorTarget,
        depthTarget,
        timestampQuerySet,
        occlusionQuerySet,
        pass,
        missing,
        draw,
        trigger,
        commands: [ begin, draw, end, trigger ],
    }
}

function createDraw(fixture, descriptor = {}) {

    return fixture.runtime.createDrawCommand({
        pipeline: fixture.pipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
        ...descriptor,
    })
}

function createDispatch(fixture, descriptor = {}) {

    return fixture.runtime.createDispatchCommand({
        pipeline: fixture.pipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
        ...descriptor,
    })
}

async function expectDiagnostic(action, code) {

    try {
        action()
        throw new Error(`expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({ code, severity: 'error' })
        return error.diagnostic
    }
}

describe('scratch readiness policy execution', () => {

    it('rejects missing and forbidden fallback descriptor shapes at runtime', async() => {

        const fixture = await createRenderFixture()
        const fallback = createDraw(fixture)

        const missing = await expectDiagnostic(() => createDraw(fixture, {
            whenMissing: 'use-fallback',
        }), 'SCRATCH_COMMAND_READINESS_POLICY_MISSING')
        expect(missing.actual).to.deep.include({ whenMissing: 'use-fallback' })
        expect(missing.subject).to.deep.include({ kind: 'Command', commandKind: 'draw' })
        expect(missing.expected).to.deep.include({ whenMissing: 'use-fallback', fallback: 'DrawCommand' })

        const forbidden = await expectDiagnostic(() => createDraw(fixture, {
            whenMissing: 'skip-command',
            fallback,
        }), 'SCRATCH_COMMAND_READINESS_POLICY_MISSING')
        expect(forbidden.actual).to.deep.include({ whenMissing: 'skip-command' })
        expect(forbidden.related).to.deep.include(fallback.subject)
    })

    it('rejects fallback commands with the wrong kind, runtime, or lifecycle', async() => {

        const render = await createRenderFixture()
        const compute = await createComputeFixture()
        const otherRender = await createRenderFixture()
        const dispatch = createDispatch(compute)
        const wrongRuntime = createDraw(otherRender)
        const disposed = createDraw(render)
        disposed.dispose()

        for (const [ fallback, reason ] of [
            [ dispatch, 'commandKind' ],
            [ wrongRuntime, 'runtime' ],
            [ disposed, 'disposed' ],
        ]) {
            const diagnostic = await expectDiagnostic(() => createDraw(render, {
                whenMissing: 'use-fallback',
                fallback,
            }), 'SCRATCH_COMMAND_FALLBACK_INVALID')
            expect(diagnostic.actual).to.deep.include({ reason })
            expect(diagnostic.subject).to.deep.include({ kind: 'Command', commandKind: 'draw' })
            expect(diagnostic.expected).to.include({ commandKind: 'draw', runtimeId: render.runtime.id })
            expect(diagnostic.related).to.deep.include(fallback.subject)
        }
    })

    it('compares fallback writes as identity sets rather than array order', async() => {

        const fixture = await createRenderFixture()
        const first = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const second = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const fallback = createDraw(fixture, {
            resources: { read: [], write: [ second, first ] },
        })
        const command = createDraw(fixture, {
            resources: { read: [], write: [ first, second ] },
            whenMissing: 'use-fallback',
            fallback,
        })

        expect(command.fallback).to.equal(fallback)
    })

    it('rejects fallback write-set mismatches and self references', async() => {

        const fixture = await createRenderFixture()
        const primaryWrite = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const fallbackWrite = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const mismatched = createDraw(fixture, {
            resources: { read: [], write: [ fallbackWrite ] },
        })

        const mismatch = await expectDiagnostic(() => createDraw(fixture, {
            resources: { read: [], write: [ primaryWrite ] },
            whenMissing: 'use-fallback',
            fallback: mismatched,
        }), 'SCRATCH_COMMAND_FALLBACK_INVALID')
        expect(mismatch.actual).to.deep.include({ reason: 'writes' })

        const leaf = createDraw(fixture)
        let cycle
        cycle = new Proxy(leaf, {
            get(target, property) {
                if (property === 'fallback') return cycle
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
            },
        })

        const repeated = await expectDiagnostic(() => createDraw(fixture, {
            whenMissing: 'use-fallback',
            fallback: cycle,
        }), 'SCRATCH_COMMAND_FALLBACK_INVALID')
        expect(repeated.actual).to.deep.include({ reason: 'cycle' })
    })

    it('rejects repeated nodes in a forged fallback chain', async() => {

        const fixture = await createRenderFixture()
        const first = {
            commandKind: 'draw',
            runtime: fixture.runtime,
            isDisposed: false,
            resources: { write: [] },
            whenMissing: 'use-fallback',
            subject: { kind: 'Command', id: 'forged-first', commandKind: 'draw' },
        }
        const second = {
            commandKind: 'draw',
            runtime: fixture.runtime,
            isDisposed: false,
            resources: { write: [] },
            whenMissing: 'use-fallback',
            subject: { kind: 'Command', id: 'forged-second', commandKind: 'draw' },
        }
        first.fallback = second
        second.fallback = first

        const repeated = await expectDiagnostic(() => createDraw(fixture, {
            whenMissing: 'use-fallback',
            fallback: first,
        }), 'SCRATCH_COMMAND_FALLBACK_INVALID')
        expect(repeated.actual).to.deep.include({ reason: 'cycle' })
    })

    it('locks fallback references after command construction', async() => {

        const fixture = await createRenderFixture()
        const fallback = createDraw(fixture)
        const command = createDraw(fixture, {
            whenMissing: 'use-fallback',
            fallback,
        })

        expect(command.fallback).to.equal(fallback)
        expect(() => { command.fallback = undefined }).to.throw(TypeError)
        expect(command.fallback).to.equal(fallback)
    })

    it('omits skip-command GPU and resource facts in every validation mode', async() => {

        for (const validation of [ 'off', 'warn', 'throw' ]) {
            const fixture = await createComputeFixture()
            const input = fixture.runtime.createBuffer({
                label: `empty input ${validation}`,
                size: 16,
                usage: GPU_BUFFER_USAGE_STORAGE,
            })
            const output = fixture.runtime.createBuffer({
                label: `skipped output ${validation}`,
                size: 16,
                usage: GPU_BUFFER_USAGE_STORAGE,
            })
            const command = createDispatch(fixture, {
                resources: {
                    read: [ { resource: input, contentEpoch: 7 } ],
                    write: [ output ],
                },
                whenMissing: 'skip-command',
            })
            const pass = fixture.runtime.createComputePass()
            const submitted = fixture.runtime.createSubmission({ validation })
                .compute(pass, [ command ])
                .submit()

            expect(fixture.calls.computePasses).to.have.length(0)
            expect(fixture.calls.dispatchCalls).to.have.length(0)
            expect(submitted.resourceAccesses).to.deep.equal([])
            expect(submitted.producerEpochs).to.deep.equal([])
            expect(submitted.diagnostics).to.deep.equal([])
            expect(input.state).to.equal('empty')
            expect(input.contentEpoch).to.equal(0)
            expect(output.state).to.equal('empty')
            expect(output.contentEpoch).to.equal(0)
        }
    })

    it('leaves skipped producer output empty for downstream policy resolution', async() => {

        const fixture = await createComputeFixture()
        const input = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const intermediate = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const output = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const skippedProducer = createDispatch(fixture, {
            resources: {
                read: [ { resource: input, contentEpoch: 0 } ],
                write: [ intermediate ],
            },
            whenMissing: 'skip-command',
        })
        const strictConsumer = createDispatch(fixture, {
            resources: {
                read: [ { resource: intermediate, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'throw',
        })
        const pass = fixture.runtime.createComputePass()

        const diagnostic = await expectDiagnostic(() => fixture.runtime.createSubmission({ validation: 'off' })
            .compute(pass, [ skippedProducer, strictConsumer ])
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')

        expect(diagnostic.subject).to.deep.equal(strictConsumer.subject)
        expect(diagnostic.actual).to.deep.include({
            commandId: strictConsumer.id,
            resourceId: intermediate.id,
            resourceState: 'empty',
            whenMissing: 'throw',
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.computePasses).to.have.length(0)
        expect(fixture.calls.dispatchCalls).to.have.length(0)
        expect(intermediate.state).to.equal('empty')
        expect(intermediate.contentEpoch).to.equal(0)
        expect(output.state).to.equal('empty')
        expect(output.contentEpoch).to.equal(0)
    })

    it('rolls back an entire compute pass when a later command selects skip-pass', async() => {

        const fixture = await createComputeFixture()
        const missing = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const staleInput = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const staged = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const discarded = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const downstream = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        staleInput._advanceContentEpoch()
        const earlierProducer = createDispatch(fixture, {
            resources: {
                read: [ { resource: staleInput, contentEpoch: 0 } ],
                write: [ staged ],
            },
        })
        const trigger = createDispatch(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [ discarded ],
            },
            whenMissing: 'skip-pass',
        })
        const downstreamConsumer = createDispatch(fixture, {
            resources: {
                read: [ { resource: staged, contentEpoch: 1 } ],
                write: [ downstream ],
            },
            whenMissing: 'skip-command',
        })
        const skippedPass = fixture.runtime.createComputePass()
        const downstreamPass = fixture.runtime.createComputePass()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(skippedPass, [ earlierProducer, trigger ])
            .compute(downstreamPass, [ downstreamConsumer ])
            .submit()

        expect(fixture.calls.computePasses).to.have.length(0)
        expect(fixture.calls.dispatchCalls).to.have.length(0)
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(submitted.diagnostics).to.deep.equal([])
        for (const resource of [ missing, staged, discarded, downstream ]) {
            expect(resource.state).to.equal('empty')
            expect(resource.contentEpoch).to.equal(0)
        }
        expect(staleInput.state).to.equal('ready')
        expect(staleInput.contentEpoch).to.equal(1)
    })

    it('keeps render attachment side effects when every draw uses skip-command', async() => {

        const fixture = await createRenderFixture()
        const target = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const missing = fixture.runtime.createBuffer({ size: 16, usage: GPU_BUFFER_USAGE_STORAGE })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const skipped = createDraw(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [],
            },
            whenMissing: 'skip-command',
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ skipped ])
            .submit()

        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(submitted.resourceAccesses[0]).to.include({ resourceId: target.id, access: 'write' })
        expect(submitted.producerEpochs).to.have.length(1)
    })

    it('removes render attachments, timestamps, and occlusion writes for skip-pass', async() => {

        const fixture = await createRenderSkipPassFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, fixture.commands)
            .submit()

        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
        expect(fixture.calls.occlusionQueries).to.have.length(0)
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(fixture.colorTarget.state).to.equal('empty')
        expect(fixture.colorTarget.contentEpoch).to.equal(0)
        expect(fixture.depthTarget.state).to.equal('empty')
        expect(fixture.depthTarget.contentEpoch).to.equal(0)
        expect(fixture.timestampQuerySet.slotStates).to.deep.equal([ 'empty', 'empty' ])
        expect(fixture.timestampQuerySet.slotContentEpochs).to.deep.equal([ 0, 0 ])
        expect(fixture.occlusionQuerySet.slotStates).to.deep.equal([ 'empty', 'empty' ])
        expect(fixture.occlusionQuerySet.slotContentEpochs).to.deep.equal([ 0, 0 ])
    })

    it('does not expose skipped render query writes to later resolve steps', async() => {

        for (const queryKind of [ 'timestamp', 'occlusion' ]) {
            const fixture = await createRenderSkipPassFixture()
            const querySet = queryKind === 'timestamp'
                ? fixture.timestampQuerySet
                : fixture.occlusionQuerySet
            const index = queryKind === 'timestamp' ? 0 : 1
            const destination = fixture.runtime.createBuffer({
                size: 16,
                usage: GPU_BUFFER_USAGE_QUERY_RESOLVE,
            })
            const resolve = fixture.runtime.createResolveQuerySetCommand({
                source: {
                    querySet,
                    slots: [ { index, contentEpoch: 1 } ],
                },
                destination,
                whenMissing: 'throw',
            })
            const builder = fixture.runtime.createSubmission({ validation: 'off' })
                .render(fixture.pass, fixture.commands)
                .resolve(resolve)

            const diagnostic = await expectDiagnostic(
                () => builder.submit(),
                'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE'
            )

            expect(diagnostic.subject).to.deep.equal(resolve.subject)
            expect(diagnostic.actual).to.deep.include({
                querySetId: querySet.id,
                slotIndex: index,
                simulatedSlotState: 'empty',
            })
            expect(fixture.calls.commandEncoders).to.have.length(0)
            expect(fixture.calls.renderPasses).to.have.length(0)
            expect(fixture.calls.resolveQueries).to.have.length(0)
            expect(destination.state).to.equal('empty')
        }
    })

    it('does not expose skipped render attachment writes to later draws', async() => {

        const fixture = await createRenderSkipPassFixture()
        const downstreamTarget = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const downstreamPass = fixture.runtime.createRenderPass({
            color: [ {
                target: downstreamTarget,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const consumer = createDraw(fixture, {
            resources: {
                read: [ { resource: fixture.colorTarget, contentEpoch: 1 } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const builder = fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, fixture.commands)
            .render(downstreamPass, [ consumer ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_COMMAND_RESOURCE_NOT_READY'
        )

        expect(diagnostic.subject).to.deep.equal(consumer.subject)
        expect(diagnostic.actual).to.deep.include({
            resourceId: fixture.colorTarget.id,
            resourceState: 'empty',
            simulatedContentEpoch: 0,
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(downstreamTarget.state).to.equal('empty')
    })
})
