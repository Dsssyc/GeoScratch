import { expect } from 'chai'
import {
    acknowledgeReadyRuntime,
} from '../examples/flowField/flow-ready-velocity-runtime.ts'
import {
    createVelocitySampleRuntime,
} from '../examples/flowField/velocity-source.ts'

describe('Flow ready velocity runtime', () => {

    it('returns only after native outcome, queue completion, and acknowledgement settle', async() => {

        const native = deferred()
        const done = deferred()
        const acknowledged = deferred()
        const fixture = fakeRuntime({ native, done, acknowledged })
        let returned = false
        const ready = acknowledgeReadyRuntime(
            fixture.runtime,
            new AbortController().signal
        ).then(value => {
            returned = true
            return value
        })

        await event(fixture, 'acknowledge')
        native.resolve({ status: 'observed-succeeded' })
        done.resolve()
        await Promise.resolve()
        expect(returned).to.equal(false)
        acknowledged.resolve()

        expect(await ready).to.equal(fixture.runtime)
        expect(fixture.events).to.deep.equal([
            'initialize',
            'create-submission',
            'encode',
            'submit',
            'acknowledge',
        ])
        expect(fixture.disposeCount).to.equal(0)
    })

    it('actively disposes an initializing runtime when aborted', async() => {

        const initialization = deferred()
        const controller = new AbortController()
        const aborted = new Error('initialization cancelled')
        const fixture = fakeRuntime({
            initialization,
            onDispose() { initialization.reject(aborted) },
        })
        const readiness = acknowledgeReadyRuntime(fixture.runtime, controller.signal)
        await event(fixture, 'initialize')

        controller.abort(aborted)
        let failure
        try {
            await readiness
        } catch (error) {
            failure = error
        }

        expect(failure).to.equal(aborted)
        expect(fixture.disposeCount).to.equal(1)
        expect(fixture.events).to.deep.equal([ 'initialize', 'dispose' ])
    })

    it('waits for publication acknowledgement before disposing an aborted runtime', async() => {

        const acknowledged = deferred()
        const controller = new AbortController()
        const aborted = new Error('publication cancelled')
        const fixture = fakeRuntime({ acknowledged })
        const readiness = acknowledgeReadyRuntime(fixture.runtime, controller.signal)
        await event(fixture, 'acknowledge')

        controller.abort(aborted)
        await Promise.resolve()
        expect(fixture.disposeCount).to.equal(0)
        acknowledged.resolve()

        let failure
        try {
            await readiness
        } catch (error) {
            failure = error
        }
        expect(failure).to.equal(aborted)
        expect(fixture.disposeCount).to.equal(1)
        expect(fixture.events.at(-1)).to.equal('dispose')
    })

    it('settles every publication observer and aggregates cleanup failures once', async() => {

        const doneFailure = new Error('queue completion failed')
        const acknowledgeFailure = new Error('acknowledgement failed')
        const cleanupFailure = new Error('runtime disposal failed')
        const fixture = fakeRuntime({
            nativeValue: { status: 'observed-failed' },
            doneFailure,
            acknowledgeFailure,
            disposeFailure: cleanupFailure,
        })

        let failure
        try {
            await acknowledgeReadyRuntime(fixture.runtime, new AbortController().signal)
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(AggregateError)
        expect(failure.errors).to.include(doneFailure)
        expect(failure.errors).to.include(acknowledgeFailure)
        expect(failure.errors).to.include(cleanupFailure)
        expect(failure.errors.some(error =>
            error instanceof Error && error.message.includes('observed-failed')
        )).to.equal(true)
        expect(fixture.events).to.include.members([
            'native:settled',
            'done:settled',
            'acknowledge:settled',
        ])
        expect(fixture.disposeCount).to.equal(1)
    })

    it('aggregates initialization and cleanup failure without a second dispose', async() => {

        const initializationFailure = new Error('safety cover failed')
        const cleanupFailure = new Error('cleanup failed')
        const fixture = fakeRuntime({ initializationFailure, disposeFailure: cleanupFailure })

        let failure
        try {
            await acknowledgeReadyRuntime(fixture.runtime, new AbortController().signal)
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(AggregateError)
        expect(failure.errors).to.deep.equal([ initializationFailure, cleanupFailure ])
        expect(fixture.disposeCount).to.equal(1)
        expect(fixture.events).to.deep.equal([ 'initialize', 'dispose' ])
    })

    it('abandons an initialized publication when encoding fails synchronously', async() => {

        const encodingFailure = new Error('upload encoding failed')
        const fixture = fakeRuntime({ encodeFailure: encodingFailure })

        let failure
        try {
            await acknowledgeReadyRuntime(fixture.runtime, new AbortController().signal)
        } catch (error) {
            failure = error
        }

        expect(failure).to.equal(encodingFailure)
        expect(fixture.events).to.deep.equal([
            'initialize',
            'create-submission',
            'encode',
            'dispose',
        ])
        expect(fixture.disposeCount).to.equal(1)
    })

    it('disposes a pre-aborted runtime before starting safety-cover demand', async() => {

        const fixture = fakeRuntime()
        const controller = new AbortController()
        const aborted = new Error('already cancelled')
        controller.abort(aborted)

        let failure
        try {
            await acknowledgeReadyRuntime(fixture.runtime, controller.signal)
        } catch (error) {
            failure = error
        }

        expect(failure).to.equal(aborted)
        expect(fixture.events).to.deep.equal([ 'dispose' ])
        expect(fixture.disposeCount).to.equal(1)
    })

    it('keeps sample runtime construction on sampleKey and public ownership contracts', () => {

        const source = createVelocitySampleRuntime.toString()
        expect(source).to.include('createVelocitySampleSource(dataset, sampleKey)')
        expect(source).to.include('sampleKey: source.sampleKey')
        expect(source).to.include('resolvePage: source.resolvePage')
        expect(source).to.include("ownership: 'owned'")
        expect(source).to.not.include('sourceCeiling')
        expect(source).to.not.match(/times\s*\[|fields\s*\[/)
    })
})

function fakeRuntime(options = {}) {

    const events = []
    const publication = Object.freeze({ update: Object.freeze({ kind: 'initial-update' }) })
    let disposeCount = 0
    let submitted
    const runtime = {
        initialize() {

            events.push('initialize')
            if (options.initialization !== undefined) return options.initialization.promise
            if (options.initializationFailure !== undefined) {
                return Promise.reject(options.initializationFailure)
            }
            return Promise.resolve(publication)
        },
        gpu: {
            runtime: {
                createSubmission(submissionOptions) {

                    events.push('create-submission')
                    expect(submissionOptions).to.deep.equal({ validation: 'throw' })
                    return {
                        submit() {

                            events.push('submit')
                            const nativeOutcome = options.native ?? settled(
                                options.nativeValue ?? { status: 'observed-succeeded' },
                                undefined,
                                () => events.push('native:settled')
                            )
                            const done = options.done ?? settled(
                                undefined,
                                options.doneFailure,
                                () => events.push('done:settled')
                            )
                            submitted = {
                                nativeOutcome: nativeOutcome.promise,
                                done: done.promise,
                            }
                            return submitted
                        },
                    }
                },
            },
            encode(_builder, update) {

                events.push('encode')
                expect(update).to.equal(publication.update)
                if (options.encodeFailure !== undefined) throw options.encodeFailure
            },
        },
        acknowledge(received, receivedSubmission) {

            events.push('acknowledge')
            expect(received).to.equal(publication)
            expect(receivedSubmission).to.equal(submitted)
            const acknowledgement = options.acknowledged ?? settled(
                undefined,
                options.acknowledgeFailure,
                () => events.push('acknowledge:settled')
            )
            return acknowledgement.promise
        },
        async dispose() {

            disposeCount++
            events.push('dispose')
            options.onDispose?.()
            if (options.disposeFailure !== undefined) throw options.disposeFailure
        },
    }
    return {
        runtime,
        events,
        get disposeCount() { return disposeCount },
    }
}

function settled(value, failure, observe = () => {}) {

    return {
        promise: Promise.resolve().then(() => {
            observe()
            if (failure !== undefined) throw failure
            return value
        }),
    }
}

function deferred() {

    let resolve
    let reject
    const promise = new Promise((accepted, rejected) => {
        resolve = accepted
        reject = rejected
    })
    return { promise, resolve, reject }
}

async function event(fixture, name) {

    for (let attempt = 0; attempt < 20 && !fixture.events.includes(name); attempt++) {
        await Promise.resolve()
    }
    expect(fixture.events).to.include(name)
}
