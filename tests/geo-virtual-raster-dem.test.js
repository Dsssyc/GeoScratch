import { expect } from 'chai'
import {
    TaskPhaseBudget,
} from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    ViewDemandProducer,
    VirtualRasterRequestScheduler,
    VirtualRasterResidency,
    createVirtualRasterDemandController,
    createGeoViewSnapshot,
    ownedVirtualRasterPagePayload,
    prepareVirtualRasterPageTransfer,
    webMercatorVirtualRasterField,
    webMercatorVirtualRasterWgslModule,
} from 'geoscratch/geo'
import {
    DEM_WEB_MERCATOR_COORDINATE_BITS,
    createDemTileSource,
    fetchDemTileSource,
} from '../examples/demLayer/dem-source.ts'
import {
    readDemCachePolicy,
} from '../examples/demLayer/dem-cache-policy.ts'
import {
    DEM_CACHE_PANEL_DEFAULT_CONFIG,
    DEM_CACHE_PANEL_STORAGE_KEY,
    DEM_RENDERING_PREFERENCE_STORAGE_KEY,
    removeDemCacheParameters,
    replaceDemCacheParameters,
    resolveDemRenderingPreference,
    resolveDemCachePanelConfig,
    serializeDemCachePanelConfig,
    serializeDemRenderingPreference,
} from '../examples/demLayer/dem-control-state.ts'
import { prepareDemControlPanel } from '../examples/demLayer/dem-control-panel.ts'
import { demWebMercatorManifest as manifest } from './fixtures/dem-webmercator-manifest.js'

