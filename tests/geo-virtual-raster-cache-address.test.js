import { expect } from 'chai'
import {
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
})

function address(options = {}) {

    return virtualRasterCacheAddress({
        sourceId: 'dem-source',
        tileMatrixSetId: 'WebMercatorQuad',
        tileMatrixSetUri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        matrixId: '12',
        tileRow: 1674,
        tileColumn: 3431,
        plane: 'height',
        coherence: options.coherence ?? { mode: 'immutable', contentVersion: 'r1' },
        sourceRepresentation: 'image/png',
        payloadRepresentation: 'raw/uint8',
        decoderVersion: options.decoderVersion ?? 'png-r8-v2',
        sampleType: 'uint8',
        schemaVersion: 2,
    })
}
