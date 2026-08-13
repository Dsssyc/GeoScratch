import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    WorkerContextPool,
    WorkerSystem,
    recommendedWorkerCount,
    workerRemoteErrorCode,
    workerRemoteErrorFacts,
} from 'geoscratch/scratch'
import {
    ScriptedWorker,
    scriptedWorkerFactory,
    waitFor,
} from './worker-test-utils.js'
import { spawnSync } from 'node:child_process'

const fixtureModule = Object.freeze({
    id: 'fixture',
    version: '1',
    url: new URL('https://example.invalid/fixture-worker.js'),
})

describe('Scratch WorkerContextPool', () => {

    it('owns contexts and its group while borrowing the WorkerSystem', async() => {

        const system = new WorkerSystem({
            maxWorkers: 2,
            workerFactory: scriptedWorkerFactory(),
        })
        const pool = await WorkerContextPool.create({
            id: 'borrowed-context-pool',
            system: { ownership: 'borrowed', system },
            module: fixtureModule,
            size: 2,
            maxQueuedTasks: 8,
            maxActiveTasks: 2,
            idleTimeoutMs: 1_000,
            context: index => ({ key: `shard-${index}`, init: { value: index } }),
        })

        expect(pool.inspect()).to.deep.include({
            kind: 'worker-context-pool',
            id: 'borrowed-context-pool',
            state: 'active',
            systemOwnership: 'borrowed',
            size: 2,
            disposeGraceMs: 5_000,
        })
        expect(pool.inspect().contexts).to.have.length(2)
        expect(await pool.run(1, 'increment', { by: 3 }).result).to.equal(4)
        expect(await pool.snapshot(1)).to.deep.include({ value: 4, key: 'shard-1' })
        const workers = [ ...ScriptedWorker.instances ]

        await pool.dispose()
        await pool.dispose()
        expect(workers.reduce((sum, worker) => sum + worker.contextDisposeCount, 0)).to.equal(2)
        expect(pool.inspect()).to.deep.include({
            state: 'disposed',
            size: 2,
            disposalMode: 'remote-finalized',
        })
        expect(system.inspect()).to.deep.include({ disposed: false, groupCount: 0 })
        await system.dispose()
    })

    it('disposes an explicitly owned WorkerSystem and all retained state', async() => {

        const pool = await WorkerContextPool.create({
            id: 'owned-context-pool',
            system: {
                ownership: 'owned',
                options: {
                    maxWorkers: 1,
                    workerFactory: scriptedWorkerFactory(),
                },
            },
            module: fixtureModule,
            size: 1,
            maxQueuedTasks: 4,
            maxActiveTasks: 1,
            idleTimeoutMs: 1_000,
            context: () => ({ key: 'state', init: { value: 9 } }),
        })

        await pool.dispose()

        expect(pool.inspect().system).to.deep.include({
            disposed: true,
            workerCount: 0,
            groupCount: 0,
            contextCount: 0,
        })
    })

    it('terminates active context work before releasing retained state', async() => {

        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory(),
        })
        const pool = await WorkerContextPool.create({
            id: 'active-context-pool',
            system: { ownership: 'borrowed', system },
            module: fixtureModule,
            size: 1,
            maxQueuedTasks: 4,
            maxActiveTasks: 1,
            idleTimeoutMs: 1_000,
            context: () => ({ key: 'active', init: null }),
        })
        const task = pool.run(0, 'hold', null, { cancellation: 'non-cooperative' })
        const taskSettlement = task.result.then(
            () => undefined,
            error => error
        )
        const worker = await waitFor(() => ScriptedWorker.instances[0])
        await waitFor(() => worker.active.size === 1)
        const disposal = pool.dispose()
        const outcome = await Promise.race([
            disposal.then(() => 'disposed'),
            new Promise(resolve => setTimeout(() => resolve('timed-out'), 100)),
        ])
        if (outcome === 'timed-out') {
            worker.release('hold')
            await disposal
        }

        expect(outcome).to.equal('disposed')
        expect((await taskSettlement).diagnostic.code).to.equal('WORKER_GROUP_DISPOSED')
        expect(worker.terminated).to.equal(true)
        expect(worker.contextDisposeCount).to.equal(0)
        expect(pool.inspect()).to.deep.include({
            state: 'disposed',
            size: 1,
            disposalMode: 'forced-pending-work',
        })
        expect(system.inspect()).to.deep.include({ disposed: false, groupCount: 0 })
        await system.dispose()
    })

    it('bounds a non-cooperative remote finalizer and records forced convergence', async() => {

        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory({ holdContextDispose: true }),
        })
        const pool = await WorkerContextPool.create({
            id: 'timed-context-pool',
            system: { ownership: 'borrowed', system },
            module: fixtureModule,
            size: 1,
            maxQueuedTasks: 4,
            maxActiveTasks: 1,
            idleTimeoutMs: 1_000,
            disposeGraceMs: 10,
            context: () => ({ key: 'timed', init: null }),
        })
        const worker = ScriptedWorker.instances[0]
        let failure
        try {
            await pool.dispose()
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(AggregateError)
        const timeoutFailure = failure.errors.find(error =>
            error instanceof ScratchDiagnosticError &&
            error.diagnostic.code === 'WORKER_CONTEXT_DISPOSE_TIMEOUT'
        )
        expect(timeoutFailure).to.be.instanceOf(ScratchDiagnosticError)
        expect(worker.contextDisposeCount).to.equal(1)
        expect(worker.terminated).to.equal(true)
        expect(pool.inspect()).to.deep.include({
            state: 'disposed',
            disposeGraceMs: 10,
            disposalMode: 'forced-timeout',
        })
        expect(pool.inspect().contexts[0].state).to.equal('disposed')
        expect(system.inspect()).to.deep.include({ disposed: false, groupCount: 0 })
        await system.dispose()
    })

    it('reports a failed remote finalizer after releasing every local owner', async() => {

        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory({ failContextDispose: true }),
        })
        const pool = await WorkerContextPool.create({
            id: 'failed-finalizer-pool',
            system: { ownership: 'borrowed', system },
            module: fixtureModule,
            size: 1,
            maxQueuedTasks: 4,
            maxActiveTasks: 1,
            idleTimeoutMs: 1_000,
            context: () => ({ key: 'failed-finalizer', init: null }),
        })
        let failure
        try {
            await pool.dispose()
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(AggregateError)
        expect(pool.inspect()).to.deep.include({
            state: 'disposed',
            disposalMode: 'remote-finalizer-failed',
        })
        expect(pool.inspect().contexts[0].state).to.equal('disposed')
        expect(system.inspect()).to.deep.include({ disposed: false, groupCount: 0 })
        await system.dispose()
    })

    it('rejects invalid context sets with structured diagnostics and rollback', async() => {

        let failure
        try {
            await WorkerContextPool.create({
                id: 'invalid-context-pool',
                system: {
                    ownership: 'owned',
                    options: {
                        maxWorkers: 2,
                        workerFactory: scriptedWorkerFactory(),
                    },
                },
                module: fixtureModule,
                size: 2,
                maxQueuedTasks: 4,
                maxActiveTasks: 2,
                idleTimeoutMs: 1_000,
                context: () => ({ key: 'duplicate', init: null }),
            })
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(ScratchDiagnosticError)
        expect(failure.diagnostic.code).to.equal('WORKER_DESCRIPTOR_INVALID')
        expect(failure.diagnostic.subject).to.deep.include({
            kind: 'WorkerContextPool',
            id: 'invalid-context-pool',
        })
    })

    it('finalizes contexts opened before a later initialization failure', async() => {

        let failure
        try {
            await WorkerContextPool.create({
                id: 'partial-context-pool',
                system: {
                    ownership: 'owned',
                    options: {
                        maxWorkers: 2,
                        workerFactory: scriptedWorkerFactory(),
                    },
                },
                module: fixtureModule,
                size: 2,
                maxQueuedTasks: 4,
                maxActiveTasks: 2,
                idleTimeoutMs: 1_000,
                context: index => ({
                    key: `partial-${index}`,
                    init: { failOpen: index === 1 },
                }),
            })
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(ScratchDiagnosticError)
        expect(workerRemoteErrorCode(failure)).to.equal('FIXTURE_CONTEXT_OPEN_FAILED')
        expect(ScriptedWorker.instances.reduce(
            (sum, worker) => sum + worker.contextDisposeCount,
            0
        )).to.equal(1)
        expect(ScriptedWorker.instances.every(worker => worker.terminated)).to.equal(true)
    })
})