describe('DEM WebMercator virtual raster', () => {

    describe('DEM cache panel configuration', () => {

        it('uses the existing no-cache defaults without URL or stored state', () => {

            const resolved = resolveDemCachePanelConfig(new URLSearchParams(), null)

            expect(DEM_CACHE_PANEL_STORAGE_KEY).to.equal(
                'geoscratch.examples.dem.cache-panel.v1'
            )
            expect(resolved.source).to.equal('default')
            expect(resolved.storageStatus).to.equal('missing')
            expect(resolved.config).to.deep.equal(DEM_CACHE_PANEL_DEFAULT_CONFIG)
            expect(resolved.parameters.toString()).to.equal('')
            expect(readDemCachePolicy(resolved.parameters)).to.deep.equal({ mode: 'none' })
        })

        it('restores a complete versioned preference for a bare URL', () => {

            const stored = serializeDemCachePanelConfig({
                policy: 'durable',
                namespace: 'editable-dem',
                maxMiB: 512,
                maxEntries: 8192,
                persistence: 'request',
            })
            const resolved = resolveDemCachePanelConfig(
                new URLSearchParams('tileServer=http%3A%2F%2Flocalhost%3A8787&atlasPages=32'),
                stored
            )

            expect(JSON.parse(stored)).to.deep.equal({
                schemaVersion: 1,
                config: {
                    policy: 'durable',
                    namespace: 'editable-dem',
                    maxMiB: 512,
                    maxEntries: 8192,
                    persistence: 'request',
                },
            })
            expect(resolved.source).to.equal('storage')
            expect(resolved.storageStatus).to.equal('valid')
            expect(resolved.config.policy).to.equal('durable')
            expect(resolved.parameters.get('tileServer')).to.equal('http://localhost:8787')
            expect(resolved.parameters.get('atlasPages')).to.equal('32')
            expect(readDemCachePolicy(resolved.parameters)).to.deep.equal({
                mode: 'persistent',
                namespace: 'editable-dem',
                maxPayloadBytes: 512 * 1024 * 1024,
                maxEntries: 8192,
                requestPersistence: true,
                lifecycle: { kind: 'durable', open: 'reuse' },
            })
        })

        it('treats any explicit cache URL state as authoritative', () => {

            const stored = serializeDemCachePanelConfig({
                ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                policy: 'durable',
            })
            const explicit = resolveDemCachePanelConfig(
                new URLSearchParams('cache=none&atlasPages=16'),
                stored
            )

            expect(explicit.source).to.equal('url')
            expect(explicit.storageStatus).to.equal('valid')
            expect(explicit.config.policy).to.equal('disabled')
            expect(explicit.parameters.toString()).to.equal('cache=none&atlasPages=16')
            expect(() => resolveDemCachePanelConfig(
                new URLSearchParams('cacheLifecycle=session'),
                stored
            )).to.throw('cache=none cannot accept cacheLifecycle')
            expect(() => resolveDemCachePanelConfig(
                new URLSearchParams('cache=none&cache=none'),
                stored
            )).to.throw('Duplicate DEM cache option: cache')
        })

        it('maps every panel policy into the existing strict query contract', () => {

            const expected = [
                [ 'disabled', { mode: 'none' } ],
                [ 'session', {
                    mode: 'persistent',
                    lifecycle: { kind: 'session' },
                } ],
                [ 'durable', {
                    mode: 'persistent',
                    lifecycle: { kind: 'durable', open: 'reuse' },
                } ],
                [ 'clear-on-open', {
                    mode: 'persistent',
                    lifecycle: { kind: 'durable', open: 'clear-before-open' },
                } ],
            ]
            for (const [ policy, facts ] of expected) {
                const parameters = replaceDemCacheParameters(
                    new URLSearchParams('proof=1'),
                    { ...DEM_CACHE_PANEL_DEFAULT_CONFIG, policy }
                )
                expect(parameters.get('proof')).to.equal('1')
                expect(readDemCachePolicy(parameters)).to.deep.include(facts)
                if (policy === 'disabled') {
                    expect(parameters.toString()).to.equal('proof=1&cache=none')
                } else {
                    expect([ ...parameters.keys() ].filter(key => key.startsWith('cache')))
                        .to.deep.equal([
                            'cache',
                            'cacheLifecycle',
                            'cacheNamespace',
                            'cacheMaxMiB',
                            'cacheMaxEntries',
                            'cachePersistence',
                        ])
                }
            }
        })

        it('rejects invalid drafts and safely ignores damaged stored state', () => {

            for (const invalid of [
                '{',
                JSON.stringify({ schemaVersion: 2, config: DEM_CACHE_PANEL_DEFAULT_CONFIG }),
                JSON.stringify({ schemaVersion: 1, config: {
                    ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                    maxMiB: 0,
                } }),
                JSON.stringify({ schemaVersion: 1, config: {
                    ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                    policy: 'forever',
                } }),
            ]) {
                const resolved = resolveDemCachePanelConfig(new URLSearchParams(), invalid)
                expect(resolved.source).to.equal('default')
                expect(resolved.storageStatus).to.equal('invalid')
                expect(resolved.config).to.deep.equal(DEM_CACHE_PANEL_DEFAULT_CONFIG)
            }
            expect(() => serializeDemCachePanelConfig({
                ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                namespace: '',
            })).to.throw('namespace')
            expect(() => replaceDemCacheParameters(new URLSearchParams(), {
                ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                maxEntries: 65_537,
            })).to.throw('cacheMaxEntries')
        })

        it('replaces and removes only cache query parameters', () => {

            const current = new URLSearchParams([
                [ 'tileServer', 'http://localhost:8787' ],
                [ 'cache', 'persistent' ],
                [ 'cacheLifecycle', 'session' ],
                [ 'proof', '1' ],
                [ 'cacheNamespace', 'old' ],
            ])
            const next = replaceDemCacheParameters(current, {
                policy: 'clear-on-open',
                namespace: 'new-dem',
                maxMiB: 256,
                maxEntries: 4096,
                persistence: 'best-effort',
            })

            expect(current.get('cacheNamespace')).to.equal('old')
            expect(next.get('tileServer')).to.equal('http://localhost:8787')
            expect(next.get('proof')).to.equal('1')
            expect(next.get('cacheLifecycle')).to.equal('durable-clear-before-open')
            expect(next.get('cacheNamespace')).to.equal('new-dem')
            expect(next.get('cacheMaxMiB')).to.equal('256')
            expect(next.get('cacheMaxEntries')).to.equal('4096')
            expect(next.get('cachePersistence')).to.equal('best-effort')
            expect(removeDemCacheParameters(next).toString()).to.equal(
                'tileServer=http%3A%2F%2Flocalhost%3A8787&proof=1'
            )
        })

        it('prepares browser preferences and degrades unavailable local storage', () => {

            const stored = serializeDemCachePanelConfig({
                ...DEM_CACHE_PANEL_DEFAULT_CONFIG,
                policy: 'session',
            })
            const available = fakeStorage({
                [DEM_CACHE_PANEL_STORAGE_KEY]: stored,
            })
            const restored = prepareDemControlPanel({
                parameters: new URLSearchParams('proof=1'),
                storage: available.storage,
            })

            expect(restored.source).to.equal('storage')
            expect(restored.storageStatus).to.equal('valid')
            expect(restored.parameters.get('proof')).to.equal('1')
            expect(restored.parameters.get('cacheLifecycle')).to.equal('session')

            available.storage.setItem(DEM_CACHE_PANEL_STORAGE_KEY, '{')
            const damaged = prepareDemControlPanel({
                parameters: new URLSearchParams(),
                storage: available.storage,
            })
            expect(damaged.source).to.equal('default')
            expect(damaged.storageStatus).to.equal('invalid')
            expect(available.storage.getItem(DEM_CACHE_PANEL_STORAGE_KEY)).to.equal(null)

            const unavailable = prepareDemControlPanel({
                parameters: new URLSearchParams('cache=none'),
                storage: {
                    getItem: () => null,
                    setItem: () => { throw new DOMException('denied', 'SecurityError') },
                    removeItem: () => {},
                },
            })
            expect(unavailable.source).to.equal('url')
            expect(unavailable.storageStatus).to.equal('unavailable')
            expect(unavailable.config.policy).to.equal('disabled')
        })
    })

    describe('DEM rendering preference', () => {

        it('defaults to shaded terrain without stored state', () => {

            expect(DEM_RENDERING_PREFERENCE_STORAGE_KEY).to.equal(
                'geoscratch.examples.demLayer.rendering.v1'
            )
            expect(resolveDemRenderingPreference(null)).to.deep.equal({
                preference: { tileWireframe: false },
                storageStatus: 'missing',
            })
        })

        it('round trips a strict versioned tile-wireframe preference', () => {

            const stored = serializeDemRenderingPreference({ tileWireframe: true })

            expect(stored).to.equal('{"version":1,"tileWireframe":true}')
            expect(resolveDemRenderingPreference(stored)).to.deep.equal({
                preference: { tileWireframe: true },
                storageStatus: 'valid',
            })
        })

        it('falls back safely for malformed or structurally invalid state', () => {

            for (const stored of [
                '{',
                '{"version":2,"tileWireframe":true}',
                '{"version":1,"tileWireframe":"yes"}',
                '{"version":1,"tileWireframe":true,"extra":1}',
                'null',
            ]) {
                expect(resolveDemRenderingPreference(stored)).to.deep.equal({
                    preference: { tileWireframe: false },
                    storageStatus: 'invalid',
                })
            }
            expect(() => serializeDemRenderingPreference({ tileWireframe: 'yes' }))
                .to.throw('tileWireframe')
        })
    })

    it('keeps DEM disk caching explicit and application configurable', () => {

        expect(readDemCachePolicy(new URLSearchParams())).to.deep.equal({ mode: 'none' })
        expect(readDemCachePolicy(new URLSearchParams('cache=persistent'))).to.deep.equal({
            mode: 'persistent',
            namespace: 'geoscratch-dem-webmercator-raw-v2',
            maxPayloadBytes: 128 * 1024 * 1024,
            maxEntries: 2048,
            requestPersistence: false,
            lifecycle: { kind: 'session' },
        })
        expect(readDemCachePolicy(new URLSearchParams([
            [ 'cache', 'persistent' ],
            [ 'cacheNamespace', 'editable-dem' ],
            [ 'cacheLifecycle', 'durable-reuse' ],
            [ 'cacheMaxMiB', '512' ],
            [ 'cacheMaxEntries', '8192' ],
            [ 'cachePersistence', 'request' ],
        ]))).to.deep.equal({
            mode: 'persistent',
            namespace: 'editable-dem',
            maxPayloadBytes: 512 * 1024 * 1024,
            maxEntries: 8192,
            requestPersistence: true,
            lifecycle: { kind: 'durable', open: 'reuse' },
        })
        expect(readDemCachePolicy(new URLSearchParams(
            'cache=persistent&cacheLifecycle=durable-clear-before-open'
        )).lifecycle).to.deep.equal({ kind: 'durable', open: 'clear-before-open' })
    })

    it('rejects ignored or unbounded DEM cache configuration', () => {

        for (const query of [
            'cache=none&cacheNamespace=ignored',
            'cache=persistent&cacheLifecycle=unknown',
            'cache=persistent&cacheMaxMiB=0',
            'cache=persistent&cacheMaxEntries=65537',
            'cache=persistent&cachePersistence=forever',
            'cache=persistent&cacheUnknown=1',
            'cache=persistent&cacheLifecycle=session&cacheLifecycle=session',
        ]) {
            expect(() => readDemCachePolicy(new URLSearchParams(query))).to.throw()
        }
    })

    it('configures and enforces independent network and decode concurrency budgets', async() => {

        const budget = new TaskPhaseBudget({
            id: 'dem-worker-phases',
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
            id: 'dem-worker-phases',
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
            id: 'dem-worker-phases',
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

    it('validates standard manifest facts and builds a compact tile address space', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const { model } = source

        expect(source.manifest).to.deep.equal(manifest)
        expect(source.facts.contentVersion).to.equal(source.manifest.contentVersion)
        expect(Object.isFrozen(source)).to.equal(true)
        expect(Object.isFrozen(source.manifest)).to.equal(true)
        expect(Object.isFrozen(source.model)).to.equal(true)
        expect(model.coverage.entryCount).to.equal(49)
        expect(model.addressSpace.pageTableEntryCount).to.equal(49)
        expect(model.addressSpace.pageSize).to.deep.equal([ 256, 256 ])
        expect(model.addressSpace.levelCount).to.equal(7)
        expect(model.addressSpace.matrixId(0)).to.equal('10')
        expect(model.addressSpace.matrixId(6)).to.equal('4')
        expect(model.safetyCoverPages.map(page => page.key)).to.deep.equal([ '4/6/13' ])
        expect(model.addressCodec.coordinateBits).to.equal(DEM_WEB_MERCATOR_COORDINATE_BITS)
        expect(model.addressCodec.quantumMeters).to.be.lessThan(0.001)
        expect(model.spatialProfile.coverage).to.equal(model.coverage)
        expect(model.representation.field).to.equal(model.field)
        expect(model.representation.plane).to.equal(model.plane)
        expect(model.representation.spatialProfile).to.equal(model.spatialProfile)
        expect(model.kind).to.equal('web-mercator-virtual-raster-field')
        expect(model.field).to.deep.include({
            kind: 'geo-field',
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            unit: 'm',
            interpolation: 'linear',
        })
        expect(model.plane).to.deep.include({
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
    })

    it('keeps one feedback window of request continuity before cancellation', async() => {

        const fixture = await createGpuDemandFixture()
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const parent = fixture.model.addressSpace.parent(child)
        const firstFeedback = feedbackAt(
            7,
            fixture.acknowledgedSnapshotEpoch(),
            [
                gpuDemand(fixture, child, parent, 10),
                gpuDemand(fixture, child, parent, 90),
            ]
        )

        const first = fixture.adapter.reconcileFeedback(
            firstFeedback,
            viewAt(firstFeedback)
        )
        expect(first).to.deep.include({ requestedCount: 1, retainedCount: 0, retiredCount: 0 })
        expect(fixture.executor.requests.get(child.key).demand.priority).to.deep.equal({
            class: 'user-visible',
            score: 90,
        })
        expect(fixture.adapter.lease.facts().retainedPages.map(page => page.pageKey))
            .to.include.members(fixture.model.safetyCoverPages.map(page => page.key))

        const secondFeedback = feedbackAt(
            8,
            fixture.acknowledgedSnapshotEpoch(),
            []
        )
        const second = fixture.adapter.reconcileFeedback(
            secondFeedback,
            viewAt(secondFeedback)
        )
        expect(second.generation).to.be.greaterThan(first.generation)
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(1)
        expect(fixture.executor.requests.get(child.key).cancelled).to.equal(false)
        expect(fixture.adapter.facts()).to.deep.include({
            feedbackDemandGraceGenerations: 1,
            deferredDemandCount: 1,
        })

        const thirdFeedback = feedbackAt(
            9,
            fixture.acknowledgedSnapshotEpoch(),
            []
        )
        const third = fixture.adapter.reconcileFeedback(
            thirdFeedback,
            viewAt(thirdFeedback)
        )
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)
        expect(fixture.executor.requests.get(child.key).cancelled).to.equal(true)
        expect(fixture.adapter.facts().deferredDemandCount).to.equal(0)
        await Promise.all([ second.settlement, third.settlement ])

        let staleFailure
        try {
            fixture.adapter.reconcileFeedback(firstFeedback, viewAt(firstFeedback))
        } catch (error) {
            staleFailure = error
        }
        expect(staleFailure).to.be.instanceOf(GeoDiagnosticError)
        expect(staleFailure.diagnostic).to.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)
        await fixture.dispose()
    })

    it('coalesces alternating GPU feedback without restarting page requests', async() => {

        const fixture = await createGpuDemandFixture()
        const firstChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const secondChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 13,
            tileCol: 26,
        })
        const firstParent = fixture.model.addressSpace.parent(firstChild)
        const secondParent = fixture.model.addressSpace.parent(secondChild)

        const feedback = (frameEpoch, child, parent) => feedbackAt(
            frameEpoch,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 50) ]
        )
        fixture.adapter.reconcileFeedback(feedback(7, firstChild, firstParent), viewAt(
            feedback(7, firstChild, firstParent)
        ))
        const firstRequest = fixture.executor.requests.get(firstChild.key)
        fixture.adapter.reconcileFeedback(feedback(8, secondChild, secondParent), viewAt(
            feedback(8, secondChild, secondParent)
        ))
        const secondRequest = fixture.executor.requests.get(secondChild.key)
        fixture.adapter.reconcileFeedback(feedback(9, firstChild, firstParent), viewAt(
            feedback(9, firstChild, firstParent)
        ))
        fixture.adapter.reconcileFeedback(feedback(10, secondChild, secondParent), viewAt(
            feedback(10, secondChild, secondParent)
        ))

        expect(fixture.scheduler.inspect()).to.deep.include({
            activeRequestCount: 2,
            cancellationCount: 0,
        })
        expect(fixture.executor.requests.get(firstChild.key)).to.equal(firstRequest)
        expect(fixture.executor.requests.get(secondChild.key)).to.equal(secondRequest)
        expect(firstRequest.cancelled).to.equal(false)
        expect(secondRequest.cancelled).to.equal(false)

        const firstEmpty = feedbackAt(11, fixture.acknowledgedSnapshotEpoch(), [])
        fixture.adapter.reconcileFeedback(firstEmpty, viewAt(firstEmpty))
        expect(firstRequest.cancelled).to.equal(true)
        expect(secondRequest.cancelled).to.equal(false)
        const secondEmpty = feedbackAt(12, fixture.acknowledgedSnapshotEpoch(), [])
        fixture.adapter.reconcileFeedback(secondEmpty, viewAt(secondEmpty))
        expect(secondRequest.cancelled).to.equal(true)
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)

        await fixture.dispose()
    })

    it('never lets deferred feedback displace current demand under budget pressure', async() => {

        const fixture = await createGpuDemandFixture({ maxRequests: 2 })
        const deferredChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const currentChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 13,
            tileCol: 26,
        })
        const firstFeedback = feedbackAt(
            7,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, deferredChild, fixture.model.addressSpace.parent(deferredChild), 100) ]
        )
        fixture.adapter.reconcileFeedback(firstFeedback, viewAt(firstFeedback))
        const deferredRequest = fixture.executor.requests.get(deferredChild.key)

        const secondFeedback = feedbackAt(
            8,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, currentChild, fixture.model.addressSpace.parent(currentChild), 1) ]
        )
        fixture.adapter.reconcileFeedback(secondFeedback, viewAt(secondFeedback))

        expect(deferredRequest.cancelled).to.equal(true)
        expect(fixture.executor.requests.has(currentChild.key)).to.equal(true)
        expect(fixture.scheduler.inspect()).to.deep.include({
            activeRequestCount: 1,
            demandedPageCount: 2,
        })
        expect(fixture.adapter.facts()).to.deep.include({
            feedbackDemandGraceGenerations: 1,
            deferredDemandCount: 0,
            activeDemandCount: 2,
        })

        await fixture.dispose()
    })

    it('rejects GPU demand outside the configured virtual-raster coverage', async() => {

        const fixture = await createGpuDemandFixture()
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const parent = fixture.model.addressSpace.parent(child)
        const foreign = Object.freeze({ ...child, addressSpaceId: 'foreign.raster' })
        let failure
        try {
            const feedback = feedbackAt(
                3,
                fixture.acknowledgedSnapshotEpoch(),
                [ { ...gpuDemand(fixture, child, parent, 1), page: foreign } ]
            )
            fixture.adapter.reconcileFeedback(feedback, viewAt(feedback))
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(GeoDiagnosticError)
        expect(failure.diagnostic).to.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
        expect(fixture.scheduler.inspect().generation).to.equal(1)
        await fixture.dispose()
    })

    it('holds transition parents and pending children until later acknowledged retirement', async() => {

        const fixture = await createGpuDemandFixture({ maxPhysicalPages: 4 })
        const parent = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        await fixture.installOutsideDemand(parent, 2)
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '6',
            tileRow: 25,
            tileCol: 53,
        })
        const parentEntry = fixture.residency.currentSnapshot.resolve(parent)
        const demandedFeedback = feedbackAt(
            10,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 50) ]
        )
        const demanded = fixture.adapter.reconcileFeedback(
            demandedFeedback,
            viewAt(demandedFeedback)
        )
        expect(demanded.retainedCount).to.equal(1)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        fixture.executor.requests.get(child.key).resolve(transfer(child, 31))
        await demanded.settlement
        const pendingPublication = fixture.scheduler.publish()
        fixture.adapter.retainPublication(pendingPublication)
        const pendingChild = pendingPublication.snapshot.resolve(child)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: child.key,
            generation: pendingChild.generation,
        })

        const beforeAcknowledgementFeedback = feedbackAt(
            11,
            fixture.acknowledgedSnapshotEpoch(),
            [],
            [ gpuRetirement(parent, parentEntry, 11, fixture.acknowledgedSnapshotEpoch()) ]
        )
        const beforeAcknowledgement = fixture.adapter.reconcileFeedback(
            beforeAcknowledgementFeedback,
            viewAt(beforeAcknowledgementFeedback)
        )
        expect(beforeAcknowledgement.retiredCount).to.equal(0)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        await pendingPublication.abandon()
        fixture.adapter.abandonPublication(pendingPublication)
        expect(fixture.adapter.lease.facts().retainedPages).not.to.deep.include({
            pageKey: child.key,
            generation: pendingChild.generation,
        })
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        const retriedFeedback = feedbackAt(
            12,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 60) ]
        )
        const retried = fixture.adapter.reconcileFeedback(
            retriedFeedback,
            viewAt(retriedFeedback)
        )
        fixture.executor.requests.get(child.key).resolve(transfer(child, 32))
        await retried.settlement
        const acknowledgedPublication = fixture.scheduler.publish()
        fixture.adapter.retainPublication(acknowledgedPublication)
        await acknowledgedPublication.acknowledge()
        fixture.adapter.acknowledgePublication(acknowledgedPublication)

        const retiredFeedback = feedbackAt(
            13,
            fixture.acknowledgedSnapshotEpoch(),
            [],
            [ gpuRetirement(parent, parentEntry, 13, fixture.acknowledgedSnapshotEpoch()) ]
        )
        const retired = fixture.adapter.reconcileFeedback(
            retiredFeedback,
            viewAt(retiredFeedback)
        )
        expect(retired.retiredCount).to.equal(1)
        expect(fixture.adapter.lease.facts().retainedPages).not.to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: child.key,
            generation: acknowledgedPublication.snapshot.resolve(child).generation,
        })
        await fixture.dispose()
    })

    it('rejects GPU feedback that does not belong to the supplied Geo view snapshot', async() => {

        const fixture = await createGpuDemandFixture()
        const feedback = feedbackAt(7, fixture.acknowledgedSnapshotEpoch(), [])
        const mismatchedView = createGeoViewSnapshot({
            ...viewDescriptorAt(feedback),
            frameEpoch: feedback.frameEpoch + 1,
        })

        expect(() => fixture.adapter.reconcileFeedback(feedback, mismatchedView))
            .to.throw(GeoDiagnosticError)
        expect(fixture.scheduler.inspect().generation).to.equal(1)
        await fixture.dispose()
    })

    it('constructs only the standard row/column endpoint with immutable content identity', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const { model } = source
        const page = model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: 418,
            tileCol: 858,
        })

        expect(source.tileUrl(page)).to.equal(
            'http://127.0.0.1:8787/tiles/WebMercatorQuad/10/418/858.png' +
            '?v=dem-aa7a584830f19877-cog-wmq-v3'
        )
    })

    it('uses every covered minimum-matrix tile as the safety cover', () => {

        const expanded = structuredClone(manifest)
        expanded.tileMatrixSet.limits[0] = {
            matrixId: '4',
            minTileRow: 6,
            maxTileRow: 7,
            minTileCol: 12,
            maxTileCol: 13,
        }
        const { model } = createDemTileSource({
            manifest: expanded,
            tileServerUrl: 'http://127.0.0.1:8787',
        })

        expect(model.safetyCoverPages.map(page => page.key)).to.deep.equal([
            '4/6/12',
            '4/6/13',
            '4/7/12',
            '4/7/13',
        ])
    })

    it('bypasses stale browser cache when fetching the mutable manifest endpoint', async() => {

        const originalFetch = globalThis.fetch
        let requestedUrl
        let requestOptions
        globalThis.fetch = async(input, options) => {
            requestedUrl = String(input)
            requestOptions = options
            return { ok: true, json: async() => manifest }
        }
        let result
        try {
            result = await fetchDemTileSource(
                'http://127.0.0.1:8787/',
                new AbortController().signal
            )
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(requestedUrl).to.equal('http://127.0.0.1:8787/manifest.json')
        expect(requestOptions.cache).to.equal('no-store')
        expect(result.manifest.contentVersion).to.equal(manifest.contentVersion)
        expect(result.model.addressSpace.levelCount).to.equal(7)
    })

    it('emits direct fixed-Mercator sampling without persistent per-node addresses', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787',
        })
        const { model } = source
        const wgsl = webMercatorVirtualRasterWgslModule(model, {
            namespace: 'DemHeight',
            addressNamespace: 'DemAddress',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
            transitionTexels: 16,
        }).code
        const generic = webMercatorVirtualRasterField({
            id: 'test-height',
            addressSpaceId: 'test-height-address-space',
            sourceRevision: source.manifest.contentVersion,
            coverage: model.coverage,
            geographicBounds: source.manifest.source.geographicBounds,
            coordinateBits: DEM_WEB_MERCATOR_COORDINATE_BITS,
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
            unit: 'm',
            interpolation: 'linear',
            scale: source.manifest.scale,
            offset: source.manifest.offset,
        })
        const genericWgsl = webMercatorVirtualRasterWgslModule(generic, {
            namespace: 'TestHeight',
            addressNamespace: 'TestAddress',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
            transitionTexels: 16,
        })

        expect(model.addressCodec.bytesPerPosition).to.equal(16)
        expect(generic.kind).to.equal('web-mercator-virtual-raster-field')
        expect(genericWgsl.code).to.include('fn TestHeight_sample_vertex(')
        expect(genericWgsl.code).to.include('fn TestAddress_address(')
        expect(wgsl).to.include('fn DemAddress_address(')
        expect(wgsl).to.include('fn DemHeight_load_position(')
        expect(wgsl).to.include('fn DemHeight_sample_vertex(')
        expect(wgsl).to.include('fn DemHeight_resolution_global(')
        expect(wgsl).to.include('fn DemHeight_sample_level(')
        expect(wgsl).to.include('fn DemHeight_edge_blend_weight(')
        expect(wgsl).to.include('fn DemHeight_failed(level: u32)')
        expect(wgsl).to.include('if (status == 4u) { return DemHeight_failed(level); }')
        expect(wgsl).to.include('tl.status == 4u || tr.status == 4u')
        expect(wgsl).to.include('const DemHeight_transition_texels = 16.0f')
        expect(wgsl).to.include('iteration < DemHeight_level_count')
        expect(wgsl).to.include('DemHeight_matrix[sample_level]')
        expect(wgsl).to.include('DemAddress_compact_index')
        expect(wgsl).to.include('vec2u(3414u, 1662u)')
        expect(wgsl).to.include('vec2u(3435u, 1673u)')
        expect(wgsl).to.not.include('logicalTexel')
        expect(wgsl).to.not.include('canonicalNodes')
        expect(wgsl).to.not.include('DemCanonical')
        expect(wgsl).to.not.include('_mercator')
        expect(wgsl).to.not.include('f64')
    })
})

