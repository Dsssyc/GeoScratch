import { expect } from 'chai'
import { createHash } from 'node:crypto'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
} from 'geoscratch/geo'
import {
    loadFlowFieldDataset,
} from '../examples/flowField/flow-dataset.ts'

const HASH = '0123456789abcdef'.repeat(4)
const BOUNDS = Object.freeze([ 120, 30, 120.001, 30.001 ])

describe('Flow Field runtime dataset', () => {

    it('loads and normalizes one immutable subset z4-z10 runtime manifest', async() => {

        const requested = []
        const signal = new AbortController().signal
        const dataset = await loadManifest(runtimeManifest(), requested, signal)

        expect(requested).to.deep.equal([ {
            url: 'http://127.0.0.1:8788/manifest.json',
            init: { cache: 'no-cache', signal },
        } ])
        expect(dataset).to.deep.include({
            kind: 'flow-field-dataset',
            schemaVersion: 2,
            artifactType: 'flow-field-cog-runtime',
            manifestUrl: 'http://127.0.0.1:8788/manifest.json',
            datasetId: 'flow-test',
            sourceRevision: 'source-v1',
            sourceHash: HASH,
            contentVersion: 'flow-runtime-test-v2',
            coverage: 'subset',
            unit: 'meter-per-second',
            basis: 'east-north',
        })
        expect(dataset.tileMatrixSet.tileMatrixIds).to.deep.equal([
            '4', '5', '6', '7', '8', '9', '10',
        ])
        expect(dataset.sourceCeiling).to.deep.equal({
            tileMatrixSetId: 'WebMercatorQuad',
            matrixId: '10',
            matrixLevel: 10,
            selectionRelation: 'explicitly-requested',
        })
        expect(dataset.budgets).to.deep.equal({
            spatialPageCount: dataset.tileMatrixSet.coverage.entryCount,
            timePageCount: dataset.pages.length,
            pageByteLength: 524288,
            totalRawPageBytes: dataset.pages.length * 524288,
        })
        expect(dataset.construction).to.deep.include({
            adapterVersion: 'flow-cog-wmq-rg32f-v2',
            collectionContentVersion: dataset.contentVersion,
        })
        expect(dataset.timeAxis.samples.map(sample => sample.sampleKey)).to.deep.equal([
            't00', 't04', 't09',
        ])
        expect(dataset.timeAxis.adjacency).to.deep.equal([
            {
                lowerSampleKey: 't00',
                upperSampleKey: 't04',
                kind: 'gap',
                interpolation: 'none',
                reason: 'omitted-source-samples',
            },
            {
                lowerSampleKey: 't04',
                upperSampleKey: 't09',
                kind: 'gap',
                interpolation: 'none',
                reason: 'omitted-source-samples',
            },
        ])
        expect(dataset.sample('t04')).to.deep.include({
            sampleKey: 't04',
            timeIndex: 4,
            modelTime: 1.25,
        })
        const limit = dataset.tileMatrixSet.limits.at(-1)
        const page = dataset.page('t04', {
            matrixId: limit.matrixId,
            tileRow: limit.minTileRow,
            tileCol: limit.minTileCol,
        })
        expect(page.url).to.equal(
            `http://127.0.0.1:8788/${page.path}`
        )
        expect(page).to.deep.include({
            sampleKey: 't04',
            timeIndex: 4,
            matrixId: '10',
            byteLength: 524288,
        })
        expect(Object.isFrozen(dataset)).to.equal(true)
        expect(Object.isFrozen(dataset.timeAxis.samples)).to.equal(true)
        expect(Object.isFrozen(dataset.pages)).to.equal(true)
        expect(() => dataset.sample('t01')).to.throw(RangeError)
    })

    it('keeps source ceiling distinct from the bounded published maximum', async() => {

        const input = runtimeManifest()
        input.sourceCeiling.matrixId = '15'
        input.sourceCeiling.selectionRelation = 'statistically-selected'

        const dataset = await loadManifest(input)

        expect(dataset.sourceCeiling.matrixLevel).to.equal(15)
        expect(dataset.tileMatrixSet.maxTileMatrix).to.equal('10')
    })

    it('binds v3 construction to its zero-footprint activity contract', async() => {
        const input = runtimeManifest()
        input.construction.adapterVersion = 'flow-cog-wmq-rg32f-v3'
        input.construction.algorithmVersion = 'flow-cog-wmq-rg32f-v3'
        input.construction.supportFilter = 'recursive-zero-preserving-vector-box-v2'
        input.representation.activitySupport = 'nearest-texel-zero'
        const dataset = await loadManifest(input)
        expect(dataset.representation.activitySupport).to.equal('nearest-texel-zero')
        expect(dataset.construction.adapterVersion).to.equal('flow-cog-wmq-rg32f-v3')
        for (const mutate of [
            value => { delete value.representation.activitySupport },
            value => { value.construction.supportFilter = 'recursive-conservative-vector-box-v1' },
            value => { value.construction.algorithmVersion = 'flow-cog-wmq-rg32f-v2' },
            value => { value.representation.activitySupport = 'any-neighbor' },
        ]) {
            const bad = structuredClone(input)
            mutate(bad)
            let failure
            try { await loadManifest(bad) } catch (error) { failure = error }
            expect(failure).to.be.instanceOf(Error)
        }
        const old = runtimeManifest()
        old.representation.activitySupport = 'nearest-texel-zero'
        let failure
        try { await loadManifest(old) } catch (error) { failure = error }
        expect(failure).to.be.instanceOf(Error)
    })

    it('accepts a complete dense time axis with declared linear adjacency', async() => {

        const input = runtimeManifest({ timeIndices: [ 0, 1, 2 ], sourceSampleCount: 3 })

        const dataset = await loadManifest(input)

        expect(dataset.coverage).to.equal('full')
        expect(dataset.timeAxis.adjacency.map(record => record.kind)).to.deep.equal([
            'interpolable', 'interpolable',
        ])
    })

    it('rejects schema, matrix, temporal, representation, and page drift', async() => {

        const cases = [
            [ 'old schema', value => { value.schemaVersion = 1 } ],
            [ 'old artifact', value => { value.artifactType = 'flow-field-pages' } ],
            [ 'missing projected bounds', value => { delete value.projectedBounds } ],
            [ 'projected bounds', value => { value.projectedBounds.bounds[0] += 1 } ],
            [ 'matrix gap', value => {
                value.tileMatrixSet.tileMatrixIds.splice(3, 1)
                value.tileMatrixSet.limits.splice(3, 1)
            } ],
            [ 'wrong source ceiling', value => { value.sourceCeiling.matrixId = '9' } ],
            [ 'gap interpolation', value => {
                value.temporal.sampleAdjacency[0].interpolation = 'component-wise-linear'
            } ],
            [ 'gap reason', value => {
                value.temporal.sampleAdjacency[0].reason = 'unknown'
            } ],
            [ 'source count', value => { value.temporal.sourceSampleCount = 9 } ],
            [ 'sample key', value => {
                value.times[0].sampleKey = 'sample-0'
                value.temporal.sampleAdjacency[0].lowerSampleKey = 'sample-0'
                for (const page of value.pages) {
                    if (page.timeIndex === 0) {
                        page.sampleKey = 'sample-0'
                        page.path = page.path.replace('/t00/', '/sample-0/')
                    }
                }
                value.timeMaximumSpeeds[0].sampleKey = 'sample-0'
            } ],
            [ 'registration', value => {
                value.representation.sampleRegistration = 'global-texel-lattice'
            } ],
            [ 'missing semantics', value => {
                value.representation.missingPageSemantics = 'zero'
            } ],
            [ 'page identity', value => { value.pages[0].sampleKey = 't04' } ],
            [ 'page path traversal', value => { value.pages[0].path = '../tile.rg32f' } ],
            [ 'page path absolute', value => {
                value.pages[0].path = 'https:evil.test/tile.rg32f'
            } ],
            [ 'page path encoded traversal', value => {
                value.pages[0].path = '%2e%2e/tile.rg32f'
            } ],
            [ 'page path identity', value => {
                value.pages[0].path = 'tiles/WebMercatorQuad/t00/4/0/0.rg32f'
            } ],
            [ 'page omission', value => { value.pages.pop() } ],
            [ 'time maximum', value => {
                value.timeMaximumSpeeds[0].pageMaximumSpeed = 4
            } ],
            [ 'page budget', value => { value.budgets.timePageCount -= 1 } ],
            [ 'adapter version', value => {
                value.construction.adapterVersion = 'flow-cog-wmq-rg32f-v1'
            } ],
            [ 'collection identity', value => {
                value.construction.collectionContentVersion = 'other'
            } ],
            [ 'publication policy', value => {
                value.construction.publicationPolicy.resolvedMaximumMatrixId = '9'
            } ],
            [ 'page-set identity', value => {
                value.construction.pageSetSha256 = HASH
            } ],
        ]
        for (const [ name, mutate ] of cases) {
            const input = runtimeManifest()
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

    it('rejects non-JSON responses and credential-bearing URLs', async() => {

        const originalFetch = globalThis.fetch
        globalThis.fetch = async() => new Response('{}', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
        })
        try {
            let failure
            try {
                await loadFlowFieldDataset('https://example.test/manifest.json')
            } catch (error) {
                failure = error
            }
            expect(failure).to.be.instanceOf(TypeError)
            let credentialFailure
            try {
                await loadFlowFieldDataset(
                    'https://user:secret@example.test/manifest.json'
                )
            } catch (error) {
                credentialFailure = error
            }
            expect(credentialFailure).to.be.instanceOf(TypeError)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('does not retain unknown mutable authority fields', async() => {

        const input = runtimeManifest()
        input.authority.extra = { mutable: true }

        const dataset = await loadManifest(input)

        expect(dataset.authority).to.deep.equal({
            unit: 'authoritative',
            basis: 'authoritative',
            time: 'authoritative',
            phase: 'unconfirmed',
            topology: 'inferred',
        })
        expect(dataset.authority).not.to.have.property('extra')
    })
})

async function loadManifest(manifest, requested = [], signal) {

    const originalFetch = globalThis.fetch
    globalThis.fetch = async(input, init) => {
        requested.push({ url: String(input), init })
        return new Response(JSON.stringify(manifest), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
    }
    try {
        return await loadFlowFieldDataset(
            'http://127.0.0.1:8788/manifest.json',
            signal === undefined ? {} : { signal }
        )
    } finally {
        globalThis.fetch = originalFetch
    }
}

function runtimeManifest({
    timeIndices = [ 0, 4, 9 ],
    sourceSampleCount = 10,
} = {}) {

    const matrixIds = Array.from({ length: 7 }, (_value, index) => String(index + 4))
    const limits = matrixIds.map(matrixId => {
        const northWest = WebMercatorQuad.tileFromLonLat(
            [ BOUNDS[0], BOUNDS[3] ],
            matrixId
        )
        const southEast = WebMercatorQuad.tileFromLonLat(
            [ BOUNDS[2], BOUNDS[1] ],
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
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits,
    })
    const times = timeIndices.map((timeIndex, ordinal) => ({
        sampleKey: `t${String(timeIndex).padStart(2, '0')}`,
        timeIndex,
        modelTime: ordinal + ordinal * 0.25,
        unit: 'hour',
        phase: 'cold-start',
        sourceHash: digestFor(timeIndex),
    }))
    const pages = times.flatMap(sample => Array.from(
        { length: coverage.entryCount },
        (_value, index) => {
            const tile = coverage.coordinate(index)
            return {
                sampleKey: sample.sampleKey,
                timeIndex: sample.timeIndex,
                matrixId: tile.matrixId,
                tileRow: tile.tileRow,
                tileCol: tile.tileCol,
                path: `tiles/WebMercatorQuad/${sample.sampleKey}/${tile.matrixId}/` +
                    `${tile.tileRow}/${tile.tileCol}.rg32f`,
                byteLength: 524288,
                sha256: HASH,
                maximumSpeed: 3.5,
            }
        }
    ))
    const sampleAdjacency = times.slice(0, -1).map((sample, index) => {
        const upper = times[index + 1]
        return upper.timeIndex === sample.timeIndex + 1
            ? {
                lowerSampleKey: sample.sampleKey,
                upperSampleKey: upper.sampleKey,
                kind: 'interpolable',
                interpolation: 'component-wise-linear',
            }
            : {
                lowerSampleKey: sample.sampleKey,
                upperSampleKey: upper.sampleKey,
                kind: 'gap',
                interpolation: 'none',
                reason: 'omitted-source-samples',
            }
    })
    const [ projectedWest, projectedSouth ] = WebMercatorQuad.project([
        BOUNDS[0],
        BOUNDS[1],
    ])
    const [ projectedEast, projectedNorth ] = WebMercatorQuad.project([
        BOUNDS[2],
        BOUNDS[3],
    ])
    return {
        schemaVersion: 2,
        artifactType: 'flow-field-cog-runtime',
        datasetId: 'flow-test',
        sourceRevision: 'source-v1',
        sourceHash: HASH,
        contentVersion: 'flow-runtime-test-v2',
        stationCount: 4,
        source: {
            crs: 'EPSG:4326',
            geographicBounds: [ ...BOUNDS ],
        },
        projectedBounds: {
            crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
            bounds: [ projectedWest, projectedSouth, projectedEast, projectedNorth ],
        },
        authority: {
            unit: 'authoritative',
            basis: 'authoritative',
            time: 'authoritative',
            phase: 'unconfirmed',
            topology: 'inferred',
        },
        times,
        temporal: {
            coverage: timeIndices.length === sourceSampleCount ? 'full' : 'subset',
            sourceSampleCount,
            sampleAdjacency,
        },
        sourceCeiling: {
            tileMatrixSetId: 'WebMercatorQuad',
            matrixId: '10',
            selectionRelation: 'explicitly-requested',
        },
        tileMatrixSet: {
            id: 'WebMercatorQuad',
            uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
            cornerOfOrigin: 'topLeft',
            tileRowDirection: 'south',
            tileColDirection: 'east',
            tileWidth: 256,
            tileHeight: 256,
            minTileMatrix: '4',
            maxTileMatrix: '10',
            tileMatrixIds: matrixIds,
            limits,
        },
        representation: {
            mediaType: 'application/vnd.geoscratch.flow-rg32f',
            fieldKind: 'vector',
            channels: 2,
            componentOrder: [ 'u', 'v' ],
            sampleType: 'float32-le',
            layout: 'rg-interleaved',
            sampleRegistration: 'pixel-center',
            spatialInterpolation: 'bilinear',
            tileWidth: 256,
            tileHeight: 256,
            unsupportedVelocity: [ 0, 0 ],
            missingPageSemantics: 'unavailable',
        },
        unit: 'meter-per-second',
        basis: 'east-north',
        maximumSpeed: 3.5,
        timeMaximumSpeeds: times.map(sample => ({
            sampleKey: sample.sampleKey,
            timeIndex: sample.timeIndex,
            pageMaximumSpeed: 3.5,
        })),
        pages,
        budgets: {
            spatialPageCount: coverage.entryCount,
            timePageCount: pages.length,
            pageByteLength: 524288,
            totalRawPageBytes: pages.length * 524288,
        },
        quality: {
            artifactRole: 'reconstruction-prototype',
            particleSimulation: 'not-approved',
            approvalReason: 'test-only',
        },
        construction: {
            algorithmVersion: 'flow-cog-wmq-rg32f-v2',
            adapterVersion: 'flow-cog-wmq-rg32f-v2',
            collectionContentVersion: 'flow-runtime-test-v2',
            pageSetSha256: pageSetSha256(pages),
            levelConstruction: 'cog-physical-or-global-semantic-recursive',
            supportFilter: 'recursive-conservative-vector-box-v1',
            publicationPolicy: {
                kind: 'bounded-source-ceiling',
                minimumMatrixId: '4',
                maximumMatrixCap: '10',
                resolvedMaximumMatrixId: '10',
            },
        },
    }
}

function pageSetSha256(pages) {

    const digest = createHash('sha256')
    for (const page of pages) {
        digest.update(JSON.stringify([
            page.sampleKey,
            page.timeIndex,
            page.matrixId,
            page.tileRow,
            page.tileCol,
            page.path,
            page.byteLength,
            page.sha256,
            page.maximumSpeed,
        ]) + '\n')
    }
    return digest.digest('hex')
}

function digestFor(timeIndex) {

    return timeIndex.toString(16).padStart(2, '0') + HASH.slice(2)
}
