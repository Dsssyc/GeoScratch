import { expect } from 'chai'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    virtualRasterCacheAddress,
} from 'geoscratch/geo'
import {
    createVelocitySampleSource,
    createVelocityTimeSource,
} from '../examples/flowField/velocity-source.ts'
import {
    loadFlowDatasetManifest,
} from '../examples/flowField/flow-dataset.ts'
import velocityWorker from '../examples/flowField/velocity-tile-worker.ts'
import {
    FLOW_FIELD_VELOCITY_TILE_WORKER,
} from '../examples/flowField/velocity-tile-protocol.ts'
import {
    FLOW_FIELD_CACHE_DISABLED,
} from '../examples/flowField/cache-policy.ts'
import {
    createVelocityWorkerRequestExecutor,
} from '../examples/flowField/velocity-tile-executor.ts'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const HASH = '0123456789abcdef'.repeat(4)
const SOURCE_BOUNDS = Object.freeze([
    120.0449447631836,
    29.434587478637695,
    123.0562973022461,
    32.26061248779297,
])

describe('Flow Field velocity source contract', () => {

    it('loads one immutable 27-time z4-z9 velocity manifest', async() => {

        const requested = []
        const manifest = await loadManifest(validManifest(), requested)

        expect(requested).to.deep.equal([ {
            url: 'http://127.0.0.1:8788/manifest.json',
            init: { cache: 'no-store' },
        } ])
        expect(manifest.times).to.have.length(27)
        expect(manifest.tileMatrixSet.limits.map(limit => limit.matrixId))
            .to.deep.equal([ '4', '5', '6', '7', '8', '9' ])
        expect(manifest.pages).to.have.length(27 * 59)
        expect(Object.isFrozen(manifest)).to.equal(true)
        expect(Object.isFrozen(manifest.times)).to.equal(true)
        expect(Object.isFrozen(manifest.pages)).to.equal(true)
    })

    it('rejects wrong counts, hashes, basis, page length, coverage, and times', async() => {

        const cases = [
            ['station count', manifest => { manifest.stationCount-- }],
            ['source hash', manifest => { manifest.sourceHash = 'not-a-sha256' }],
            ['time count', manifest => { manifest.times.pop() }],
            ['time order', manifest => { manifest.times[1].timeIndex = 2 }],
            ['time hash', manifest => { manifest.times[0].sourceHash = 'bad' }],
            ['basis', manifest => { manifest.basis = 'east-north' }],
            ['page length', manifest => { manifest.pages[0].byteLength = 8 }],
            ['page hash', manifest => { manifest.pages[0].sha256 = 'bad' }],
            ['coverage level', manifest => { manifest.tileMatrixSet.limits.splice(2, 1) }],
            ['coverage page count', manifest => { manifest.pages.pop() }],
            ['coverage bounds', manifest => {
                const limit = manifest.tileMatrixSet.limits.at(-1)
                const removedColumn = limit.minTileCol
                limit.minTileCol++
                manifest.pages = manifest.pages.filter(page => !(
                    page.matrixId === limit.matrixId && page.tileCol === removedColumn
                ))
            }],
        ]
        for (const [name, mutate] of cases) {
            const input = validManifest()
            mutate(input)
            let failure
            try {
                await loadManifest(input)
            } catch (error) {
                failure = error
            }
            expect(failure, name).to.be.instanceOf(TypeError)
        }
    })

    it('creates one public vector Virtual Raster model and exact immutable tile authority', async() => {

        const manifest = await loadManifest(validManifest())
        const source = createVelocityTimeSource(manifest, 0)
        const page = finestPage(source)
        const tile = page.tile

        expect(source.sampleKey).to.equal('t00')
        expect(source.timeIndex).to.equal(0)
        expect(source.sampleRegistration).to.equal('global-texel-lattice')
        expect(source.model.field).to.deep.include({
            fieldKind: 'vector',
            channels: 2,
            sampleType: 'float32',
            unit: 'legacy-flow-unit',
            interpolation: 'linear',
        })
        expect(source.model.plane).to.deep.include({
            fieldKind: 'vector',
            channels: 2,
            sampleType: 'float32',
            gpuFormat: 'rg32float',
        })
        expect(source.tileUrl(page)).to.equal(
            'http://127.0.0.1:8788/tiles/WebMercatorQuad/' +
            `t00/${tile.matrixId}/${tile.tileRow}/${tile.tileCol}.rg32f`
        )
        expect(source.expectedPage(page)).to.deep.include({
            timeIndex: 0,
            matrixId: tile.matrixId,
            tileRow: tile.tileRow,
            tileCol: tile.tileCol,
            byteLength: 524288,
        })
        expect(source.resolvePage(page).url).to.equal(source.tileUrl(page))
        expect(Object.isFrozen(source)).to.equal(true)
        expect(() => createVelocityTimeSource(manifest, 27)).to.throw(TypeError)
    })

    it('creates a pixel-center sampleKey source from published runtime coverage and page URLs', () => {

        const dataset = normalizedRuntimeDataset()
        const source = createVelocitySampleSource(dataset, 't04')
        const limit = dataset.tileMatrixSet.coverage.limit('10')
        const page = source.model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: limit.minTileRow,
            tileCol: limit.minTileCol,
        })

        expect(source.sampleKey).to.equal('t04')
        expect(source.timeIndex).to.equal(4)
        expect(source.sample.modelTime).to.equal(12.5)
        expect(source.sampleRegistration).to.equal('pixel-center')
        expect(source.representation).to.equal(dataset.representation)
        expect(source.model.coverage).to.equal(dataset.tileMatrixSet.coverage)
        expect(source.model.addressSpace.levelForMatrix('10')).to.equal(0)
        expect(source.model.addressSpace.levelForMatrix('4')).to.equal(6)
        expect(source.model.addressSpace.id).to.include(dataset.sourceHash.slice(0, 16))
        expect(source.model.addressSpace.id).to.include(dataset.contentVersion)
        expect(source.model.field.unit).to.equal(dataset.unit)
        expect(source.model.plane.auxiliaryAxes).to.deep.include({
            name: 'vector-basis',
            value: dataset.basis,
        })
        expect(source.resolvePage(page)).to.deep.include({
            sampleKey: 't04',
            timeIndex: 4,
            url: `https://tiles.example.test/runtime/t04/10/${limit.minTileRow}/` +
                `${limit.minTileCol}.rg32f`,
        })
        expect(() => source.model.addressSpace.levelForMatrix('15')).to.throw()
        expect(() => createVelocitySampleSource(dataset, 't09')).to.throw(RangeError)
        expect(() => source.resolvePage({ ...page, addressSpaceId: 'another-field' }))
            .to.throw(TypeError)
        expect(Object.isFrozen(source)).to.equal(true)
    })

    it('keeps Flow Field source assembly on public GeoScratch capabilities', () => {

        const source = read('examples', 'flowField', 'velocity-source.ts')

        expect(source).to.include("fieldKind: 'vector'")
        expect(source).to.include('channels: 2')
        expect(source).to.include("sampleType: 'float32'")
        expect(source).to.include("gpuFormat: 'rg32float'")
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.include('packages/geoscratch/src')
        expect(source).to.not.include('../flowLayer')
    })

    it('implements the fixed seven-operation velocity Worker contract', () => {

        expect(FLOW_FIELD_VELOCITY_TILE_WORKER).to.deep.include({
            id: 'geoscratch-flow-field-velocity-tile',
            version: '1',
        })
        expect(velocityWorker).to.deep.include({
            id: FLOW_FIELD_VELOCITY_TILE_WORKER.id,
            version: FLOW_FIELD_VELOCITY_TILE_WORKER.version,
        })
        expect(Object.keys(velocityWorker.context.operations).sort()).to.deep.equal([
            'accept',
            'decode',
            'discard',
            'facts',
            'fetch',
            'lookup',
            'transfer',
        ])
    })

    it('validates raw RG32F length, checksum, and finite values before transfer', async() => {

        const manifest = await loadManifest(validManifest())
        const source = createVelocityTimeSource(manifest, 0)
        const page = finestPage(source)
        const context = workerContext()
        const state = await velocityWorker.context.create({ cache: { mode: 'none' } }, context)
        const data = new Float32Array(256 * 256 * 2)
        data[0] = 1.25
        data[1] = -0.5
        const descriptor = candidateDescriptor(source, page, data.buffer)
        const originalFetch = globalThis.fetch
        globalThis.fetch = async() => new Response(data.buffer.slice(0), {
            status: 200,
            headers: { 'content-type': 'application/vnd.geoscratch.flow-rg32f' },
        })
        try {
            expect(await velocityWorker.context.operations.lookup(state, descriptor, context))
                .to.deep.equal({ status: 'miss' })
            const fetched = await velocityWorker.context.operations.fetch(
                state,
                descriptor,
                context
            )
            expect(fetched).to.deep.include({ status: 200, encodedByteLength: 524288 })
            const decoded = await velocityWorker.context.operations.decode(
                state,
                { candidateId: descriptor.candidateId },
                context
            )
            expect(decoded.kind).to.equal('worker-transfer-result')
            expect(decoded.value).to.deep.include({
                kind: 'virtual-raster-page-transfer',
                width: 256,
                height: 256,
                channels: 2,
                dataType: 'float32',
                contentVersion: manifest.contentVersion,
            })
            expect(decoded.value.buffer.byteLength).to.equal(524288)
            const facts = await velocityWorker.context.operations.accept(
                state,
                { candidateId: descriptor.candidateId },
                context
            )
            expect(facts).to.deep.include({
                networkRequestCount: 1,
                decodedPageCount: 1,
                acceptedCandidateCount: 1,
                pendingCandidateCount: 0,
            })
        } finally {
            globalThis.fetch = originalFetch
            await velocityWorker.context.dispose(state)
        }
    })

    it('rejects malformed velocity payloads before they become page transfers', async() => {

        const manifest = await loadManifest(validManifest())
        const source = createVelocityTimeSource(manifest, 0)
        const page = finestPage(source)
        const context = workerContext()
        const originalFetch = globalThis.fetch
        try {
            const short = new ArrayBuffer(16)
            await expectWorkerFailure(source, page, short, sha256(short), context, 'BYTE_LENGTH')

            const finite = new Float32Array(256 * 256 * 2)
            await expectWorkerFailure(source, page, finite.buffer, HASH, context, 'CHECKSUM')

            const nonFinite = new Float32Array(256 * 256 * 2)
            nonFinite[7] = Number.NaN
            await expectWorkerFailure(
                source,
                page,
                nonFinite.buffer,
                sha256(nonFinite.buffer),
                context,
                'NON_FINITE'
            )
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('propagates cache-hit cancellation without deleting valid immutable bytes', async() => {

        const manifest = await loadManifest(validManifest())
        const source = createVelocityTimeSource(manifest, 0)
        const page = finestPage(source)
        const payload = new Float32Array(256 * 256 * 2).buffer
        const descriptor = candidateDescriptor(source, page, payload)
        let deletionCount = 0
        const state = {
            cache: {
                async get() {

                    return {
                        status: 'hit',
                        record: {
                            metadata: {
                                ...descriptor.cacheAddress.metadata,
                                width: 256,
                                height: 256,
                                channels: 2,
                                dataType: 'float32',
                                layout: 'rg-interleaved-le',
                                contentVersion: descriptor.contentVersion,
                                sha256: descriptor.expectedSha256,
                            },
                            payload,
                            byteLength: payload.byteLength,
                        },
                    }
                },
                async delete() { deletionCount++ },
            },
            candidates: new Map(),
            networkRequestCount: 0,
            decodedPageCount: 0,
            acceptedCandidateCount: 0,
            discardedCandidateCount: 0,
            maxPendingCandidateCount: 0,
        }
        let abortReads = 0
        const context = {
            ...workerContext(),
            signal: {
                get aborted() { return ++abortReads >= 5 },
                reason: 'cancelled during cached payload validation',
            },
        }
        let failure
        try {
            await velocityWorker.context.operations.lookup(state, descriptor, context)
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(Error)
        expect(failure.name).to.equal('AbortError')
        expect(deletionCount).to.equal(0)
    })

    it('borrows the application WorkerSystem while the runtime owns its executor', () => {

        const source = read('examples', 'flowField', 'velocity-source.ts')
        const executor = read('examples', 'flowField', 'velocity-tile-executor.ts')

        expect(FLOW_FIELD_CACHE_DISABLED).to.deep.equal({ mode: 'none' })
        expect(Object.isFrozen(FLOW_FIELD_CACHE_DISABLED)).to.equal(true)
        expect(executor).to.include("ownership: 'borrowed'")
        expect(executor).to.include('system: descriptor.workerSystem')
        expect(executor).to.include('descriptor.workerModules.resolve(')
        expect(executor).to.include("payloadRepresentation: 'raw/float32-rg-interleaved-le'")
        expect(executor).to.include('plane: `velocity.${descriptor.sampleKey}`')
        expect(executor).to.include('url: expected.url')
        expect(executor).to.not.include('descriptor.timeIndex')
        expect(source).to.include('createVirtualRasterRuntime')
        expect(source).to.include("ownership: 'owned'")
        expect(source).to.include('executor: requestExecutor')
        expect(source).to.not.match(/workerSystem\.(?:dispose|terminate)/)
    })

    it('rejects invalid persistent cache budgets before resolving a Worker module', async() => {

        let resolverCalls = 0
        let failure
        try {
            await createVelocityWorkerRequestExecutor({
                sourceId: 'flow-field-test',
                sampleKey: 't00',
                contentVersion: 'flow-field-test-v1',
                cachePolicy: {
                    mode: 'persistent',
                    namespace: 'flow-field-test',
                    maxPayloadBytes: 524288,
                    maxEntries: 0,
                    requestPersistence: false,
                    lifecycle: { kind: 'session' },
                },
                workerSystem: { maxWorkers: 1 },
                workerModules: {
                    resolve() {

                        resolverCalls++
                        throw new Error('module resolution should not run')
                    },
                },
                maxRequests: 1,
                resolvePage: () => ({
                    url: 'https://example.test/tile.rg32f',
                    byteLength: 524288,
                    sha256: HASH,
                }),
            })
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(TypeError)
        expect(resolverCalls).to.equal(0)
    })
})

async function loadManifest(manifest, requested = []) {

    const originalFetch = globalThis.fetch
    globalThis.fetch = async(input, init) => {
        requested.push({ url: String(input), init })
        return new Response(JSON.stringify(manifest), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
    }
    try {
        return await loadFlowDatasetManifest('http://127.0.0.1:8788/manifest.json')
    } finally {
        globalThis.fetch = originalFetch
    }
}

function validManifest() {

    const limits = Array.from({ length: 6 }, (_value, index) => {
        const level = index + 4
        const northWest = WebMercatorQuad.tileFromLonLat(
            [ SOURCE_BOUNDS[0], SOURCE_BOUNDS[3] ],
            String(level)
        )
        const southEast = WebMercatorQuad.tileFromLonLat(
            [ SOURCE_BOUNDS[2], SOURCE_BOUNDS[1] ],
            String(level)
        )
        return {
            matrixId: String(level),
            minTileRow: northWest.tileRow,
            maxTileRow: southEast.tileRow,
            minTileCol: northWest.tileCol,
            maxTileCol: southEast.tileCol,
        }
    })
    return {
        schemaVersion: 1,
        sourceHash: HASH,
        contentVersion: 'flow-field-test-v1',
        stationCount: 117148,
        source: {
            crs: 'EPSG:4326',
            geographicBounds: [ ...SOURCE_BOUNDS ],
        },
        times: Array.from({ length: 27 }, (_value, timeIndex) => ({
            timeIndex,
            modelTime: timeIndex,
            unit: 'ordinal',
            phase: 'unspecified',
            sourceHash: `${timeIndex.toString(16).padStart(2, '0')}${HASH.slice(2)}`,
        })),
        tileMatrixSet: {
            id: 'WebMercatorQuad',
            uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            tileWidth: 256,
            tileHeight: 256,
            minTileMatrix: '4',
            maxTileMatrix: '9',
            limits,
        },
        encoding: {
            channels: 2,
            componentOrder: [ 'u', 'v' ],
            sampleType: 'float32-le',
            layout: 'rg-interleaved',
            tileWidth: 256,
            tileHeight: 256,
        },
        unit: 'legacy-flow-unit',
        basis: 'source-u-v',
        pages: Array.from({ length: 27 }, (_value, timeIndex) => limits.flatMap(limit =>
            Array.from(
                { length: limit.maxTileRow - limit.minTileRow + 1 },
                (_rowValue, rowOffset) => Array.from(
                    { length: limit.maxTileCol - limit.minTileCol + 1 },
                    (_colValue, colOffset) => ({
                        timeIndex,
                        matrixId: limit.matrixId,
                        tileRow: limit.minTileRow + rowOffset,
                        tileCol: limit.minTileCol + colOffset,
                        byteLength: 524288,
                        sha256: HASH,
                        maximumSpeed: 3.5,
                    })
                )
            ).flat()
        )).flat(),
    }
}

function normalizedRuntimeDataset() {

    const bounds = [ 121.001, 31.001, 121.002, 31.002 ]
    const limits = Array.from({ length: 7 }, (_value, index) => {
        const matrixId = String(index + 4)
        const northWest = WebMercatorQuad.tileFromLonLat(
            [ bounds[0], bounds[3] ],
            matrixId
        )
        const southEast = WebMercatorQuad.tileFromLonLat(
            [ bounds[2], bounds[1] ],
            matrixId
        )
        return {
            matrixId,
            minTileRow: northWest.tileRow,
            maxTileRow: southEast.tileRow,
            minTileCol: northWest.tileCol,
            maxTileCol: southEast.tileCol,
        }
    })
    const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits })
    const sample = Object.freeze({
        sampleKey: 't04',
        timeIndex: 4,
        modelTime: 12.5,
        unit: 'hour',
        phase: 'cold-start',
        sourceHash: HASH,
    })
    const representation = Object.freeze({
        mediaType: 'application/vnd.geoscratch.flow-rg32f',
        fieldKind: 'vector',
        channels: 2,
        componentOrder: Object.freeze([ 'u', 'v' ]),
        sampleType: 'float32-le',
        layout: 'rg-interleaved',
        sampleRegistration: 'pixel-center',
        spatialInterpolation: 'bilinear',
        tileWidth: 256,
        tileHeight: 256,
        unsupportedVelocity: Object.freeze([ 0, 0 ]),
        missingPageSemantics: 'unavailable',
    })
    return Object.freeze({
        kind: 'flow-field-dataset',
        schemaVersion: 2,
        artifactType: 'flow-field-cog-runtime',
        datasetId: 'flow-field-test',
        sourceHash: HASH,
        contentVersion: 'flow-cog-collection-test-t1-z15-v2',
        unit: 'meter-per-second',
        basis: 'east-north',
        source: Object.freeze({ geographicBounds: Object.freeze(bounds) }),
        sourceCeiling: Object.freeze({ matrixId: '15' }),
        tileMatrixSet: Object.freeze({
            id: 'WebMercatorQuad',
            coverage,
        }),
        representation,
        sample(sampleKey) {

            if (sampleKey !== sample.sampleKey) {
                throw new RangeError(`unknown sample ${sampleKey}`)
            }
            return sample
        },
        page(sampleKey, tile) {

            if (sampleKey !== sample.sampleKey || !coverage.contains(tile)) {
                throw new RangeError('unknown page')
            }
            return Object.freeze({
                sampleKey,
                timeIndex: sample.timeIndex,
                matrixId: tile.matrixId,
                tileRow: tile.tileRow,
                tileCol: tile.tileCol,
                path: `declared/${sampleKey}/${tile.matrixId}/${tile.tileRow}/` +
                    `${tile.tileCol}.rg32f`,
                url: `https://tiles.example.test/runtime/${sampleKey}/${tile.matrixId}/` +
                    `${tile.tileRow}/${tile.tileCol}.rg32f`,
                byteLength: 524288,
                sha256: HASH,
                maximumSpeed: 2.5,
            })
        },
    })
}

function finestPage(source) {

    const limit = source.model.coverage.limits.at(-1)
    return source.model.addressSpace.pageFromTile({
        matrixId: limit.matrixId,
        tileRow: limit.minTileRow,
        tileCol: limit.minTileCol,
    })
}

function candidateDescriptor(source, page, buffer) {

    const tile = page.tile
    return Object.freeze({
        candidateId: `test:${page.key}`,
        page,
        cacheAddress: virtualRasterCacheAddress({
            sourceId: 'flow-field-test',
            tileMatrixSetId: 'WebMercatorQuad',
            tileMatrixSetUri:
                'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            matrixId: tile.matrixId,
            tileRow: tile.tileRow,
            tileColumn: tile.tileCol,
            plane: 'velocity.t00',
            coherence: { mode: 'immutable', contentVersion: 'flow-field-test-v1' },
            sourceRepresentation: 'application/vnd.geoscratch.flow-rg32f',
            payloadRepresentation: 'raw/float32-rg-interleaved-le',
            decoderVersion: 'flow-rg32f-v1',
            sampleType: 'float32',
            schemaVersion: 1,
        }),
        url: source.tileUrl(page),
        contentVersion: 'flow-field-test-v1',
        expectedByteLength: 524288,
        expectedSha256: sha256(buffer),
    })
}

function workerContext() {

    return Object.freeze({
        signal: new AbortController().signal,
        taskId: 'flow-field-test-task',
        workerId: 'flow-field-test-worker',
        groupId: 'flow-field-test-group',
        moduleId: FLOW_FIELD_VELOCITY_TILE_WORKER.id,
        moduleVersion: FLOW_FIELD_VELOCITY_TILE_WORKER.version,
        operation: 'test',
    })
}

async function expectWorkerFailure(source, page, buffer, expectedSha256, context, codeSuffix) {

    const state = await velocityWorker.context.create({ cache: { mode: 'none' } }, context)
    const descriptor = {
        ...candidateDescriptor(source, page, buffer),
        expectedSha256,
    }
    globalThis.fetch = async() => new Response(buffer.slice(0), {
        status: 200,
        headers: { 'content-type': 'application/vnd.geoscratch.flow-rg32f' },
    })
    let failure
    try {
        await velocityWorker.context.operations.fetch(state, descriptor, context)
        await velocityWorker.context.operations.decode(
            state,
            { candidateId: descriptor.candidateId },
            context
        )
    } catch (error) {
        failure = error
    } finally {
        await velocityWorker.context.dispose(state)
    }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.code).to.equal(`FLOW_FIELD_VELOCITY_TILE_${codeSuffix}_INVALID`)
}

function sha256(buffer) {

    return createHash('sha256').update(new Uint8Array(buffer)).digest('hex')
}
