import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import {
    FlowTemporalBindingSupersededError,
    createFlowTemporalBindings,
} from '../examples/flowField/flow-temporal-bindings.ts'

const HASH = '0123456789abcdef'.repeat(4)
const wrapper = fs.readFileSync(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'shaders',
    'temporal-velocity.wgsl'
), 'utf8')

describe('Flow Field temporal bindings', () => {

    it('holds one pair lease and snapshots alpha in independent frame captures', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const first = await provider.prepareFrame(1)

        expect(first).to.deep.include({
            state: 'ready',
            requestedRevision: 1,
            pairGeneration: 1,
            progress: 0.25,
            requestedLevel: 1,
            sampleRegistration: 'pixel-center',
        })
        expect(first.resources).to.deep.equal(fixture.resources())
        expect(provider.layout.group).to.equal(1)
        expect(provider.module.sampleRegistration).to.equal('pixel-center')
        expect(provider.wgsl).to.equal(provider.module.code)
        expect(fixture.captureCount).to.equal(2)
        expect(provider.facts()).to.deep.include({
            pairGeneration: 1,
            windowPairGeneration: 1,
            refreshCount: 0,
            activeFrameCount: 1,
            retiredBindingCount: 0,
            ownsWindow: false,
            disposed: false,
        })

        fixture.setAlpha(0.75)
        first.release()
        const second = await provider.prepareFrame(0)
        expect(second.progress).to.equal(0.75)
        expect(second.bindSet).to.equal(first.bindSet)
        expect(provider.facts().refreshCount).to.equal(0)
        expect(() => provider.prepareFrame(2)).to.throw(RangeError)

        second.release()
        await provider.dispose()
        expect(fixture.events.slice(-3)).to.deep.equal([
            'dispose-set:g1',
            'release-capture:g1:c1',
            'dispose-layout',
        ])
    })

    it('creates a replacement before retiring the captured old pair', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const oldFrame = await provider.prepareFrame(0)
        const oldSet = oldFrame.bindSet

        fixture.rotate('B', 'C', 0.4)
        const current = await provider.prepareFrame(0)
        expect(current).to.deep.include({ state: 'ready', pairGeneration: 2, progress: 0.4 })
        expect(current.bindSet).to.not.equal(oldSet)
        expect(oldSet.isDisposed).to.equal(false)
        expect(oldFrame.resources.slice(4).every(resource => !resource.isDisposed)).to.equal(true)
        expect(fixture.events.indexOf('create-set:g2')).to.be.greaterThan(
            fixture.events.indexOf('create-set:g1')
        )
        expect(provider.facts()).to.deep.include({
            pairGeneration: 2,
            refreshCount: 1,
            activeFrameCount: 2,
            retiredBindingCount: 1,
        })

        current.release()
        expect(oldSet.isDisposed).to.equal(false)
        oldFrame.release()
        expect(oldSet.isDisposed).to.equal(true)
        expect(oldFrame.resources.slice(4).every(resource => resource.isDisposed)).to.equal(true)
        expect(fixture.events.indexOf('dispose-set:g1')).to.be.lessThan(
            fixture.events.indexOf('release-capture:g1:c1')
        )

        await provider.dispose()
    })

    it('binds one exact runtime into both temporal slots without double release', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        fixture.rotateExact('B')

        const frame = await provider.prepareFrame(0)
        const bindings = frame.bindSet.bindings
        expect(bindings.currentPageTable.buffer).to.equal(bindings.nextPageTable.buffer)
        expect(bindings.currentAtlas).to.equal(bindings.nextAtlas)
        expect(bindings.currentMetadata.buffer).to.equal(bindings.nextMetadata.buffer)
        expect(frame.resources[0]).to.equal(frame.resources[2])
        expect(frame.resources[1]).to.equal(frame.resources[3])
        expect(frame.progress).to.equal(0)

        frame.release()
        frame.release()
        await provider.dispose()
        expect(fixture.releaseEvents('g2')).to.have.length(2)
    })

    it('rotates different coverage through one shader contract and keeps old metadata leased', async () => {
        const fixture = windowFixture(key => {
            if (key !== 'C' && key !== 'D') return undefined
            const coverage = tileMatrixCoverage({tileMatrixSet: WebMercatorQuad, limits: [6, 8, 10].map(matrix => {
                const tile = WebMercatorQuad.tileFromLonLat([10, 1], String(matrix))
                return {matrixId: String(matrix), minTileCol: tile.tileCol, maxTileCol: tile.tileCol,
                    minTileRow: tile.tileRow, maxTileRow: tile.tileRow}
            })})
            return webMercatorVirtualRasterField({id: key, addressSpaceId: key, sourceRevision: '1', coverage,
                geographicBounds: [9.9, .9, 10.1, 1.1], fieldKind: 'vector', channels: 2,
                sampleType: 'float32', gpuFormat: 'rg32float', interpolation: 'linear'})
        })
        const provider = await createFlowTemporalBindings({window: fixture.window, wrapper})
        const code = provider.wgsl, first = await provider.prepareFrame(1)
        fixture.rotate('C', 'D', .5)
        const second = await provider.prepareFrame(2)
        expect(provider.wgsl).to.equal(code)
        expect(provider.facts().levelCount).to.equal(3)
        expect(second.bindSet.layout).to.equal(first.bindSet.layout)
        expect(first.resources.slice(4).every(resource => !resource.isDisposed)).to.equal(true)
        expect(second.resources[4].data).to.not.deep.equal(first.resources[4].data)
        first.release(); second.release()
        expect(first.resources.slice(4).every(resource => resource.isDisposed)).to.equal(true)
        fixture.rotate('A', 'B', .25)
        const third = await provider.prepareFrame(1)
        expect(provider.wgsl).to.equal(code)
        expect(provider.facts().levelCount).to.equal(2)
        third.release(); await provider.dispose()
        expect(third.resources.slice(4).every(resource => resource.isDisposed)).to.equal(true)
    })

    it('never exposes the retained pair for loading, gap, or failed window states', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })

        fixture.setLoading()
        expect(await provider.prepareFrame(0)).to.deep.include({ state: 'loading' })
        fixture.setFailed()
        expect(await provider.prepareFrame(0)).to.deep.include({ state: 'failed' })
        fixture.setGap()
        expect(await provider.prepareFrame(0)).to.deep.include({ state: 'gap' })
        expect(provider.pairGeneration).to.equal(0)
        expect(fixture.events).to.include.members([
            'dispose-set:g1',
            'release-capture:g1:c1',
        ])

        await provider.dispose()
    })

    it('rejects stale async replacements and keeps the old pair usable', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        fixture.rotate('B', 'C', 0.25)
        const gate = fixture.deferNextSet()
        const preparing = provider.prepareFrame(0)
        await fixture.event('create-set:g2')
        fixture.rotate('C', 'D', 0.5)
        gate.resolve()

        let failure
        try {
            await preparing
        } catch (error) {
            failure = error
        }
        expect(failure).to.be.instanceOf(FlowTemporalBindingSupersededError)
        expect(failure.message).to.include('changed during binding refresh')
        expect(provider.pairGeneration).to.equal(1)
        expect(fixture.events).to.include.members([
            'dispose-set:g2',
            'release-capture:g2:c2',
        ])

        const latest = await provider.prepareFrame(0)
        expect(latest).to.deep.include({ state: 'ready', pairGeneration: 3, progress: 0.5 })
        latest.release()
        await provider.dispose()
    })

    it('propagates a BindSet rejection unchanged and preserves the old pair', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const oldFrame = await provider.prepareFrame(0)
        const oldSet = oldFrame.bindSet
        const bindFailure = Object.assign(new Error('synthetic BindSet rejection'), {
            code: 'SYNTHETIC_BIND_SET_FAILURE',
        })

        fixture.rotate('B', 'C', 0.5)
        fixture.failNextSet(bindFailure)
        let failure
        try {
            await provider.prepareFrame(0)
        } catch (error) {
            failure = error
        }

        expect(failure).to.equal(bindFailure)
        expect(failure).to.not.be.instanceOf(FlowTemporalBindingSupersededError)
        expect(provider.pairGeneration).to.equal(1)
        expect(oldSet.isDisposed).to.equal(false)
        expect(oldFrame.bindSet).to.equal(oldSet)
        expect(fixture.events).to.include('release-capture:g2:c3')

        oldFrame.release()
        const retried = await provider.prepareFrame(0)
        expect(retried).to.deep.include({ state: 'ready', pairGeneration: 2 })
        expect(retried.bindSet).to.not.equal(oldSet)
        retried.release()
        await provider.dispose()
    })

    it('suspends the long pair capture and rebuilds it on later demand', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const initialSet = fixture.createdSets()[0]

        await provider.suspend()
        expect(provider.pairGeneration).to.equal(0)
        expect(initialSet.isDisposed).to.equal(true)
        expect(fixture.events).to.include('release-capture:g1:c1')

        const rebuilt = await provider.prepareFrame(0)
        expect(rebuilt).to.deep.include({ state: 'ready', pairGeneration: 1 })
        expect(rebuilt.bindSet).to.not.equal(initialSet)
        expect(provider.facts()).to.deep.include({
            pairGeneration: 1,
            refreshCount: 1,
            activeFrameCount: 1,
        })

        rebuilt.release()
        await provider.dispose()
        expect(fixture.releaseEvents('g1')).to.have.length(3)
    })

    it('defers suspended pair retirement until an outstanding frame releases', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const frame = await provider.prepareFrame(0)
        const retainedSet = frame.bindSet

        await provider.suspend()
        expect(provider.facts()).to.deep.include({
            pairGeneration: 0,
            activeFrameCount: 1,
            retiredBindingCount: 1,
        })
        expect(retainedSet.isDisposed).to.equal(false)
        expect(fixture.events).to.not.include('release-capture:g1:c1')

        frame.release()
        expect(retainedSet.isDisposed).to.equal(true)
        expect(fixture.events).to.include.members([
            'release-capture:g1:c1',
            'release-capture:g1:c2',
        ])

        const rebuilt = await provider.prepareFrame(0)
        expect(rebuilt.bindSet).to.not.equal(retainedSet)
        rebuilt.release()
        await provider.dispose()
    })

    it('blocks a new preparation while an in-flight refresh is being suspended', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        fixture.rotate('B', 'C', 0.5)
        const gate = fixture.deferNextSet()
        const preparing = provider.prepareFrame(0)
        await fixture.event('create-set:g2')

        const suspending = provider.suspend()
        expect(provider.facts().suspending).to.equal(true)
        expect(() => provider.prepareFrame(0)).to.throw(/being suspended/)
        gate.resolve()
        const refreshed = await preparing
        await suspending

        expect(provider.pairGeneration).to.equal(0)
        expect(refreshed.bindSet.isDisposed).to.equal(false)
        refreshed.release()
        expect(refreshed.bindSet.isDisposed).to.equal(true)

        const rebuilt = await provider.prepareFrame(0)
        expect(rebuilt).to.deep.include({ state: 'ready', pairGeneration: 2 })
        rebuilt.release()
        await provider.dispose()
    })

    it('waits for an in-flight refresh and outstanding frame during async disposal', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        const oldFrame = await provider.prepareFrame(0)
        fixture.rotate('B', 'C', 0.5)
        const gate = fixture.deferNextSet()
        const preparing = provider.prepareFrame(0)
        await fixture.event('create-set:g2')
        const disposing = provider.dispose()
        gate.resolve()

        let prepareFailure
        try {
            await preparing
        } catch (error) {
            prepareFailure = error
        }
        expect(prepareFailure).to.be.instanceOf(Error)
        expect(fixture.events).to.include('dispose-set:g2')
        let disposed = false
        void disposing.then(() => { disposed = true })
        await Promise.resolve()
        expect(disposed).to.equal(false)

        oldFrame.release()
        await disposing
        expect(provider.facts().disposed).to.equal(true)
        expect(fixture.events.at(-1)).to.equal('dispose-layout')
    })

    it('rejects mixed registration and releases the rejected pair capture', async() => {

        const fixture = windowFixture()
        const provider = await createFlowTemporalBindings({ window: fixture.window, wrapper })
        fixture.rotate('B', 'C', 0.5, 'pixel-center', 'global-texel-lattice')

        let failure
        try {
            await provider.prepareFrame(0)
        } catch (error) {
            failure = error
        }
        expect(failure).to.be.instanceOf(TypeError)
        expect(failure.message).to.include('shared registration')
        expect(fixture.events).to.include('release-capture:g2:c2')
        expect(provider.pairGeneration).to.equal(1)

        await provider.dispose()
    })

    it('loads the production wrapper through the colocated raw asset path', () => {

        const source = fs.readFileSync(path.join(
            process.cwd(), 'examples', 'flowField', 'flow-temporal-bindings.ts'
        ), 'utf8')
        expect(source).to.include("import('./shaders/temporal-velocity.wgsl?raw')")
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.include('packages/geoscratch/src')
    })
})

