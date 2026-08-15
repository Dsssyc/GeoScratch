import { expect } from 'chai'
import { TaskPhaseBudget } from 'geoscratch/scratch'

describe('Scratch task phase budget', () => {

    it('configures and enforces independent network and decode concurrency budgets', async() => {

        const budget = new TaskPhaseBudget({
            id: 'worker-phase-budget',
            limits: {
                network: 2,
                decode: 1,
            },
            maxQueuedTasks: 4,
        })
        const firstNetwork = budget.acquire('network', {
            class: 'user-visible',
            score: 0,
        })
        const secondNetwork = budget.acquire('network', {
            class: 'user-visible',
            score: 0,
        })
        const queuedNetwork = budget.acquire('network', {
            class: 'background',
            score: 0,
        })
        const firstDecode = budget.acquire('decode', {
            class: 'user-visible',
            score: 0,
        })
        const queuedDecode = budget.acquire('decode', {
            class: 'background',
            score: 0,
        })

        const [ firstNetworkPermit, secondNetworkPermit, firstDecodePermit ] = await Promise.all([
            firstNetwork.result,
            secondNetwork.result,
            firstDecode.result,
        ])
        expect(queuedNetwork.inspect().state).to.equal('queued')
        expect(queuedDecode.inspect().state).to.equal('queued')
        expect(budget.inspect()).to.deep.include({
            disposed: false,
            id: 'worker-phase-budget',
            lanes: {
                network: {
                    limit: 2,
                    activeCount: 2,
                    queuedCount: 1,
                    maxActiveCount: 2,
                    maxQueuedCount: 1,
                },
                decode: {
                    limit: 1,
                    activeCount: 1,
                    queuedCount: 1,
                    maxActiveCount: 1,
                    maxQueuedCount: 1,
                },
            },
        })

        expect(queuedNetwork.cancel('obsolete')).to.equal(true)
        await expectRejectedName(queuedNetwork.result, 'AbortError')
        expect(queuedDecode.reprioritize({ class: 'critical', score: 9 })).to.equal(true)
        firstDecodePermit.release()
        const secondDecodePermit = await queuedDecode.result
        expect(queuedDecode.inspect().state).to.equal('active')

        firstNetworkPermit.release()
        secondNetworkPermit.release()
        secondDecodePermit.release()
        await budget.dispose()
        expect(budget.inspect()).to.deep.include({
            disposed: true,
            id: 'worker-phase-budget',
            lanes: {
                network: {
                    limit: 2,
                    activeCount: 0,
                    queuedCount: 0,
                    maxActiveCount: 2,
                    maxQueuedCount: 1,
                },
                decode: {
                    limit: 1,
                    activeCount: 0,
                    queuedCount: 0,
                    maxActiveCount: 1,
                    maxQueuedCount: 1,
                },
            },
        })
    })
})

async function expectRejectedName(promise, name) {

    let failure
    try {
        await promise
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.name).to.equal(name)
}
