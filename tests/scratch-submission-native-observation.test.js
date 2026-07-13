import { expect } from 'chai'
import * as scr from 'geoscratch'
import { beginSubmissionNativeObservation } from '../packages/geoscratch/dist/scratch/submission-native-observation.js'
import { createFakeGpu } from './scratch-test-utils.js'

const submissionLocation = submissionId => ({ kind: 'submission', submissionId })
const commandLocation = (submissionId, stepIndex, commandId) => ({
    kind: 'standalone-command',
    submissionId,
    stepIndex,
    commandId,
    commandKind: 'copy',
})

describe('scratch bounded submission native observation', () => {

    it('uses one constant summary scope bundle and preserves synchronous issue order', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submissionId = 'submission-summary'
        const locations = Array.from({ length: 20 }, (_, index) =>
            commandLocation(submissionId, index, `command-${index}`)
        )
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: locations.map(location => ({ stage: 'command-encode', location })),
        })
        const issued = []

        for (const [ index, location ] of locations.entries()) {
            const value = observation.issue('command-encode', location, () => {
                issued.push(index)
                return index
            })
            expect(value).to.equal(index)
        }
        observation.finish()

        expect(issued).to.deep.equal(Array.from({ length: 20 }, (_, index) => index))
        expect(fake.calls.errorScopes).to.deep.equal([
            { action: 'push', filter: 'out-of-memory' },
            { action: 'push', filter: 'internal' },
            { action: 'push', filter: 'validation' },
            { action: 'pop', filter: 'validation' },
            { action: 'pop', filter: 'internal' },
            { action: 'pop', filter: 'out-of-memory' },
        ])
        expect(await observation.outcome).to.deep.include({
            version: 5,
            submissionId,
            mode: 'summary',
            status: 'observed-succeeded',
        })
        expect(runtime.diagnostics.snapshot().submissionNative).to.deep.include({
            currentPendingNativeObservations: 0,
            peakPendingNativeObservations: 1,
        })
    })

    it('opens no scopes for off mode or effect-free work', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            diagnostics: { submissionScopes: 'off' },
        })
        const off = beginSubmissionNativeObservation({
            runtime,
            submissionId: 'submission-off',
            effectful: true,
            plan: [ {
                stage: 'queue-submit',
                location: submissionLocation('submission-off'),
            } ],
        })
        expect(off.issue(
            'queue-submit',
            submissionLocation('submission-off'),
            () => 'issued'
        )).to.equal('issued')
        off.finish()

        const empty = beginSubmissionNativeObservation({
            runtime,
            submissionId: 'submission-empty',
            effectful: false,
            plan: [],
        })
        empty.finish()

        expect(await off.outcome).to.deep.include({ mode: 'off', status: 'unobserved' })
        expect(await empty.outcome).to.deep.include({ mode: 'off', status: 'no-native-work' })
        expect(fake.calls.errorScopes).to.deep.equal([])
        expect(runtime.diagnostics.snapshot().submissionNative.peakPendingNativeObservations).to.equal(0)
    })

    it('snapshots one detailed plan across multiple requesting captures', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const firstCapture = runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
        const secondCapture = runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
        const submissionId = 'submission-detailed'
        const locations = [
            commandLocation(submissionId, 0, 'command-0'),
            commandLocation(submissionId, 1, 'command-1'),
        ]
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: locations.map(location => ({ stage: 'command-encode', location })),
        })

        for (const location of locations) {
            observation.issue('command-encode', location, () => {})
        }
        observation.finish()
        const outcome = await observation.outcome

        expect(outcome.mode).to.equal('detailed')
        expect(outcome.locations).to.deep.equal(locations)
        expect(fake.calls.errorScopes.filter(call => call.action === 'push')).to.have.length(6)
        expect(fake.calls.errorScopes.filter(call => call.action === 'pop')).to.have.length(6)
        firstCapture.stop()
        secondCapture.stop()
    })

    it('fails a full pending-observation budget before the next issue callback', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            diagnostics: { maxPendingNativeObservations: 1 },
        })
        const first = beginSubmissionNativeObservation({
            runtime,
            submissionId: 'submission-budget-1',
            effectful: true,
            plan: [ {
                stage: 'queue-submit',
                location: submissionLocation('submission-budget-1'),
            } ],
        })
        first.issue('queue-submit', submissionLocation('submission-budget-1'), () => {})
        first.finish()

        expect(() => beginSubmissionNativeObservation({
            runtime,
            submissionId: 'submission-budget-2',
            effectful: true,
            plan: [ {
                stage: 'queue-submit',
                location: submissionLocation('submission-budget-2'),
            } ],
        })).to.throw(scr.ScratchDiagnosticError).with.property(
            'diagnostic'
        ).that.includes({
            code: 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED',
            phase: 'submission',
        })
        expect(fake.calls.errorScopes.filter(call => call.action === 'push')).to.have.length(3)
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(1)

        fake.errors.settlePop(2)
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        await first.outcome
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
        expect(runtime.diagnostics.incidents({
            submissionId: 'submission-budget-2',
        })).to.have.length(1)
    })

    it('settles failures in fixed filter order and exposes queryable schema-v5 evidence', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submissionId = 'submission-failed'
        const location = submissionLocation(submissionId)
        const validation = new Error('validation failure')
        const internal = new Error('internal failure')
        const outOfMemory = new Error('out of memory failure')
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })

        observation.issue('queue-submit', location, () => {
            fake.errors.emit('out-of-memory', outOfMemory)
            fake.errors.emit('internal', internal)
            fake.errors.emit('validation', validation)
        })
        observation.finish()
        fake.errors.settlePop(2)
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)

        const outcome = await observation.outcome
        expect(outcome.status).to.equal('observed-failed')
        expect(outcome.outcomes.map(fact => fact.nativeErrorCategory)).to.deep.equal([
            'validation',
            'internal',
            'out-of-memory',
        ])
        expect(runtime.diagnostics.operations({
            submissionId,
            nativeLocationKind: 'submission',
            nativeStage: 'scope-settlement',
            nativeOutcomeStatus: 'observed-failed',
        })).to.have.length(1)
        expect(runtime.diagnostics.incidents({
            submissionId,
            nativeLocationKind: 'submission',
            nativeStage: 'scope-settlement',
        })).to.have.length(1)
    })

    it('selects primary failure from complete issue facts beyond bounded public evidence', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const capture = runtime.diagnostics.capture({
            nativeSubmissionDetail: 'step',
            maxOperations: 100,
        })
        const submissionId = 'submission-bounded-primary'
        const plan = Array.from({ length: 65 }, (_, issueOrdinal) => ({
            stage: issueOrdinal === 64 ? 'pass-begin' : 'pass-end',
            location: commandLocation(
                submissionId,
                issueOrdinal,
                `bounded-primary-command-${issueOrdinal}`
            ),
        }))
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan,
        })

        for (const issue of plan) {
            observation.issue(issue.stage, issue.location, () => {
                fake.errors.emit('validation', new Error(`failure ${issue.location.stepIndex}`))
            })
        }
        observation.finish()

        const outcome = await observation.outcome
        const settlement = await observation.settlement
        expect(outcome.outcomes).to.have.length(64)
        expect(outcome.omittedOutcomeCount).to.equal(1)
        expect(outcome.outcomes.every(fact => fact.stage === 'pass-end')).to.equal(true)
        expect(settlement.primaryFailure).to.deep.include({ issueOrdinal: 64 })
        expect(settlement.primaryFailure.fact).to.deep.include({
            stage: 'pass-begin',
            diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
        })
        expect(settlement.primaryFailure.incident).to.deep.include({
            kind: 'submission-failure',
            failureStage: 'pass-begin',
            diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
        })
        expect(settlement.primaryFailure.incident.outcomes).to.have.length(64)
        expect(settlement.primaryFailure.incident.evidence).to.deep.include({
            complete: false,
            omittedRecords: 1,
        })
        capture.stop()
    })

    it('records lifecycle cancellation and releases the owner exactly once', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submissionId = 'submission-lifecycle'
        const location = submissionLocation(submissionId)
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })
        observation.issue('queue-submit', location, () => {})
        observation.finish()
        runtime.dispose()

        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        fake.errors.settlePop(2)
        const outcome = await observation.outcome
        expect(outcome.status).to.equal('observation-failed')
        expect(outcome.outcomes.map(fact => fact.nativeErrorCategory)).to.include('none')
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
        expect(fake.errors.scopeDepth).to.equal(0)
    })

    it('keeps an application outer scope paired outside the summary owner', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const outerError = new Error('application outer validation')
        const submissionId = 'submission-outer-scope'
        const location = submissionLocation(submissionId)
        fake.device.pushErrorScope('validation')
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })

        observation.issue('queue-submit', location, () => {})
        observation.finish()
        fake.errors.emit('validation', outerError)

        expect(await fake.device.popErrorScope()).to.equal(outerError)
        expect((await observation.outcome).status).to.equal('observed-succeeded')
        expect(fake.errors.scopeDepth).to.equal(0)
    })

    it('classifies a rejected scope settlement and releases its reservation', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submissionId = 'submission-pop-rejection'
        const location = submissionLocation(submissionId)
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })
        observation.issue('queue-submit', location, () => {})
        observation.finish()

        fake.errors.rejectPop(0, new Error('validation pop rejected'))
        fake.errors.settlePop(2)
        fake.errors.settlePop(1)
        const outcome = await observation.outcome

        expect(outcome.status).to.equal('observation-failed')
        expect(outcome.outcomes[0]).to.deep.include({
            stage: 'scope-settlement',
            nativeErrorCategory: 'scope-failure',
            diagnosticCode: 'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED',
        })
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
    })

    it('retains failure incidents when successful operation history is disabled', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            diagnostics: { operationCapacity: 0 },
        })
        const submissionId = 'submission-zero-operation-capacity'
        const location = submissionLocation(submissionId)
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })
        observation.issue('queue-submit', location, () => {
            fake.errors.emit('validation', new Error('submission validation'))
        })
        observation.finish()
        await observation.outcome

        expect(runtime.diagnostics.operations({ submissionId })).to.deep.equal([])
        expect(runtime.diagnostics.incidents({ submissionId })).to.have.length(1)
    })

    it('retains device-loss structure without unscoped native prose', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const submissionId = 'submission-device-loss'
        const location = submissionLocation(submissionId)
        const observation = beginSubmissionNativeObservation({
            runtime,
            submissionId,
            effectful: true,
            plan: [ { stage: 'queue-submit', location } ],
        })
        observation.issue('queue-submit', location, () => {})
        observation.finish()
        fake.errors.loseDevice({
            reason: 'destroyed',
            message: 'raw device loss text must not be retained',
        })
        await Promise.resolve()

        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        fake.errors.settlePop(2)
        const outcome = await observation.outcome
        const deviceLoss = outcome.outcomes.find(fact =>
            fact.nativeErrorCategory === 'device-lost'
        )

        expect(outcome.status).to.equal('observation-failed')
        expect(deviceLoss.nativeError).to.deep.include({
            message: '[native device-loss message omitted]',
            reason: 'destroyed',
            nativeMessageOmitted: true,
        })
        expect(runtime.diagnostics.incidents({ submissionId })[0]).to.include({
            kind: 'submission-failure',
            attribution: 'temporal-correlation',
            failureStage: 'lifecycle-recheck',
        })
        expect(JSON.stringify(outcome)).not.to.include('raw device loss text')
        expect(runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations).to.equal(0)
    })
})
