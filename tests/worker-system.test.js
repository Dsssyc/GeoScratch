import { expect } from 'chai'
import { ScratchDiagnosticError } from 'geoscratch'
import { WorkerSystem } from 'geoscratch/worker'
import {
    ScriptedWorker,
    scriptedWorkerFactory,
    waitFor,
    workerGroupOptions,
} from './worker-test-utils.js'

describe('generic WorkerSystem', () => {

    it('uses explicit independent systems and bounded group facts', async() => {

        const firstFactory = scriptedWorkerFactory()
        const first = new WorkerSystem({ maxWorkers: 1, workerFactory: firstFactory, maxHistory: 3 })
        const firstGroup = first.createGroup(workerGroupOptions())
        await firstGroup.ready

        const secondFactory = scriptedWorkerFactory()
        const second = new WorkerSystem({ maxWorkers: 1, workerFactory: secondFactory, maxHistory: 3 })
        const secondGroup = second.createGroup(workerGroupOptions({ id: 'second-group' }))
        await secondGroup.ready

        expect(first).not.to.equal(second)
        expect(firstGroup).not.to.equal(secondGroup)
        expect(first.inspect()).to.deep.include({ groupCount: 1, workerCount: 1, maxWorkers: 1 })
        expect(firstGroup.inspect().history).to.have.length.at.most(3)

        await first.dispose()
        await second.dispose()
        expect(ScriptedWorker.instances.every(worker => worker.terminated)).to.equal(true)
    })

    it('orders priority, supports queued reprioritization, and reports saturation', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const group = system.createGroup(workerGroupOptions({ maxQueuedTasks: 2 }))
        await group.ready
        const worker = ScriptedWorker.instances[0]
        const hold = group.run({ module: 'fixture', operation: 'hold', input: null })
        await waitFor(() => worker.active.size === 1)
        const background = group.run({
            module: 'fixture',
            operation: 'background',
            input: 'background',
            priority: { class: 'background', score: 0 },
        })
        const visible = group.run({
            module: 'fixture',
            operation: 'visible',
            input: 'visible',
            priority: { class: 'user-visible', score: 0 },
        })
        expect(() => group.run({ module: 'fixture', operation: 'overflow', input: null }))
            .to.throw(ScratchDiagnosticError)
            .with.property('diagnostic')
            .that.deep.includes({ code: 'WORKER_QUEUE_SATURATED' })

        expect(background.reprioritize({ class: 'critical', score: 10 })).to.equal(true)
        worker.release('hold')
        await Promise.all([ hold.result, background.result, visible.result ])

        expect(worker.runOrder).to.deep.equal([ 'hold', 'background', 'visible' ])
        await system.dispose()
    })

    it('ages old background work so repeated visible work cannot starve it', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: factory,
            agingIntervalMs: 1,
        })
        const group = system.createGroup(workerGroupOptions())
        await group.ready
        const worker = ScriptedWorker.instances[0]
        const hold = group.run({ module: 'fixture', operation: 'hold', input: null })
        await waitFor(() => worker.active.size === 1)
        const old = group.run({
            module: 'fixture',
            operation: 'old-background',
            input: 'old',
            priority: { class: 'background', score: 0 },
        })
        await new Promise(resolve => setTimeout(resolve, 5))
        const recent = group.run({
            module: 'fixture',
            operation: 'recent-visible',
            input: 'recent',
            priority: { class: 'user-visible', score: 0 },
        })
        worker.release('hold')
        await Promise.all([ hold.result, old.result, recent.result ])

        expect(worker.runOrder.slice(1)).to.deep.equal([ 'old-background', 'recent-visible' ])
        await system.dispose()
    })

    it('enforces one global worker budget and makes progress across groups', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const firstGroup = system.createGroup(workerGroupOptions({
            id: 'first-fair-group',
            size: { min: 0, max: 1 },
        }))
        const secondGroup = system.createGroup(workerGroupOptions({
            id: 'second-fair-group',
            size: { min: 0, max: 1 },
        }))
        await Promise.all([ firstGroup.ready, secondGroup.ready ])
        const first = firstGroup.run({ module: 'fixture', operation: 'hold', input: 'first' })
        const firstWorker = await waitFor(() => ScriptedWorker.instances[0])
        await waitFor(() => firstWorker.active.size === 1)
        const second = secondGroup.run({ module: 'fixture', operation: 'echo', input: 'second' })

        expect(system.inspect().workerCount).to.equal(1)
        expect(second.inspect().state).to.equal('queued')
        firstWorker.release('hold', 'first')
        expect(await first.result).to.equal('first')
        expect(await second.result).to.equal('second')
        expect(ScriptedWorker.instances).to.have.length(2)
        expect(firstWorker.terminated).to.equal(true)
        expect(system.inspect().workerCount).to.be.at.most(1)
        await system.dispose()
    })

    it('does not reclaim another group below its reserved minimum', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const protectedGroup = system.createGroup(workerGroupOptions({
            id: 'protected-group',
            size: { min: 1, max: 1 },
        }))
        await protectedGroup.ready
        const protectedWorker = ScriptedWorker.instances[0]
        const waitingGroup = system.createGroup(workerGroupOptions({
            id: 'waiting-group',
            size: { min: 0, max: 1 },
        }))
        await waitingGroup.ready
        const waiting = waitingGroup.run({ module: 'fixture', operation: 'echo', input: 'ready' })
        await new Promise(resolve => setTimeout(resolve, 15))

        expect(waiting.inspect().state).to.equal('queued')
        expect(protectedWorker.terminated).to.equal(false)
        expect(system.inspect().workerCount).to.equal(1)
        await protectedGroup.dispose()
        expect(await waiting.result).to.equal('ready')
        await system.dispose()
    })

    it('distinguishes queued, cooperative, stale, and hard cancellation', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const group = system.createGroup(workerGroupOptions())
        await group.ready
        const worker = ScriptedWorker.instances[0]
        const hold = group.run({ module: 'fixture', operation: 'hold', input: null })
        await waitFor(() => worker.active.size === 1)
        const queued = group.run({ module: 'fixture', operation: 'queued', input: null })
        expect(queued.cancel('obsolete')).to.equal('queued')
        await expectDiagnostic(queued.result, 'WORKER_TASK_CANCELLED', 'queued')
        worker.release('hold')
        await hold.result

        const cooperative = group.run({
            module: 'fixture',
            operation: 'cooperative',
            input: null,
            cancellation: 'cooperative',
        })
        await waitFor(() => worker.active.size === 1)
        expect(cooperative.cancel('stop fetch')).to.equal('cooperative')
        await expectDiagnostic(cooperative.result, 'WORKER_TASK_CANCELLED', 'cooperative')

        const nonCooperative = group.run({
            module: 'fixture',
            operation: 'hold',
            input: null,
            cancellation: 'non-cooperative',
        })
        await waitFor(() => worker.active.size === 1)
        expect(nonCooperative.cancel('cannot preempt synchronous work')).to.equal('none')
        worker.release('hold', 'completed honestly')
        expect(await nonCooperative.result).to.equal('completed honestly')

        const stale = group.run({
            module: 'fixture',
            operation: 'slow',
            input: 'old',
            staleKey: 'camera',
            generation: 1,
        })
        await waitFor(() => worker.active.size === 1)
        const current = group.run({
            module: 'fixture',
            operation: 'current',
            input: 'new',
            staleKey: 'camera',
            generation: 2,
        })
        worker.release('slow', 'late old value')
        await expectDiagnostic(stale.result, 'WORKER_TASK_STALE', 'stale')
        expect(await current.result).to.equal('new')

        await system.dispose()

        const hardFactory = scriptedWorkerFactory()
        const hardSystem = new WorkerSystem({ maxWorkers: 1, workerFactory: hardFactory })
        const hardGroup = hardSystem.createGroup(workerGroupOptions({
            id: 'exclusive',
            isolation: 'task',
            size: { min: 0, max: 1 },
        }))
        await hardGroup.ready
        const hard = hardGroup.run({
            module: 'fixture',
            operation: 'hold',
            input: null,
            cancellation: 'hard',
        })
        const hardWorker = await waitFor(() => ScriptedWorker.instances[0])
        await waitFor(() => hardWorker.active.size === 1)
        expect(hard.cancel('force')).to.equal('hard')
        await expectDiagnostic(hard.result, 'WORKER_TERMINATED', 'hard')
        expect(hardWorker.terminated).to.equal(true)
        await hardSystem.dispose()
    })

    it('enforces isolation as a task and context capability boundary', async() => {

        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: scriptedWorkerFactory() })
        const shared = system.createGroup(workerGroupOptions({
            isolation: 'shared',
            size: { min: 0, max: 1 },
        }))
        await shared.ready

        expect(() => shared.run({
            module: 'fixture',
            operation: 'unsafe-sync',
            input: null,
            cancellation: 'non-cooperative',
        })).to.throw(ScratchDiagnosticError)
        expect(() => shared.run({
            module: 'fixture',
            operation: 'hard-on-shared',
            input: null,
            cancellation: 'hard',
        })).to.throw(ScratchDiagnosticError)
        let contextFailure
        try {
            await shared.openContext({ module: 'fixture', key: 'invalid', init: null })
        } catch (error) {
            contextFailure = error
        }
        expect(contextFailure).to.be.instanceOf(ScratchDiagnosticError)
        expect(contextFailure.diagnostic.code).to.equal('WORKER_DESCRIPTOR_INVALID')
        await system.dispose()
    })

    it('preserves remote error facts and isolates a crashed host', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const group = system.createGroup(workerGroupOptions())
        await group.ready

        const failed = group.run({ module: 'fixture', operation: 'fail', input: null })
        const failure = await expectDiagnostic(failed.result, 'WORKER_TASK_FAILED')
        expect(failure.diagnostic).to.deep.include({
            remoteStack: 'remote fixture stack',
            retriable: false,
        })
        expect(failure.diagnostic.actual).to.deep.include({
            remoteName: 'FixtureError',
            remoteCode: 'FIXTURE_REMOTE',
        })

        const crashed = group.run({ module: 'fixture', operation: 'crash', input: null })
        await expectDiagnostic(crashed.result, 'WORKER_TERMINATED')
        const recovered = group.run({ module: 'fixture', operation: 'echo', input: 7 })
        expect(await recovered.result).to.equal(7)
        expect(ScriptedWorker.instances).to.have.length(2)
        await system.dispose()
    })

    it('normalizes initialization failures and converges active disposal', async() => {

        const failedSystem = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory({ failInitialization: true }),
        })
        const failedGroup = failedSystem.createGroup(workerGroupOptions())
        const initializationFailure = await expectDiagnostic(
            failedGroup.ready,
            'WORKER_MODULE_LOAD_FAILED'
        )
        expect(initializationFailure.diagnostic.remoteStack)
            .to.equal('remote initialization stack')
        expect(failedGroup.inspect()).to.deep.include({ workerCount: 0, activeTaskCount: 0 })
        await failedSystem.dispose()

        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory(),
        })
        const group = system.createGroup(workerGroupOptions())
        await group.ready
        const active = group.run({ module: 'fixture', operation: 'hold', input: null })
        await waitFor(() => ScriptedWorker.instances[0].active.size === 1)
        await group.dispose()
        await expectDiagnostic(active.result, 'WORKER_GROUP_DISPOSED')
        expect(group.inspect()).to.deep.include({
            state: 'disposed',
            workerCount: 0,
            activeTaskCount: 0,
            contextCount: 0,
        })
        await system.dispose()
        await system.dispose()
    })

    it('keeps stateful context affinity and clears state on disposal', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const group = system.createGroup(workerGroupOptions())
        await group.ready
        const context = await group.openContext({
            module: 'fixture',
            key: 'document-a',
            init: { value: 2 },
        })
        const workerId = context.inspect().workerId

        expect(await context.run('increment', { by: 3 }).result).to.equal(5)
        expect(await context.run('increment', { by: 4 }).result).to.equal(9)
        expect(context.inspect().workerId).to.equal(workerId)
        expect(await context.snapshot()).to.deep.include({ value: 9, key: 'document-a' })
        await context.dispose()
        expect(ScriptedWorker.instances[0].contexts.size).to.equal(0)

        const reopened = await group.openContext({
            module: 'fixture',
            key: 'document-a',
            init: { value: 1 },
        })
        expect(await reopened.run('increment', { by: 1 }).result).to.equal(2)
        await reopened.dispose()
        await system.dispose()
    })

    it('moves transferable ownership and reclaims idle workers above the minimum', async() => {

        const factory = scriptedWorkerFactory()
        const system = new WorkerSystem({ maxWorkers: 1, workerFactory: factory })
        const group = system.createGroup(workerGroupOptions({ size: { min: 0, max: 1 } }))
        await group.ready
        const transfer = group.run({ module: 'fixture', operation: 'transfer', input: null })
        const value = await transfer.result

        expect([ ...value.data ]).to.deep.equal([ 3, 1, 4, 1, 5 ])
        expect(value.byteLengthBeforeTransfer).to.equal(5)
        expect(ScriptedWorker.instances[0].detachmentFacts).to.deep.equal([
            { before: 5, after: 0 },
        ])
        await waitFor(() => ScriptedWorker.instances[0].terminated)
        expect(group.inspect()).to.deep.include({ workerCount: 0, activeTaskCount: 0 })
        await system.dispose()
    })
})

async function expectDiagnostic(promise, code, cancellationKind) {

    let failure
    try {
        await promise
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(ScratchDiagnosticError)
    expect(failure.diagnostic.code).to.equal(code)
    if (cancellationKind !== undefined) {
        expect(failure.diagnostic.cancellationKind).to.equal(cancellationKind)
    }
    return failure
}