function fakeStorage(initial = {}) {

    const values = new Map(Object.entries(initial))
    return {
        values,
        storage: {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
            removeItem: key => values.delete(key),
        },
    }
}

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

async function createGpuDemandFixture({ maxPhysicalPages = 6, maxRequests = 24 } = {}) {

    const { model } = createDemTileSource({
        manifest,
        tileServerUrl: 'http://127.0.0.1:8787',
    })
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages,
        maxStagingBytes: maxPhysicalPages * 256 * 256,
        maxHistory: 16,
    })
    const executor = new FakeExecutor()
    const scheduler = new VirtualRasterRequestScheduler({
        residency,
        executor,
        maxRequests,
        maxHistory: 16,
    })
    const viewDemandProducer = new ViewDemandProducer({
        id: 'dem-test-view-demand',
        maxDemands: scheduler.maxRequests,
    })
    const adapter = createVirtualRasterDemandController({
        model,
        residency,
        scheduler,
        viewDemandProducer,
        maxPhysicalPages,
        maxHistory: 16,
    })
    const initialization = adapter.initialize()
    for (const request of executor.requests.values()) {
        request.resolve(transfer(request.demand.page, 17))
    }
    await initialization.settled
    const publication = scheduler.publish()
    adapter.retainPublication(publication)
    await publication.acknowledge()
    adapter.acknowledgePublication(publication)
    return {
        model,
        residency,
        scheduler,
        executor,
        adapter,
        acknowledgedSnapshotEpoch: () => adapter.facts().acknowledgedSnapshotEpoch,
        async installOutsideDemand(page, generation) {
            residency.stage(ownedVirtualRasterPagePayload({
                page,
                width: 256,
                height: 256,
                channels: 1,
                data: new Uint8Array(256 * 256).fill(23),
                contentVersion: `outside-${generation}`,
            }), { generation })
            const outside = scheduler.publish()
            adapter.retainPublication(outside)
            await outside.acknowledge()
            adapter.acknowledgePublication(outside)
        },
        async dispose() {
            await scheduler.dispose()
            adapter.dispose()
            residency.dispose()
        },
    }
}

