import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

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
    const pass = runtime.createComputePass()

    return { ...fake, runtime, pipeline, pass }
}

async function createRenderFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
    const pipeline = runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const target = runtime.createTexture({
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pass = runtime.createRenderPass({
        color: [ {
            target,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })

    return { ...fake, runtime, program, pipeline, target, pass }
}

function createBuffer(fixture, label) {

    return fixture.runtime.createBuffer({
        label,
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
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

function createDraw(fixture, descriptor = {}) {

    return fixture.runtime.createDrawCommand({
        pipeline: fixture.pipeline,
        count: { vertexCount: 3 },
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

function passOutcome(submitted) {

    return submitted.executionOutcomes.find(outcome => outcome.outcomeKind === 'pass')
}

function commandOutcomes(submitted) {

    return submitted.executionOutcomes.filter(outcome => outcome.outcomeKind === 'command')
}

describe('scratch readiness fallback execution outcomes', () => {

    it('records a ready primary as directly executed', async() => {

        const fixture = await createComputeFixture()
        const output = createBuffer(fixture, 'direct output')
        const command = createDispatch(fixture, {
            resources: { read: [], write: [ output ] },
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [ command ])
            .submit()

        expect(passOutcome(submitted)).to.deep.include({
            status: 'executed',
            requestedCommandIds: [ command.id ],
            encodedCommandIds: [ command.id ],
        })
        expect(commandOutcomes(submitted)[0]).to.deep.include({
            requestedCommandId: command.id,
            status: 'executed',
            executedCommandId: command.id,
        })
        expect(commandOutcomes(submitted)[0].attempts).to.deep.equal([ {
            commandId: command.id,
            commandKind: 'dispatch',
            policy: 'throw',
            missing: [],
        } ])
        expect(submitted.resourceAccesses[0]).to.include({
            commandId: command.id,
            resourceId: output.id,
            access: 'write',
        })
        expect(submitted.producerEpochs[0].producedBy.commandId).to.equal(command.id)
    })

    it('selects a ready draw fallback for the render encoder', async() => {

        const fixture = await createRenderFixture()
        const missing = createBuffer(fixture, 'missing draw input')
        const fallback = createDraw(fixture)
        const primary = createDraw(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ primary ])
            .submit()

        expect(fixture.calls.drawCalls).to.have.length(1)
        expect(passOutcome(submitted)).to.deep.include({
            status: 'executed',
            requestedCommandIds: [ primary.id ],
            encodedCommandIds: [ fallback.id ],
        })
        expect(commandOutcomes(submitted)[0]).to.deep.include({
            requestedCommandId: primary.id,
            requestedCommandKind: 'draw',
            status: 'fallback-executed',
            executedCommandId: fallback.id,
        })
        expect(submitted.resourceAccesses.map(access => access.commandId).filter(Boolean)).to.not.include(primary.id)
        expect(submitted.resourceAccesses.map(access => access.commandId).filter(Boolean)).to.not.include(fallback.id)
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(submitted.resourceAccesses[0]).to.include({ resourceId: fixture.target.id, access: 'write' })
    })

    it('executes only the final command in a multi-level fallback chain', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'missing primary input')
        const secondaryInput = createBuffer(fixture, 'missing secondary input')
        const output = createBuffer(fixture, 'fallback output')
        const leaf = createDispatch(fixture, {
            label: 'ready leaf',
            resources: { read: [], write: [ output ] },
        })
        const secondary = createDispatch(fixture, {
            label: 'secondary fallback',
            resources: {
                read: [ { resource: secondaryInput, contentEpoch: 4 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback: leaf,
        })
        const primary = createDispatch(fixture, {
            label: 'primary request',
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 3 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback: secondary,
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ primary ])
            .submit()

        expect(fixture.calls.dispatchCalls).to.have.length(1)
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(submitted.resourceAccesses[0]).to.include({
            commandId: leaf.id,
            resourceId: output.id,
            access: 'write',
        })
        expect(submitted.producerEpochs).to.have.length(1)
        expect(submitted.producerEpochs[0].producedBy.commandId).to.equal(leaf.id)
        expect(output.contentEpoch).to.equal(1)

        expect(passOutcome(submitted)).to.deep.include({
            outcomeKind: 'pass',
            stepIndex: 0,
            stepKind: 'compute',
            passId: fixture.pass.id,
            status: 'executed',
            requestedCommandIds: [ primary.id ],
            encodedCommandIds: [ leaf.id ],
        })
        const [ outcome ] = commandOutcomes(submitted)
        expect(outcome).to.deep.include({
            outcomeKind: 'command',
            stepIndex: 0,
            stepKind: 'compute',
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            requestedCommandKind: 'dispatch',
            status: 'fallback-executed',
            executedCommandId: leaf.id,
        })
        expect(outcome.attempts.map(attempt => ({
            commandId: attempt.commandId,
            policy: attempt.policy,
            missingIds: attempt.missing.map(missing => missing.resourceId),
        }))).to.deep.equal([
            { commandId: primary.id, policy: 'use-fallback', missingIds: [ primaryInput.id ] },
            { commandId: secondary.id, policy: 'use-fallback', missingIds: [ secondaryInput.id ] },
            { commandId: leaf.id, policy: 'throw', missingIds: [] },
        ])
        expect(outcome.attempts[0].missing[0]).to.deep.include({
            resourceId: primaryInput.id,
            resourceKind: 'BufferResource',
            label: 'missing primary input',
            subject: primaryInput.subject,
            requiredContentEpoch: 3,
            simulatedState: 'empty',
            simulatedContentEpoch: 0,
            allocationVersion: 1,
        })

        expect(Object.isFrozen(submitted.executionOutcomes)).to.equal(true)
        expect(Object.isFrozen(passOutcome(submitted))).to.equal(true)
        expect(Object.isFrozen(passOutcome(submitted).requestedCommandIds)).to.equal(true)
        expect(Object.isFrozen(passOutcome(submitted).encodedCommandIds)).to.equal(true)
        expect(Object.isFrozen(outcome)).to.equal(true)
        expect(Object.isFrozen(outcome.attempts)).to.equal(true)
        expect(Object.isFrozen(outcome.attempts[0])).to.equal(true)
        expect(Object.isFrozen(outcome.attempts[0].missing)).to.equal(true)
        expect(Object.isFrozen(outcome.attempts[0].missing[0])).to.equal(true)
        expect(Object.isFrozen(outcome.attempts[0].missing[0].subject)).to.equal(true)
        expect(() => submitted.executionOutcomes.push(outcome)).to.throw(TypeError)
        expect(() => { submitted.executionOutcomes = [] }).to.throw(TypeError)
        expect(() => outcome.attempts.push(outcome.attempts[0])).to.throw(TypeError)
    })

    it('records fallback-to-skip-command without GPU or resource facts', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        const fallbackInput = createBuffer(fixture, 'fallback input')
        const output = createBuffer(fixture, 'skipped output')
        const fallback = createDispatch(fixture, {
            resources: {
                read: [ { resource: fallbackInput, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'skip-command',
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'warn' })
            .compute(fixture.pass, [ primary ])
            .submit()

        expect(fixture.calls.computePasses).to.have.length(0)
        expect(fixture.calls.dispatchCalls).to.have.length(0)
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(submitted.diagnostics).to.deep.equal([])
        expect(passOutcome(submitted)).to.deep.include({
            status: 'skipped-empty',
            requestedCommandIds: [ primary.id ],
            encodedCommandIds: [],
        })
        expect(commandOutcomes(submitted)[0]).to.deep.include({
            requestedCommandId: primary.id,
            status: 'skipped-command',
        })
        expect(commandOutcomes(submitted)[0]).to.not.have.property('executedCommandId')
        expect(commandOutcomes(submitted)[0].attempts.map(attempt => attempt.commandId)).to.deep.equal([
            primary.id,
            fallback.id,
        ])
        expect(output.state).to.equal('empty')
        expect(output.contentEpoch).to.equal(0)
    })

    it('turns every command outcome into skipped-pass when a fallback triggers it', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        const fallbackInput = createBuffer(fixture, 'fallback input')
        const earlierOutput = createBuffer(fixture, 'rolled back earlier output')
        const fallbackOutput = createBuffer(fixture, 'rolled back fallback output')
        const trailingOutput = createBuffer(fixture, 'unattempted trailing output')
        const earlier = createDispatch(fixture, {
            resources: { read: [], write: [ earlierOutput ] },
        })
        const fallback = createDispatch(fixture, {
            resources: {
                read: [ { resource: fallbackInput, contentEpoch: 0 } ],
                write: [ fallbackOutput ],
            },
            whenMissing: 'skip-pass',
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 0 } ],
                write: [ fallbackOutput ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const trailing = createDispatch(fixture, {
            resources: { read: [], write: [ trailingOutput ] },
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [ earlier, primary, trailing ])
            .submit()

        expect(fixture.calls.computePasses).to.have.length(0)
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(passOutcome(submitted)).to.deep.include({
            status: 'skipped-pass',
            triggerCommandId: fallback.id,
            requestedCommandIds: [ earlier.id, primary.id, trailing.id ],
            encodedCommandIds: [],
        })
        expect(commandOutcomes(submitted).map(outcome => ({
            requestedCommandId: outcome.requestedCommandId,
            status: outcome.status,
            hasExecutedCommandId: Object.hasOwn(outcome, 'executedCommandId'),
        }))).to.deep.equal([
            { requestedCommandId: earlier.id, status: 'skipped-pass', hasExecutedCommandId: false },
            { requestedCommandId: primary.id, status: 'skipped-pass', hasExecutedCommandId: false },
            { requestedCommandId: trailing.id, status: 'skipped-pass', hasExecutedCommandId: false },
        ])
        expect(commandOutcomes(submitted)[1].attempts.map(attempt => attempt.commandId)).to.deep.equal([
            primary.id,
            fallback.id,
        ])
        expect(commandOutcomes(submitted)[2].attempts).to.deep.equal([])
        expect(earlierOutput.state).to.equal('empty')
        expect(fallbackOutput.state).to.equal('empty')
        expect(trailingOutput.state).to.equal('empty')
    })

    it('keeps fallback-to-throw hard and reports the attempted chain', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        const fallbackInput = createBuffer(fixture, 'fallback input')
        const output = createBuffer(fixture, 'output')
        const fallback = createDispatch(fixture, {
            resources: {
                read: [ { resource: fallbackInput, contentEpoch: 5 } ],
                write: [ output ],
            },
            whenMissing: 'throw',
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 4 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const builder = fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_COMMAND_RESOURCE_NOT_READY'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(primary.subject)
        expect(diagnostic.related).to.deep.include(primaryInput.subject)
        expect(diagnostic.related).to.deep.include(fallbackInput.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            commandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            resourceId: fallbackInput.id,
            requiredContentEpoch: 5,
            validation: 'off',
        })
        expect(diagnostic.actual.attempts.map(attempt => ({
            commandId: attempt.commandId,
            policy: attempt.policy,
            missingIds: attempt.missing.map(missing => missing.resourceId),
        }))).to.deep.equal([
            { commandId: primary.id, policy: 'use-fallback', missingIds: [ primaryInput.id ] },
            { commandId: fallback.id, policy: 'throw', missingIds: [ fallbackInput.id ] },
        ])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(output.state).to.equal('empty')
    })

    it('reports a fallback disposed after construction through the fallback contract', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        const output = createBuffer(fixture, 'output')
        const fallback = createDispatch(fixture, {
            resources: { read: [], write: [ output ] },
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        fallback.dispose()
        const builder = fixture.runtime.createSubmission({ validation: 'warn' })
            .compute(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_COMMAND_FALLBACK_INVALID'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(primary.subject)
        expect(diagnostic.related).to.deep.include(primaryInput.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.actual).to.deep.include({
            reason: 'disposed',
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            fallbackCommandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            validation: 'warn',
        })
        expect(diagnostic.actual.attempts).to.have.length(2)
        expect(diagnostic.actual.attempts[0].missing[0]).to.deep.include({
            resourceId: primaryInput.id,
            requiredContentEpoch: 0,
            simulatedState: 'empty',
        })
        expect(diagnostic.actual.attempts[1]).to.deep.include({
            commandId: fallback.id,
            commandKind: 'dispatch',
            policy: 'throw',
            missing: [],
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(output.state).to.equal('empty')
    })

    it('enriches a selected fallback dependency disposal diagnostic', async() => {

        const fixture = await createComputeFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        const fallbackInput = createBuffer(fixture, 'fallback input')
        const output = createBuffer(fixture, 'output')
        const fallback = createDispatch(fixture, {
            resources: {
                read: [ { resource: fallbackInput, contentEpoch: 0 } ],
                write: [ output ],
            },
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        fallbackInput.dispose()
        const builder = fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_COMMAND_FALLBACK_INVALID'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(primary.subject)
        expect(diagnostic.related).to.deep.include(primaryInput.subject)
        expect(diagnostic.related).to.deep.include(fallbackInput.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.actual).to.deep.include({
            reason: 'SCRATCH_RESOURCE_DISPOSED',
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            fallbackCommandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            validation: 'off',
        })
        expect(diagnostic.actual.cause).to.deep.include({
            code: 'SCRATCH_RESOURCE_DISPOSED',
            phase: 'resource',
            subject: fallbackInput.subject,
        })
        expect(diagnostic.actual.attempts.map(attempt => ({
            commandId: attempt.commandId,
            missingIds: attempt.missing.map(missing => missing.resourceId),
            missingStates: attempt.missing.map(missing => missing.simulatedState),
        }))).to.deep.equal([
            { commandId: primary.id, missingIds: [ primaryInput.id ], missingStates: [ 'empty' ] },
            { commandId: fallback.id, missingIds: [ fallbackInput.id ], missingStates: [ 'disposed' ] },
        ])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(output.state).to.equal('empty')
    })

    it('validates dependency epochs only for the selected fallback', async() => {

        for (const testCase of [
            { code: 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE', availableEpoch: 1, requiredEpoch: 2 },
            { code: 'SCRATCH_SUBMISSION_STALE_READ', availableEpoch: 2, requiredEpoch: 1 },
        ]) {
            const fixture = await createComputeFixture()
            const primaryInput = createBuffer(fixture, 'primary input')
            const fallbackInput = createBuffer(fixture, 'ready fallback input')
            const output = createBuffer(fixture, 'output')
            for (let epoch = 0; epoch < testCase.availableEpoch; epoch++) {
                advanceResourceContentEpochForTest(fallbackInput)
            }
            const fallback = createDispatch(fixture, {
                resources: {
                    read: [ { resource: fallbackInput, contentEpoch: testCase.requiredEpoch } ],
                    write: [ output ],
                },
                whenMissing: 'throw',
            })
            const primary = createDispatch(fixture, {
                resources: {
                    read: [ { resource: primaryInput, contentEpoch: 99 } ],
                    write: [ output ],
                },
                whenMissing: 'use-fallback',
                fallback,
            })
            const builder = fixture.runtime.createSubmission({ validation: 'throw' })
                .compute(fixture.pass, [ primary ])

            const diagnostic = await expectDiagnostic(() => builder.submit(), testCase.code)

            expect(diagnostic.subject).to.deep.equal(fallback.subject)
            expect(diagnostic.actual).to.deep.include({
                passId: fixture.pass.id,
                requestedCommandId: primary.id,
                commandId: fallback.id,
                attemptedCommandIds: [ primary.id, fallback.id ],
                requiredContentEpoch: testCase.requiredEpoch,
                simulatedContentEpoch: testCase.availableEpoch,
                validation: 'throw',
            })
            expect(diagnostic.actual.requiredContentEpoch).to.not.equal(99)
            expect(fixture.calls.commandEncoders).to.have.length(0)
        }
    })

    it('keeps fallback control flow independent from dependency validation mode', async() => {

        for (const validation of [ 'warn', 'off' ]) {
            const fixture = await createComputeFixture()
            const primaryInput = createBuffer(fixture, 'primary input')
            const fallbackInput = createBuffer(fixture, 'stale fallback input')
            const output = createBuffer(fixture, 'output')
            advanceResourceContentEpochForTest(fallbackInput)
            advanceResourceContentEpochForTest(fallbackInput)
            const fallback = createDispatch(fixture, {
                resources: {
                    read: [ { resource: fallbackInput, contentEpoch: 1 } ],
                    write: [ output ],
                },
            })
            const primary = createDispatch(fixture, {
                resources: {
                    read: [ { resource: primaryInput, contentEpoch: 0 } ],
                    write: [ output ],
                },
                whenMissing: 'use-fallback',
                fallback,
            })
            const submitted = fixture.runtime.createSubmission({ validation })
                .compute(fixture.pass, [ primary ])
                .submit()

            expect(fixture.calls.dispatchCalls).to.have.length(1)
            expect(submitted.diagnostics.map(diagnostic => diagnostic.code)).to.deep.equal(
                validation === 'warn' ? [ 'SCRATCH_SUBMISSION_STALE_READ' ] : []
            )
            expect(commandOutcomes(submitted)[0]).to.deep.include({
                status: 'fallback-executed',
                executedCommandId: fallback.id,
            })
            expect(submitted.resourceAccesses.map(access => access.commandId).filter(Boolean)).to.deep.equal([
                fallback.id,
                fallback.id,
            ])
            expect(submitted.producerEpochs[0].producedBy.commandId).to.equal(fallback.id)
            expect(output.contentEpoch).to.equal(1)
        }
    })

    it('wraps a selected fallback that is incompatible with the render pass', async() => {

        const fixture = await createRenderFixture()
        const missing = createBuffer(fixture, 'primary input')
        const incompatiblePipeline = fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const fallback = createDraw(fixture, {
            pipeline: incompatiblePipeline,
        })
        const primary = createDraw(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(primary.subject)
        expect(diagnostic.related).to.deep.include(missing.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            fallbackCommandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            validation: 'throw',
        })
        expect(diagnostic.actual.attempts).to.have.length(2)
        expect(diagnostic.actual.attempts[0]).to.deep.include({
            commandId: primary.id,
            commandKind: 'draw',
            policy: 'use-fallback',
        })
        expect(diagnostic.actual.attempts[0].missing[0]).to.deep.include({
            resourceId: missing.id,
            requiredContentEpoch: 0,
            simulatedState: 'empty',
        })
        expect(diagnostic.actual.attempts[1]).to.deep.include({
            commandId: fallback.id,
            commandKind: 'draw',
            policy: 'throw',
            missing: [],
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
    })

    it('rejects a selected fallback whose color target count differs from the pass', async() => {

        const fixture = await createRenderFixture()
        const missing = createBuffer(fixture, 'primary input')
        const incompatiblePipeline = fixture.runtime.createRenderPipeline({
            program: fixture.program,
            targets: [
                { format: 'rgba8unorm' },
                { format: 'rgba8unorm' },
            ],
        })
        const fallback = createDraw(fixture, {
            pipeline: incompatiblePipeline,
        })
        const primary = createDraw(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const builder = fixture.runtime.createSubmission({ validation: 'off' })
            .render(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(missing.subject)
        expect(diagnostic.actual).to.deep.include({
            reason: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            fallbackCommandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            validation: 'off',
        })
        expect(diagnostic.actual.attempts).to.have.length(2)
        expect(diagnostic.actual.attempts[1]).to.deep.include({
            commandId: fallback.id,
            commandKind: 'draw',
            policy: 'throw',
            missing: [],
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
    })

    it('keeps the requested fallback chain on render resource conflicts', async() => {

        const fixture = await createRenderFixture()
        const primaryInput = createBuffer(fixture, 'primary input')
        advanceResourceContentEpochForTest(fixture.target)
        const fallback = createDraw(fixture, {
            resources: {
                read: [ { resource: fixture.target, contentEpoch: 1 } ],
                write: [],
            },
        })
        const primary = createDraw(fixture, {
            resources: {
                read: [ { resource: primaryInput, contentEpoch: 0 } ],
                write: [],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ primary ])

        const diagnostic = await expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT'
        )

        expect(diagnostic.subject).to.deep.equal(fallback.subject)
        expect(diagnostic.related).to.deep.include(primary.subject)
        expect(diagnostic.related).to.deep.include(fallback.subject)
        expect(diagnostic.related).to.deep.include(primaryInput.subject)
        expect(diagnostic.related).to.deep.include(fixture.target.subject)
        expect(diagnostic.related).to.deep.include(fixture.pass.subject)
        expect(diagnostic.related).to.deep.include(builder.subject)
        expect(diagnostic.actual).to.deep.include({
            stepIndex: 0,
            passId: fixture.pass.id,
            requestedCommandId: primary.id,
            commandId: fallback.id,
            attemptedCommandIds: [ primary.id, fallback.id ],
            access: 'read',
            resourceId: fixture.target.id,
        })
        expect(diagnostic.actual.attempts.map(attempt => ({
            commandId: attempt.commandId,
            missingIds: attempt.missing.map(missing => missing.resourceId),
        }))).to.deep.equal([
            { commandId: primary.id, missingIds: [ primaryInput.id ] },
            { commandId: fallback.id, missingIds: [] },
        ])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.drawCalls).to.have.length(0)
    })

    it('records duplicate declared writes once when a fallback executes', async() => {

        const fixture = await createComputeFixture()
        const missing = createBuffer(fixture, 'missing primary input')
        const output = createBuffer(fixture, 'fallback output')
        const fallback = createDispatch(fixture, {
            resources: { read: [], write: [ output, output ] },
        })
        const primary = createDispatch(fixture, {
            resources: {
                read: [ { resource: missing, contentEpoch: 0 } ],
                write: [ output ],
            },
            whenMissing: 'use-fallback',
            fallback,
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'off' })
            .compute(fixture.pass, [ primary ])
            .submit()

        expect(fallback.resources.write).to.deep.equal([ output ])
        expect(submitted.resourceAccesses).to.have.length(1)
        expect(submitted.resourceAccesses[0]).to.include({
            commandId: fallback.id,
            resourceId: output.id,
            access: 'write',
        })
        expect(submitted.producerEpochs).to.have.length(1)
        expect(submitted.producerEpochs[0].producedBy.commandId).to.equal(fallback.id)
        expect(output.contentEpoch).to.equal(1)
    })
})
