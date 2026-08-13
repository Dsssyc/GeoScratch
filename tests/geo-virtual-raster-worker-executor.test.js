import { expect } from 'chai'
import {
    createVirtualRasterWorkerExecutor,
    prepareVirtualRasterPageTransfer,
    virtualRasterAddressSpace,
} from 'geoscratch/geo'
import { WorkerSystem } from 'geoscratch/scratch'
import {
    ScriptedWorker,
    scriptedWorkerFactory,
} from './worker-test-utils.js'

describe('Geo Virtual Raster Worker executor', () => {

    it('runs the cache/network/decode protocol without owning WorkerSystem', async() => {

        const addressSpace = virtualRasterAddressSpace({
            id: 'worker-executor-test',
            dimensions: 2,
            extent: [ 4, 4 ],
            pageSize: [ 2, 2 ],
            levelCount: 1,
        })
        const page = addressSpace.page({ level: 0, x: 0, y: 0 })
        const candidates = new Map()
        const workerFacts = {
            accepted: 0,
            discarded: 0,
        }
        const operations = {
            lookup(candidate) {
                candidates.set(candidate.candidateId, candidate)
                return { status: 'miss' }
            },
            fetch(candidate) {
                return { candidateId: candidate.candidateId, status: 200 }
            },
            decode({ candidateId }) {
                const candidate = candidates.get(candidateId)
                return prepareVirtualRasterPageTransfer({
                    page: candidate.page,
                    width: 2,
                    height: 2,
                    channels: 1,
                    data: new Uint8Array([ 1, 2, 3, 4 ]),
                    contentVersion: 'test-v1',
                }).value
            },
            accept() {
                workerFacts.accepted++
                return { ...workerFacts }
            },
            discard() {
                workerFacts.discarded++
                return { ...workerFacts }
            },
            facts() {
                return { ...workerFacts }
            },
        }
        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory({ operations }),
        })
        const executor = await createVirtualRasterWorkerExecutor({
            id: 'test-raster-workers',
            system: { ownership: 'borrowed', system },
            module: {
                id: 'fixture',
                version: '1',
                url: new URL('https://example.invalid/fixture-worker.js'),
            },
            workerCount: 1,
            maxRequests: 4,
            phaseLimits: { network: 1, decode: 1 },
            context: index => ({ key: `test-${index}`, init: null }),
            candidate: (demand, sequence) => ({
                candidateId: `candidate-${sequence}`,
                page: demand.page,
            }),
        })
        expect(executor.inspect().workers).to.deep.equal([ { accepted: 0, discarded: 0 } ])
        const execution = executor.request({
            page,
            generation: 1,
            priority: { class: 'user-visible', score: 1 },
            reason: 'test',
            usage: 'required',
        })

        const transfer = await execution.result
        expect(new Uint8Array(transfer.buffer)).to.deep.equal(new Uint8Array([ 1, 2, 3, 4 ]))
        await execution.accept()
        expect(await executor.refreshFacts()).to.deep.include({
            kind: 'virtual-raster-worker-executor',
            disposed: false,
        })
        expect(executor.inspect().contextPool).to.deep.include({
            kind: 'worker-context-pool',
            systemOwnership: 'borrowed',
            size: 1,
        })
        expect(executor.inspect().workerFactsObservation).to.equal('live')
        expect(executor.inspect().workers).to.deep.equal([ { accepted: 1, discarded: 0 } ])
        expect(ScriptedWorker.instances[0].runOrder).to.deep.equal([
            'facts',
            'lookup',
            'fetch',
            'decode',
            'accept',
            'facts',
        ])

        await executor.dispose()
        expect(executor.inspect().phaseBudget.disposed).to.equal(true)
        expect(system.inspect().disposed).to.equal(false)
        await system.dispose()
    })

    it('routes cache hits through transfer and enforces one settlement', async() => {

        const addressSpace = virtualRasterAddressSpace({
            id: 'worker-executor-cache-test',
            dimensions: 2,
            extent: [ 1, 1 ],
            pageSize: [ 1, 1 ],
            levelCount: 1,
        })
        const page = addressSpace.page({ level: 0, x: 0, y: 0 })
        const operations = {
            lookup: candidate => ({ status: 'hit', candidateId: candidate.candidateId }),
            transfer: () => prepareVirtualRasterPageTransfer({
                page,
                width: 1,
                height: 1,
                channels: 1,
                data: new Uint8Array([ 7 ]),
                contentVersion: 'cache-v1',
            }).value,
            accept: () => ({ settled: 'accept' }),
            discard: () => ({ settled: 'discard' }),
            facts: () => ({ settled: 'none' }),
        }
        const system = new WorkerSystem({
            maxWorkers: 1,
            workerFactory: scriptedWorkerFactory({ operations }),
        })
        const executor = await createVirtualRasterWorkerExecutor({
            id: 'test-raster-cache-workers',
            system: { ownership: 'borrowed', system },
            module: {
                id: 'fixture',
                version: '1',
                url: new URL('https://example.invalid/fixture-worker.js'),
            },
            workerCount: 1,
            maxRequests: 2,
            phaseLimits: { network: 1, decode: 1 },
            context: () => ({ key: 'cache', init: null }),
            candidate: demand => ({ candidateId: 'cached', page: demand.page }),
        })
        const execution = executor.request({
            page,
            generation: 1,
            priority: { class: 'critical', score: 1 },
            reason: 'cache',
            usage: 'required',
        })

        await execution.result
        await execution.discard()
        let settlementFailure
        try {
            await execution.accept()
        } catch (error) {
            settlementFailure = error
        }
        expect(settlementFailure).to.be.instanceOf(Error)
        expect(ScriptedWorker.instances[0].runOrder).to.deep.equal([
            'facts',
            'lookup',
            'transfer',
            'discard',
        ])

        await executor.dispose()
        await system.dispose()
    })

    it('can own the complete WorkerSystem lifecycle explicitly', async() => {

        const addressSpace = virtualRasterAddressSpace({
            id: 'worker-executor-owned-test',
            dimensions: 2,
            extent: [ 1, 1 ],
            pageSize: [ 1, 1 ],
            levelCount: 1,
        })
        const page = addressSpace.page({ level: 0, x: 0, y: 0 })
        const executor = await createVirtualRasterWorkerExecutor({
            id: 'owned-raster-workers',
            system: {
                ownership: 'owned',
                options: {
                    maxWorkers: 1,
                    workerFactory: scriptedWorkerFactory({
                        operations: {
                            lookup: candidate => ({
                                status: 'hit',
                                candidateId: candidate.candidateId,
                            }),
                            transfer: () => prepareVirtualRasterPageTransfer({
                                page,
                                width: 1,
                                height: 1,
                                channels: 1,
                                data: new Uint8Array([ 3 ]),
                                contentVersion: 'owned-v1',
                            }).value,
                            accept: () => ({ accepted: true }),
                            discard: () => ({ accepted: false }),
                            facts: () => ({ accepted: false }),
                        },
                    }),
                },
            },
            module: {
                id: 'fixture',
                version: '1',
                url: new URL('https://example.invalid/fixture-worker.js'),
            },
            workerCount: 1,
            maxRequests: 2,
            phaseLimits: { network: 1, decode: 1 },
            context: () => ({ key: 'owned', init: null }),
            candidate: demand => ({ candidateId: 'owned', page: demand.page }),
        })
        const request = executor.request({
            page,
            generation: 1,
            priority: { class: 'critical', score: 1 },
            reason: 'owned',
            usage: 'required',
        })

        await request.result
        await request.accept()
        await executor.dispose()

        expect(executor.inspect().contextPool).to.deep.include({
            state: 'disposed',
            systemOwnership: 'owned',
            disposalMode: 'remote-finalized',
        })
        expect(executor.inspect().workerFactsObservation)
            .to.equal('last-observed-before-disposal')
        expect(executor.inspect().system).to.deep.include({
            disposed: true,
            workerCount: 0,
            groupCount: 0,
        })
    })

    it('rolls back an owned pool when initial Worker facts fail', async() => {

        let failure
        try {
            await createVirtualRasterWorkerExecutor({
                id: 'failing-owned-raster-workers',
                system: {
                    ownership: 'owned',
                    options: {
                        maxWorkers: 1,
                        workerFactory: scriptedWorkerFactory({
                            operations: {
                                facts() {

                                    throw Object.assign(new Error('facts failed'), {
                                        code: 'FIXTURE_FACTS_FAILED',
                                    })
                                },
                            },
                        }),
                    },
                },
                module: {
                    id: 'fixture',
                    version: '1',
                    url: new URL('https://example.invalid/fixture-worker.js'),
                },
                workerCount: 1,
                maxRequests: 2,
                phaseLimits: { network: 1, decode: 1 },
                context: () => ({ key: 'failing', init: null }),
                candidate: demand => ({ candidateId: 'failing', page: demand.page }),
            })
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(Error)
        expect(ScriptedWorker.instances.at(-1).terminated).to.equal(true)
        expect(ScriptedWorker.instances.at(-1).contexts.size).to.equal(0)
    })
})
