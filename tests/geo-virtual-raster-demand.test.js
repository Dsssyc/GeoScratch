import { expect } from 'chai'
import {
    VirtualRasterRequestScheduler,
    VirtualRasterResidency,
    prepareVirtualRasterPageTransfer,
    virtualRasterAddressSpace,
    virtualRasterDemandSet,
    virtualRasterPlane,
} from 'geoscratch/geo'

describe('virtual raster demand reconciliation', () => {

    it('deduplicates retained pages, reprioritizes them, and cancels obsolete work', async() => {

        const fixture = createFixture()
        const [ root, detail, replacement ] = fixture.pages
        const first = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 1,
            demands: [
                demand(root, 1, 'critical', 100, 'root-fallback', 'required'),
                demand(detail, 1, 'user-visible', 10, 'terrain-detail', 'required'),
            ],
        }))
        expect(first).to.deep.include({ requestedCount: 2, retainedCount: 0 })
        const rootRequest = fixture.executor.requests.get(root.key)
        const obsoleteRequest = fixture.executor.requests.get(detail.key)

        const second = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 2,
            demands: [
                demand(root, 2, 'critical', 200, 'root-fallback', 'required'),
                demand(replacement, 2, 'user-visible', 20, 'terrain-detail', 'required'),
            ],
        }))
        expect(second).to.deep.include({ requestedCount: 1, retainedCount: 1, cancelledCount: 1 })
        expect(rootRequest.reprioritized).to.deep.equal({ class: 'critical', score: 200 })
        expect(obsoleteRequest.cancelled).to.equal(true)

        rootRequest.resolve(transfer(root, 1))
        fixture.executor.requests.get(replacement.key).resolve(transfer(replacement, 3))
        await second.settled

        expect(rootRequest.accepted).to.equal(true)
        expect(fixture.residency.inspect()).to.deep.include({ stagedCount: 2, staleResponseCount: 0 })
        await fixture.scheduler.dispose()
    })

    it('discards late obsolete results before cache commit or residency staging', async() => {

        const fixture = createFixture({ cooperativeCancel: false })
        const [ , obsolete, current ] = fixture.pages
        fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 3,
            demands: [ demand(obsolete, 3, 'user-visible', 1, 'old-view', 'required') ],
        }))
        const oldRequest = fixture.executor.requests.get(obsolete.key)
        const currentSettlement = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 4,
            demands: [ demand(current, 4, 'user-visible', 1, 'new-view', 'required') ],
        }))
        oldRequest.resolve(transfer(obsolete, 7))
        fixture.executor.requests.get(current.key).resolve(transfer(current, 8))
        await currentSettlement.settled

        expect(oldRequest.accepted).to.equal(false)
        expect(oldRequest.discarded).to.equal(true)
        expect(fixture.residency.currentSnapshot.resolve(obsolete).status).to.equal('missing')
        expect(fixture.scheduler.inspect()).to.deep.include({ staleResultCount: 1 })
        await fixture.scheduler.dispose()
    })

    it('enforces a hard request budget while preserving critical root demand', async() => {

        const fixture = createFixture({ maxRequests: 2 })
        const [ root, detail, prefetch ] = fixture.pages
        const settlement = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 1,
            demands: [
                demand(prefetch, 1, 'background', 1000, 'prefetch', 'prefetch'),
                demand(detail, 1, 'user-visible', 1, 'detail', 'required'),
                demand(root, 1, 'critical', 0, 'root-fallback', 'required'),
            ],
        }))

        expect(settlement).to.deep.include({ requestedCount: 2, droppedCount: 1 })
        expect(fixture.executor.order).to.deep.equal([ root.key, detail.key ])
        for (const request of fixture.executor.requests.values()) {
            request.resolve(transfer(request.demand.page, 1))
        }
        await settlement.settled
        expect(fixture.scheduler.inspect()).to.deep.include({ degradationCount: 1 })
        await fixture.scheduler.dispose()
    })

    it('reuses staged and resident pages across newer demand generations', async() => {

        const fixture = createFixture()
        const page = fixture.pages[0]
        const first = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 1,
            demands: [ demand(page, 1, 'critical', 1, 'root', 'required') ],
        }))
        fixture.executor.requests.get(page.key).resolve(transfer(page, 1))
        await first.settled

        const staged = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 2,
            demands: [ demand(page, 2, 'critical', 2, 'root', 'required') ],
        }))
        expect(staged).to.deep.include({ requestedCount: 0, retainedCount: 1 })
        expect(fixture.residency.inspect()).to.deep.include({
            stagedCount: 1,
            staleResponseCount: 0,
        })

        const publication = fixture.scheduler.publish()
        await publication.acknowledge()
        const resident = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 3,
            demands: [ demand(page, 3, 'critical', 3, 'root', 'required') ],
        }))
        expect(resident).to.deep.include({ requestedCount: 0, retainedCount: 1 })
        expect(fixture.executor.order).to.deep.equal([ page.key ])
        await fixture.scheduler.dispose()
    })

    it('discards executor candidates when a request fails before transfer adoption', async() => {

        const fixture = createFixture()
        const page = fixture.pages[0]
        const settlement = fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 1,
            demands: [ demand(page, 1, 'user-visible', 1, 'detail', 'required') ],
        }))
        const request = fixture.executor.requests.get(page.key)
        request.reject(new Error('decode failed'))
        await settlement.settled

        expect(request.discarded).to.equal(true)
        expect(fixture.scheduler.inspect()).to.deep.include({ failedRequestCount: 1 })
        await fixture.scheduler.dispose()
    })

    it('waits for cancelled request disposal before scheduler disposal resolves', async() => {

        const fixture = createFixture({ rejectOnCancel: true })
        const page = fixture.pages[0]
        fixture.scheduler.reconcile(virtualRasterDemandSet({
            generation: 1,
            demands: [ demand(page, 1, 'user-visible', 1, 'detail', 'required') ],
        }))
        const request = fixture.executor.requests.get(page.key)

        await fixture.scheduler.dispose()

        expect(request.cancelled).to.equal(true)
        expect(request.discarded).to.equal(true)
        expect(fixture.scheduler.inspect()).to.deep.include({
            disposed: true,
            activeRequestCount: 0,
        })
    })

    it('rejects duplicate page demand and converges repeated disposal', async() => {

        const fixture = createFixture()
        const page = fixture.pages[0]
        expect(() => virtualRasterDemandSet({
            generation: 1,
            demands: [
                demand(page, 1, 'critical', 1, 'first', 'required'),
                demand(page, 1, 'critical', 2, 'duplicate', 'required'),
            ],
        })).to.throw()
        const first = fixture.scheduler.dispose()
        expect(fixture.scheduler.dispose()).to.equal(first)
        await first
        expect(fixture.scheduler.inspect()).to.deep.include({ disposed: true, activeRequestCount: 0 })
    })
})