function windowFixture(modelForKey) {

    const events = []
    const runtime = fakeRuntime(events)
    const runtimes = new Map()
    let pairGeneration = 1
    let requestedRevision = 1
    let alpha = 0.25
    let state = 'ready'
    let lower = sample('A', 0)
    let upper = sample('B', 1)
    let lowerRuntime = timeRuntime(runtime, 'A', 'pixel-center')
    let upperRuntime = timeRuntime(runtime, 'B', 'pixel-center')
    runtimes.set('A', lowerRuntime)
    runtimes.set('B', upperRuntime)
    let captureSequence = 0

    const window = {
        capture() {

            if (state === 'loading') {
                return Object.freeze({ state, requestedRevision, selection: undefined })
            }
            if (state === 'gap') {
                return Object.freeze({
                    state,
                    requestedRevision,
                    selection: Object.freeze({
                        kind: 'gap',
                        modelTime: 0.5,
                        lower,
                        upper,
                        reason: 'omitted-source-samples',
                    }),
                })
            }
            if (state === 'failed') {
                return Object.freeze({
                    state,
                    requestedRevision,
                    selection: undefined,
                    failureCode: 'runtime-failed',
                    error: new Error('synthetic failure'),
                })
            }
            const captureId = `g${pairGeneration}:c${++captureSequence}`
            events.push(`capture:${captureId}`)
            let released = false
            const exact = lower.sampleKey === upper.sampleKey
            return Object.freeze({
                state: 'ready',
                requestedRevision,
                pairGeneration,
                selection: exact
                    ? Object.freeze({ kind: 'exact', modelTime: lower.modelTime, sample: lower })
                    : Object.freeze({
                        kind: 'interpolated',
                        modelTime: lower.modelTime +
                            (upper.modelTime - lower.modelTime) * alpha,
                        lower,
                        upper,
                        alpha,
                    }),
                alpha: exact ? 0 : alpha,
                lower: Object.freeze({ sample: lower, runtime: lowerRuntime }),
                upper: Object.freeze({ sample: upper, runtime: upperRuntime }),
                release() {

                    if (released) return
                    released = true
                    events.push(`release-capture:${captureId}`)
                },
            })
        },
        snapshot() {

            return Object.freeze({ state, pairGeneration })
        },
    }

    function runtimeFor(key, registration) {

        const existing = runtimes.get(key)
        if (existing !== undefined && existing.source.sampleRegistration === registration) {
            return existing
        }
        const created = timeRuntime(runtime, key, registration, modelForKey?.(key))
        runtimes.set(key, created)
        return created
    }

    return {
        events,
        window,
        get captureCount() { return captureSequence },
        resources() {

            return [
                lowerRuntime.gpu.pageTable,
                lowerRuntime.gpu.atlasView.texture,
                upperRuntime.gpu.pageTable,
                upperRuntime.gpu.atlasView.texture,
                ...Object.values(runtime.createdSets().at(-1).bindings).filter(value =>
                    value?.buffer?.isSamplerMetadata).map(value => value.buffer),
            ]
        },
        releaseEvents(generation) {

            return events.filter(value => value.startsWith(`release-capture:${generation}:`))
        },
        setAlpha(value) {

            alpha = value
            requestedRevision++
        },
        rotate(
            lowerKey,
            upperKey,
            nextAlpha,
            lowerRegistration = 'pixel-center',
            upperRegistration = lowerRegistration
        ) {

            pairGeneration++
            requestedRevision++
            alpha = nextAlpha
            state = 'ready'
            lower = sample(lowerKey, pairGeneration)
            upper = sample(upperKey, pairGeneration + 1)
            lowerRuntime = runtimeFor(lowerKey, lowerRegistration)
            upperRuntime = runtimeFor(upperKey, upperRegistration)
        },
        rotateExact(key) {

            pairGeneration++
            requestedRevision++
            state = 'ready'
            lower = sample(key, pairGeneration)
            upper = lower
            lowerRuntime = runtimeFor(key, 'pixel-center')
            upperRuntime = lowerRuntime
        },
        setLoading() { state = 'loading'; requestedRevision++ },
        setGap() { state = 'gap'; requestedRevision++; pairGeneration++ },
        setFailed() { state = 'failed'; requestedRevision++ },
        deferNextSet: runtime.deferNextSet,
        failNextSet: runtime.failNextSet,
        createdSets: runtime.createdSets,
        event: name => waitFor(() => events.includes(name)),
    }
}

