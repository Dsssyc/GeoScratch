import { expect } from 'chai'
import {
    isGeoDiagnosticError,
    virtualRasterCacheAddress,
} from 'geoscratch/geo'

describe('Geo virtual raster persistent-cache adapter', () => {

    it('separates logical identity, immutable revision, and raw representation', () => {

        const first = address({ coherence: { mode: 'immutable', contentVersion: 'r1' } })
        const nextRevision = address({ coherence: { mode: 'immutable', contentVersion: 'r2' } })
        const nextDecoder = address({
            coherence: { mode: 'immutable', contentVersion: 'r1' },
            decoderVersion: 'png-r8-v3',
        })

        expect(first.key.id).to.equal(nextRevision.key.id)
        expect(first.key.revision).not.to.equal(nextRevision.key.revision)
        expect(first.key.id).not.to.equal(nextDecoder.key.id)
        expect(first.metadata).to.deep.include({
            domain: 'geo.virtual-raster',
            sourceId: 'dem-source',
            tileMatrixSetId: 'WebMercatorQuad',
            matrixId: '12',
            tileRow: 1674,
            tileColumn: 3431,
            plane: 'height',
            sourceRepresentation: 'image/png',
            payloadRepresentation: 'raw/uint8',
            sampleType: 'uint8',
            schemaVersion: 2,
        })
    })

    it('isolates revisioned validators and editable committed bases', () => {

        const revisionA = address({
            coherence: { mode: 'revisioned', revision: 'r1', validator: 'etag-a' },
        })
        const revisionB = address({
            coherence: { mode: 'revisioned', revision: 'r1', validator: 'etag-b' },
        })
        const editableA = address({ coherence: { mode: 'editable', baseRevision: 'base-a' } })
        const editableB = address({ coherence: { mode: 'editable', baseRevision: 'base-b' } })

        expect(revisionA.key.revision).not.to.equal(revisionB.key.revision)
        expect(editableA.key.revision).not.to.equal(editableB.key.revision)
        expect(editableA.key.revision).to.equal('editable-base:base-a')
    })

    it('provides hierarchical prefixes without owning cache lifecycle', () => {

        const value = address()

        expect(value.key.id.startsWith(value.invalidationPrefixes.source)).to.equal(true)
        expect(value.key.id.startsWith(value.invalidationPrefixes.plane)).to.equal(true)
        expect(value.key.id.startsWith(value.invalidationPrefixes.tileMatrixSet)).to.equal(true)
        expect(value.key.id.startsWith(value.invalidationPrefixes.matrix)).to.equal(true)
        expect(Object.keys(value).sort()).to.deep.equal([
            'invalidationPrefixes',
            'key',
            'kind',
            'metadata',
        ])
    })

    it('keeps malformed and aggregate-overflow identities in the Geo diagnostic domain', () => {

        const failures = []
        for (const descriptor of [
            { sourceId: '\ud800' },
            {
                sourceId: 's'.repeat(256),
                tileMatrixSetId: 't'.repeat(256),
                tileMatrixSetUri: 'u'.repeat(256),
                matrixId: 'm'.repeat(256),
                plane: 'p'.repeat(256),
                sourceRepresentation: 'r'.repeat(256),
                payloadRepresentation: 'q'.repeat(256),
                decoderVersion: 'd'.repeat(256),
                sampleType: 'v'.repeat(256),
            },
            {
                coherence: {
                    mode: 'revisioned',
                    revision: 'r'.repeat(256),
                    validator: 'v'.repeat(256),
                },
            },
        ]) {
            try {
                address(descriptor)
            } catch (error) {
                failures.push(error)
            }
        }

        expect(failures).to.have.length(3)
        for (const failure of failures) {
            expect(isGeoDiagnosticError(failure)).to.equal(true)
            expect(failure.diagnostic).to.deep.include({
                code: 'GEO_VIRTUAL_RASTER_CACHE_ADDRESS_INVALID',
                phase: 'cache',
            })
        }
    })
})

function address(options = {}) {

    return virtualRasterCacheAddress({
        sourceId: options.sourceId ?? 'dem-source',
        tileMatrixSetId: options.tileMatrixSetId ?? 'WebMercatorQuad',
        tileMatrixSetUri: options.tileMatrixSetUri ??
            'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        matrixId: options.matrixId ?? '12',
        tileRow: 1674,
        tileColumn: 3431,
        plane: options.plane ?? 'height',
        coherence: options.coherence ?? { mode: 'immutable', contentVersion: 'r1' },
        sourceRepresentation: options.sourceRepresentation ?? 'image/png',
        payloadRepresentation: options.payloadRepresentation ?? 'raw/uint8',
        decoderVersion: options.decoderVersion ?? 'png-r8-v2',
        sampleType: options.sampleType ?? 'uint8',
        schemaVersion: 2,
    })
}