function viewAt(feedback) {

    return createGeoViewSnapshot(viewDescriptorAt(feedback))
}

function viewDescriptorAt(feedback) {

    return {
        id: 'dem-test-view',
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [ 0, 0, 1 ],
        cameraLow: [ 0, 0, 0 ],
        viewport: [ 1280, 800 ],
        verticalFovRadians: 1,
        cameraLatitudeRadians: 0,
        cameraPitchRadians: 0,
        zoomHint: 5,
        frameEpoch: feedback.frameEpoch,
        residencySnapshotEpoch: feedback.residencySnapshotEpoch,
    }
}

function feedbackAt(frameEpoch, residencySnapshotEpoch, demands, retirements = []) {

    return Object.freeze({
        kind: 'virtual-raster-gpu-feedback-batch',
        ringId: 'test-feedback-ring',
        frontierId: 'test-frontier',
        submissionId: `test-submission-${frameEpoch}`,
        frameEpoch,
        residencySnapshotEpoch,
        demands: Object.freeze(demands.map(demand => Object.freeze({
            ...demand,
            decisionFrameEpoch: frameEpoch,
            residencySnapshotEpoch,
        }))),
        retirements: Object.freeze(retirements.map(retirement => Object.freeze({
            ...retirement,
            decisionFrameEpoch: frameEpoch,
            residencySnapshotEpoch,
        }))),
        facts: Object.freeze({
            frameEpoch,
            residencySnapshotEpoch,
            activeFrontierCount: 1,
            visibleInstanceCount: 1,
            refineCandidateCount: demands.length > 0 ? 1 : 0,
            coarsenCandidateCount: retirements.length > 0 ? 1 : 0,
            demandCount: demands.length,
            fallbackCount: 0,
            staleGenerationCount: 0,
            budgetLimitedCount: 0,
            maximumObservedSse: 1,
            frontierOverflow: false,
            demandOverflow: false,
            visibleOverflow: false,
            convergenceState: demands.length > 0 ? 'transitioning' : 'converged',
        }),
        counters: Object.freeze({
            currentFrontierCount: 1,
            nextFrontierCount: 1,
            visibleInstanceCount: 1,
            refineCandidateCount: demands.length > 0 ? 1 : 0,
            coarsenCandidateCount: retirements.length > 0 ? 1 : 0,
            demandCount: demands.length,
            retirementCount: retirements.length,
            staleGenerationCount: 0,
            budgetLimitedCount: 0,
            lookupDuplicateCount: 0,
            balanceRejectedCount: 0,
            fallbackCount: 0,
            acceptedRefineCount: demands.length > 0 ? 1 : 0,
            acceptedCoarsenCount: retirements.length > 0 ? 1 : 0,
            discardedStaleRetirementCount: 0,
        }),
        diagnostics: Object.freeze([]),
    })
}