function sample(key, index) {

    return Object.freeze({
        sampleKey: `t${String(index).padStart(2, '0')}-${key}`,
        timeIndex: index,
        modelTime: index,
        unit: 'hour',
        phase: 'test',
        sourceHash: HASH,
    })
}

function timeRuntime(runtime, id, sampleRegistration, model = velocityModel(id)) {
    const pageTable = fakeResource(runtime, `${id}-page-table`)
    const atlas = fakeResource(runtime, `${id}-atlas`)
    return {
        source: Object.freeze({ sampleRegistration }),
        model,
        gpu: {
            runtime, addressSpace: model.addressSpace, plane: model.plane,
            pageTable, atlas,
            atlasView: Object.freeze({ texture: atlas, id: `${id}-atlas-view` }),
        },
    }
}

function velocityModel(id) {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            {
                matrixId: '8',
                minTileRow: 105,
                maxTileRow: 105,
                minTileCol: 214,
                maxTileCol: 214,
            },
            {
                matrixId: '9',
                minTileRow: 210,
                maxTileRow: 210,
                minTileCol: 428,
                maxTileCol: 428,
            },
        ],
    })
    return webMercatorVirtualRasterField({
        id: `flow-${id}`,
        addressSpaceId: `flow-address-${id}`,
        sourceRevision: 'test-v1',
        coverage,
        geographicBounds: [ 120, 30, 122, 32 ],
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        interpolation: 'linear',
    })
}