describe('Scratch Worker utility facts', () => {

    it('derives bounded worker counts from explicit hardware facts', () => {

        expect(recommendedWorkerCount({ hardwareConcurrency: 16 })).to.equal(4)
        expect(recommendedWorkerCount({ hardwareConcurrency: 4, reserve: 1 })).to.equal(3)
        expect(recommendedWorkerCount({
            hardwareConcurrency: 1,
            reserve: 1,
            minimum: 1,
            maximum: 8,
        })).to.equal(1)
    })

    it('reads remote business codes only from branded Worker diagnostics', async() => {

        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory(),
        })
        const group = system.createGroup({
            id: 'remote-facts',
            modules: [ fixtureModule ],
            isolation: 'shared',
            size: { min: 1, max: 1 },
            maxQueuedTasks: 4,
            maxActiveTasks: 1,
            idleTimeoutMs: 1_000,
        })
        await group.ready
        let failure
        try {
            await group.run({ module: 'fixture', operation: 'fail', input: null }).result
        } catch (error) {
            failure = error
        }

        expect(workerRemoteErrorFacts(failure)).to.deep.equal({
            remoteName: 'FixtureError',
            remoteMessage: 'remote fixture failed',
            remoteCode: 'FIXTURE_REMOTE',
        })
        expect(workerRemoteErrorCode(failure)).to.equal('FIXTURE_REMOTE')
        expect(workerRemoteErrorCode({ code: 'UNTRUSTED' })).to.equal(undefined)
        await system.dispose()
    })
})

describe('Scratch typed Worker module protocol', () => {

    it('rejects an implementation whose output violates the declared protocol', () => {

        const result = spawnSync(
            process.execPath,
            [
                'node_modules/typescript/bin/tsc',
                '--noEmit',
                '--strict',
                '--target',
                'ES2022',
                '--module',
                'ESNext',
                '--moduleResolution',
                'Bundler',
                '--skipLibCheck',
                'tests/fixtures/worker-module-contract-invalid.ts',
            ],
            { cwd: process.cwd(), encoding: 'utf8' }
        )

        expect(result.status).to.not.equal(0)
        const output = `${result.stdout}\n${result.stderr}`
        expect(output).to.include("Type '(input: { value: number; }) => string'")
        expect(output).to.include('WorkerOperationResult<number>')
    })
})