function gpuDemand(fixture, page, parent, priority) {

    const parentEntry = fixture.residency.currentSnapshot.resolve(parent)
    const tile = page.tile
    return {
        page,
        parent,
        parentCompactIndex: fixture.model.addressSpace.tableIndex(parent),
        parentPhysicalSlot: parentEntry.physicalSlot,
        parentGeneration: parentEntry.generation,
        priority,
        decisionFrameEpoch: 0,
        residencySnapshotEpoch: 0,
        childMask: 1 << ((tile.tileRow % 2) * 2 + tile.tileCol % 2),
    }
}

function gpuRetirement(page, entry, decisionFrameEpoch, residencySnapshotEpoch) {

    return {
        page,
        physicalSlot: entry.physicalSlot,
        generation: entry.generation,
        contentEpoch: entry.contentEpoch,
        decisionFrameEpoch,
        residencySnapshotEpoch,
    }
}

function transfer(page, value) {

    const prepared = prepareVirtualRasterPageTransfer({
        page,
        width: 256,
        height: 256,
        channels: 1,
        data: new Uint8Array(256 * 256).fill(value),
        contentVersion: `feedback-${value}`,
    })
    return structuredClone(prepared.value, { transfer: [ ...prepared.transferables ] })
}

class FakeExecutor {

    requests = new Map()

    request(demand) {

        const deferred = Promise.withResolvers()
        const request = {
            demand,
            result: deferred.promise,
            cancelled: false,
            cancel: () => {
                request.cancelled = true
                deferred.reject(new Error('cancelled'))
                return 'cooperative'
            },
            reprioritize: priority => {
                request.demand = { ...request.demand, priority }
                return true
            },
            accept: async() => {},
            discard: async() => {},
            resolve: value => deferred.resolve(value),
        }
        this.requests.set(demand.page.key, request)
        return request
    }
}
