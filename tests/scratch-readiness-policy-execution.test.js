import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_STORAGE = 0x80

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
})