function fakeResource(runtime, id) {

    const resource = {
        runtime,
        id,
        allocationVersion: 1,
        region: () => Object.freeze({ buffer: resource, id: `${id}-region` }),
    }
    return resource
}

function fakeRuntime(events) {

    let nextSetGate
    let nextSetFailure
    const createdSets = []
    let metadataSequence = 0
    return {
        async createMappedBuffer(descriptor) {

            const buffer = fakeResource(this, 'metadata-' + ++metadataSequence)
            Object.assign(buffer, {isSamplerMetadata: true, isDisposed: false, state: 'pending',
                size: descriptor.size, usage: descriptor.usage, contentEpoch: 0,
                dispose() { this.isDisposed = true },
            })
            const view = new ArrayBuffer(descriptor.size)
            return {buffer, lease: {view, dispose() {
                buffer.state = 'ready'; buffer.contentEpoch = 1; buffer.data = new Uint8Array(view).slice()
            }}}
        },
        async createBindLayout(descriptor) {

            return {
                ...descriptor,
                runtime: this,
                dispose() { events.push('dispose-layout') },
            }
        },
        async createBindSet(layout, bindings, options) {

            const generation = Number(/pair (\d+)/.exec(options.label)?.[1])
            events.push(`create-set:g${generation}`)
            const gate = nextSetGate
            nextSetGate = undefined
            if (gate !== undefined) await gate.promise
            const failure = nextSetFailure
            nextSetFailure = undefined
            if (failure !== undefined) throw failure
            const bindSet = {
                runtime: this,
                layout,
                bindings,
                isDisposed: false,
                dispose() {

                    if (this.isDisposed) return
                    this.isDisposed = true
                    events.push(`dispose-set:g${generation}`)
                },
            }
            createdSets.push(bindSet)
            return bindSet
        },
        deferNextSet() {

            const gate = deferred()
            nextSetGate = gate
            return gate
        },
        failNextSet(error) {

            nextSetFailure = error
        },
        createdSets() {

            return [ ...createdSets ]
        },
    }
}

function deferred() {

    let resolve
    const promise = new Promise(accepted => { resolve = accepted })
    return { promise, resolve }
}

async function waitFor(predicate) {

    const deadline = Date.now() + 1000
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for event')
        await new Promise(resolve => setTimeout(resolve, 0))
    }
}
