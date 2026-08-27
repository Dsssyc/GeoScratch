import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'

const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'temporal-velocity-raster.ts'
)).href

describe('Flow Field temporal velocity raster', () => {

    it('owns exactly current, next, and prefetch runtimes', async() => {

        const { createTemporalVelocityRaster } = await import(moduleUrl)
        const live = new Set()
        const created = []
        const disposed = []
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 27,
            framesPerTime: 3,
            async createRuntime(timeIndex) {
                const runtime = Object.freeze({ timeIndex })
                created.push(timeIndex)
                live.add(runtime)
                return runtime
            },
            async disposeRuntime(runtime) {
                expect(live.delete(runtime)).to.equal(true)
                disposed.push(runtime.timeIndex)
            },
        })

        expect(created).to.deep.equal([ 0, 1, 2 ])
        expect(live.size).to.equal(3)
        expect(temporal.snapshot()).to.deep.include({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
            frameInTime: 0,
            progress: 0,
        })

        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({ frameInTime: 1, progress: 0.5 })
        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({ frameInTime: 2, progress: 1 })
        await temporal.advanceFrame()

        expect(temporal.snapshot()).to.deep.include({
            generation: 2,
            currentTimeIndex: 1,
            nextTimeIndex: 2,
            prefetchTimeIndex: 3,
            frameInTime: 0,
            progress: 0,
        })
        expect(created).to.deep.equal([ 0, 1, 2, 3 ])
        expect(disposed).to.deep.equal([ 0 ])
        expect(live.size).to.equal(3)

        await temporal.dispose()
        expect(disposed).to.deep.equal([ 0, 1, 2, 3 ])
        expect(live.size).to.equal(0)
        await temporal.dispose()
        expect(disposed).to.deep.equal([ 0, 1, 2, 3 ])
    })

    it('wraps the three-slot window and publishes immutable epochs', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?wrap=1`)
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 27,
            framesPerTime: 1,
            initialTimeIndex: 26,
            createRuntime: async timeIndex => Object.freeze({ timeIndex }),
            disposeRuntime: async() => {},
        })

        expect(temporal.snapshot()).to.deep.include({
            currentTimeIndex: 26,
            nextTimeIndex: 0,
            prefetchTimeIndex: 1,
        })
        expect(Object.isFrozen(temporal.snapshot())).to.equal(true)

        temporal.recordPublication(26, 4)
        temporal.recordPublication(0, 7)
        expect(temporal.snapshot()).to.deep.include({
            temporalResidencyEpoch: 2,
            currentSnapshotEpoch: 4,
            nextSnapshotEpoch: 7,
        })
        expect(() => temporal.recordPublication(1, 2))
            .to.throw('Prefetch publication cannot enter the active temporal pair')
        temporal.recordPrefetchPublication(1, 2)
        expect(() => temporal.recordPublication(26, 3))
            .to.throw('Velocity snapshot epochs must increase monotonically')

        await temporal.advanceFrame()
        expect(temporal.snapshot()).to.deep.include({
            generation: 2,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
            currentSnapshotEpoch: 7,
            nextSnapshotEpoch: 2,
            temporalResidencyEpoch: 3,
        })
        await temporal.dispose()
    })

    it('does not commit a rotation when prefetch creation fails', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?failure=1`)
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 4,
            framesPerTime: 1,
            async createRuntime(timeIndex) {
                if (timeIndex === 3) throw new Error('prefetch failed')
                return Object.freeze({ timeIndex })
            },
            disposeRuntime: async() => {},
        })

        let failure
        try {
            await temporal.advanceFrame()
        } catch (error) {
            failure = error
        }
        expect(failure?.message).to.equal('prefetch failed')
        expect(temporal.snapshot()).to.deep.include({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
            prefetchTimeIndex: 2,
        })
        await temporal.dispose()
    })

    it('aborts an in-flight replacement before disposing the three owned slots', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?dispose=1`)
        const disposed = []
        let replacementStarted
        const started = new Promise(resolve => { replacementStarted = resolve })
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 4,
            framesPerTime: 1,
            createRuntime(timeIndex, signal) {
                if (timeIndex !== 3) return Promise.resolve(Object.freeze({ timeIndex }))
                replacementStarted()
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            },
            async disposeRuntime(runtime) { disposed.push(runtime.timeIndex) },
        })

        const advancing = temporal.advanceFrame()
        await started
        const disposal = temporal.dispose()
        let advanceFailure
        try {
            await advancing
        } catch (error) {
            advanceFailure = error
        }
        await disposal

        expect(advanceFailure?.message).to.equal('Temporal velocity disposal requested')
        expect(disposed).to.deep.equal([ 0, 1, 2 ])
        expect(() => temporal.snapshot()).to.throw('Temporal velocity raster is disposed')
    })

    it('exposes only active bind resources and settles one current-next publication pair', async() => {

        const { createTemporalVelocityRaster } = await import(`${moduleUrl}?gpu-hooks=1`)
        const events = []
        const temporal = await createTemporalVelocityRaster({
            fieldCount: 27,
            framesPerTime: 1,
            createRuntime: async timeIndex => fakePublicationRuntime(timeIndex, events),
            disposeRuntime: runtime => runtime.dispose(),
        })

        expect(temporal.activeBindResources()).to.deep.equal({
            generation: 1,
            current: {
                timeIndex: 0,
                pageTable: { kind: 'page-table', timeIndex: 0 },
                atlas: { kind: 'atlas', timeIndex: 0 },
            },
            next: {
                timeIndex: 1,
                pageTable: { kind: 'page-table', timeIndex: 1 },
                atlas: { kind: 'atlas', timeIndex: 1 },
            },
        })
        const pending = temporal.setPendingPublications(
            temporal.current.publish(),
            temporal.next.publish()
        )
        expect(Object.isFrozen(pending)).to.equal(true)
        expect(pending).to.deep.include({
            generation: 1,
            currentTimeIndex: 0,
            nextTimeIndex: 1,
        })
        expect(() => temporal.advance()).to.throw('publication is pending')

        const builder = { kind: 'submission-builder' }
        temporal.encodePending(builder)
        await temporal.acknowledgePending({ kind: 'submitted-work' })
        const prefetchPublication = temporal.prefetch.publish()
        temporal.prefetch.gpu.encode(builder, prefetchPublication.update)
        await temporal.prefetch.acknowledge(
            prefetchPublication,
            { kind: 'submitted-work' }
        )
        temporal.recordPrefetchPublication(2, prefetchPublication.snapshotEpoch)

        expect(events).to.deep.equal([
            'publish:0',
            'publish:1',
            'encode:0',
            'encode:1',
            'acknowledge:0',
            'acknowledge:1',
            'publish:2',
            'encode:2',
            'acknowledge:2',
        ])
        expect(temporal.snapshot()).to.deep.include({
            temporalResidencyEpoch: 2,
            currentSnapshotEpoch: 10,
            nextSnapshotEpoch: 11,
        })
        expect(() => temporal.recordPublication(0, 12, 0)).to.throw('stale generation')

        await temporal.advance()
        expect(temporal.snapshot()).to.deep.include({
            currentTimeIndex: 1,
            nextTimeIndex: 2,
            prefetchTimeIndex: 3,
            currentSnapshotEpoch: 11,
            nextSnapshotEpoch: 12,
        })
        await temporal.dispose()
    })

    it('generates two public samplers with one shared address module and common-level retry', async() => {

        const { temporalVelocityWgslModule } = await import(`${moduleUrl}?wgsl=1`)
        const wrapper = fs.readFileSync(path.join(
            process.cwd(),
            'examples',
            'flowField',
            'shaders',
            'temporal-velocity.wgsl'
        ), 'utf8')
        const current = velocityModel('current')
        const next = velocityModel('next')
        const module = temporalVelocityWgslModule(current, next, {
            group: 2,
            currentPageTableBinding: 0,
            currentAtlasBinding: 1,
            nextPageTableBinding: 2,
            nextAtlasBinding: 3,
            wrapper,
        })

        expect(module.bindings).to.deep.equal({
            group: 2,
            current: { pageTable: 0, atlas: 1 },
            next: { pageTable: 2, atlas: 3 },
        })
        expect(module.code).to.include('fn FlowVelocityCurrent_sample_compute(')
        expect(module.code).to.include('fn FlowVelocityNext_sample_compute(')
        expect(module.code.match(/struct FlowVelocityAddressFixedPosition/g)).to.have.length(1)
        expect(module.code).to.include('fn FlowVelocity_sample(')
        expect(module.code).to.include('common_level = max(')
        expect(module.code).to.include('FlowVelocityCurrent_sample_compute(position, common_level)')
        expect(module.code).to.include('FlowVelocityNext_sample_compute(position, common_level)')
        expect(module.code).to.include(
            'let velocity = mix(current.value.xy, next.value.xy, temporal.progress);'
        )
        expect(module.code).to.not.match(/slot[_-]?table/i)
        expect(module.code).to.not.match(/prefetch/i)

        const source = fs.readFileSync(path.join(
            process.cwd(),
            'examples',
            'flowField',
            'temporal-velocity-raster.ts'
        ), 'utf8')
        expect(source).to.include('createVelocityTimeRuntime')
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
    })
})

function fakePublicationRuntime(timeIndex, events) {

    return {
        timeIndex,
        gpu: {
            pageTable: {
                region: () => Object.freeze({ kind: 'page-table', timeIndex }),
            },
            atlasView: Object.freeze({ kind: 'atlas', timeIndex }),
            encode(_builder, _update) { events.push(`encode:${timeIndex}`) },
        },
        publish() {

            events.push(`publish:${timeIndex}`)
            return Object.freeze({
                snapshotEpoch: 10 + timeIndex,
                update: Object.freeze({ timeIndex }),
            })
        },
        async acknowledge() { events.push(`acknowledge:${timeIndex}`) },
        async dispose() {},
    }
}

function velocityModel(id) {

    const limits = Array.from({ length: 6 }, (_value, index) => {
        const matrixId = String(index + 4)
        const tile = WebMercatorQuad.tileFromLonLat([ 121, 31 ], matrixId)
        return {
            matrixId,
            minTileRow: tile.tileRow,
            maxTileRow: tile.tileRow,
            minTileCol: tile.tileCol,
            maxTileCol: tile.tileCol,
        }
    })
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
    return webMercatorVirtualRasterField({
        id: `flow-velocity.${id}`,
        addressSpaceId: `flow-velocity-address.${id}`,
        sourceRevision: 'test-v1',
        coverage,
        geographicBounds: [ 120.5, 30.5, 121.5, 31.5 ],
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        interpolation: 'linear',
    })
}
