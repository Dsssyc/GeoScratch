import { expect } from 'chai'
import {
    PersistentCache,
    createScratchDiagnostic,
    isScratchDiagnosticError,
    persistentCacheKey,
} from 'geoscratch/scratch'
import {
    virtualRasterCacheAddress,
} from 'geoscratch/geo'

describe('Scratch persistent cache contract', () => {

    it('creates immutable domain-neutral cache identities', () => {

        const first = persistentCacheKey({ id: 'dataset/page-1', revision: 'r1' })
        const next = persistentCacheKey({ id: 'dataset/page-1', revision: 'r2' })

        expect(first).to.deep.equal({
            kind: 'persistent-cache-key',
            id: 'dataset/page-1',
            revision: 'r1',
            storageKey: JSON.stringify([ 'dataset/page-1', 'r1' ]),
        })
        expect(first.storageKey).not.to.equal(next.storageKey)
        expect(Object.isFrozen(first)).to.equal(true)
    })

    it('accepts cache as a narrowable Scratch diagnostic domain', () => {

        const diagnostic = createScratchDiagnostic({
            domain: 'cache',
            code: 'CACHE_TEST',
            phase: 'cache-read',
            subject: { kind: 'PersistentCache', id: 'test' },
        })

        expect(diagnostic).to.deep.include({
            version: 1,
            domain: 'cache',
            code: 'CACHE_TEST',
        })
    })

    it('reports unavailable browser storage through Scratch diagnostics', async() => {

        let failure
        try {
            await PersistentCache.open({
                namespace: 'node-unavailable',
                maxPayloadBytes: 1024,
                maxEntries: 4,
            })
        } catch (error) {
            failure = error
        }

        expect(isScratchDiagnosticError(failure)).to.equal(true)
        expect(failure.diagnostic).to.deep.include({
            domain: 'cache',
            code: 'CACHE_STORAGE_UNAVAILABLE',
            phase: 'cache-open',
        })
        expect(failure.context).to.deep.include({ domain: 'cache' })
    })

    it('maps Geo virtual raster facts into a Scratch key and cloneable metadata', () => {

        const address = virtualRasterCacheAddress({
            sourceId: 'dem-source',
            tileMatrixSetId: 'WebMercatorQuad',
            tileMatrixSetUri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
            matrixId: '12',
            tileRow: 1674,
            tileColumn: 3431,
            plane: 'height',
            coherence: { mode: 'immutable', contentVersion: 'dem-v1' },
            sourceRepresentation: 'image/png',
            payloadRepresentation: 'raw/uint8',
            decoderVersion: 'png-r8-v2',
            sampleType: 'uint8',
            schemaVersion: 2,
        })

        expect(address.kind).to.equal('virtual-raster-cache-address')
        expect(address.key.revision).to.equal('immutable:dem-v1')
        expect(address.metadata).to.deep.include({
            sourceId: 'dem-source',
            matrixId: '12',
            tileRow: 1674,
            tileColumn: 3431,
            payloadRepresentation: 'raw/uint8',
        })
        expect(structuredClone(address.metadata)).to.deep.equal(address.metadata)
        expect(Object.isFrozen(address)).to.equal(true)
    })
})