function createFixture(options = {}) {

    const addressSpace = virtualRasterAddressSpace({
        id: 'demand.raster',
        dimensions: 2,
        extent: [ 6, 2 ],
        pageSize: [ 2, 2 ],
        levelCount: 1,
    })
    const plane = virtualRasterPlane({
        id: 'demand.height',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
    })
    const residency = new VirtualRasterResidency({
        addressSpace,
        plane,
        maxPhysicalPages: 3,
        maxStagingBytes: 12,
    })
    const executor = new FakeExecutor(options)
    const scheduler = new VirtualRasterRequestScheduler({
        residency,
        executor,
        maxRequests: options.maxRequests ?? 3,
        maxHistory: 8,
    })
    return {
        addressSpace,
        plane,
        residency,
        executor,
        scheduler,
        pages: [ 0, 1, 2 ].map(x => addressSpace.page({ level: 0, x, y: 0 })),
    }
}

function demand(page, generation, priorityClass, score, reason, usage) {

    return { page, generation, priority: { class: priorityClass, score }, reason, usage }
}

function transfer(page, value) {

    const prepared = prepareVirtualRasterPageTransfer({
        page,
        width: 2,
        height: 2,
        channels: 1,
        data: new Uint8Array([ value, value, value, value ]),
        contentVersion: `v${value}`,
    })
    return structuredClone(prepared.value, { transfer: [ ...prepared.transferables ] })
}

class FakeExecutor {

    requests = new Map()
    order = []
    options

    constructor(options) {
        this.options = options
    }

    request(demand) {
        const deferred = Promise.withResolvers()
        const request = {
            demand,
            result: deferred.promise,
            accepted: false,
            discarded: false,
            cancelled: false,
            reprioritized: undefined,
            cancel: () => {
                request.cancelled = true
                if (this.options.cooperativeCancel !== false || this.options.rejectOnCancel) {
                    deferred.reject(new Error('cancelled'))
                }
                return this.options.cooperativeCancel === false ? 'none' : 'cooperative'
            },
            reprioritize: priority => {
                request.reprioritized = priority
                return true
            },
            accept: async() => { request.accepted = true },
            discard: async() => { request.discarded = true },
            resolve: value => deferred.resolve(value),
            reject: error => deferred.reject(error),
        }
        this.order.push(demand.page.key)
        this.requests.set(demand.page.key, request)
        return request
    }
}
