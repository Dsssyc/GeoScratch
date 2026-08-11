import { expect } from 'chai'
import {
    GeoDiagnosticError,
    ViewDemandProducer,
    WebMercatorQuad,
    createGeoViewAdapter,
    createGeoViewSnapshot,
    geoField,
    mapFieldLayer,
    surfaceDomain,
    tileMatrixCoverage,
    tiledFieldRepresentation,
    virtualRasterPlane,
    virtualRasterTileAddressSpace,
    webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'

function fixture() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            { matrixId: '0', minTileRow: 0, maxTileRow: 0, minTileCol: 0, maxTileCol: 0 },
        ],
    })
    const addressSpace = virtualRasterTileAddressSpace({ id: 'height-address', coverage })
    const plane = virtualRasterPlane({
        id: 'height-plane',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        noData: 255,
        scale: 4,
        offset: -100,
    })
    const profile = webMercatorPlanarTileSpatialProfile({
        addressCodec: webMercatorQuadAddressCodec({ coverage }),
    })
    const domain = surfaceDomain({
        id: 'web-mercator-surface',
        axes: [ { name: 'east', unit: 'm' }, { name: 'north', unit: 'm' } ],
        embeddingAxes: [
            { name: 'x', unit: 'm' },
            { name: 'y', unit: 'm' },
            { name: 'z', unit: 'm' },
        ],
    })
    const field = geoField({
        id: 'terrain-height',
        domain,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        unit: 'm',
        noData: 255,
        interpolation: 'linear',
    })
    const representation = tiledFieldRepresentation({
        id: 'terrain-height-wmq-v1',
        field,
        plane,
        spatialProfile: profile,
        sourceRevision: 'dem-v1',
    })
    const viewAdapter = createGeoViewAdapter({
        id: 'maplibre-camera',
        read: (input, context) => createGeoViewSnapshot({ ...input, ...context }),
    })
    const demandProducer = new ViewDemandProducer({ id: 'dem-view-demand', maxDemands: 32 })
    return { field, representation, profile, viewAdapter, demandProducer }
}

describe('Geo fields and map field layers', () => {

    it('separates semantic field facts from a tiled physical representation', () => {

        const { field, representation, profile } = fixture()

        expect(field).to.deep.include({
            kind: 'geo-field',
            id: 'terrain-height',
            unit: 'm',
            interpolation: 'linear',
        })
        expect(representation).to.deep.include({
            kind: 'tiled-field-representation',
            id: 'terrain-height-wmq-v1',
            sourceRevision: 'dem-v1',
        })
        expect(representation.field).to.equal(field)
        expect(representation.spatialProfile).to.equal(profile)
        expect(Object.isFrozen(field)).to.equal(true)
        expect(Object.isFrozen(representation)).to.equal(true)
    })

    it('builds a MapFieldLayer as a dependency composition without hidden authorities', () => {

        const { field, representation, profile, viewAdapter, demandProducer } = fixture()
        const layer = mapFieldLayer({
            id: 'dem-map-field',
            field,
            representation,
            spatialProfile: profile,
            viewAdapter,
            demandProducer,
        })

        expect(layer.kind).to.equal('map-field-layer')
        expect(layer.field).to.equal(field)
        expect(layer.representation).to.equal(representation)
        expect(layer.viewAdapter).to.equal(viewAdapter)
        expect(layer.demandProducer).to.equal(demandProducer)
        expect(layer).not.to.have.any.keys(
            'cache', 'worker', 'runtime', 'scheduler', 'residency', 'atlas', 'submission'
        )
        expect(Object.isFrozen(layer)).to.equal(true)
    })

    it('rejects a representation whose field semantics disagree with its plane', () => {

        const { representation, profile } = fixture()
        const vectorField = geoField({
            id: 'velocity',
            domain: representation.field.domain,
            kind: 'vector',
            channels: 2,
            sampleType: 'unorm8',
            unit: 'm/s',
            interpolation: 'linear',
        })

        expect(() => tiledFieldRepresentation({
            id: 'invalid-vector-height-plane',
            field: vectorField,
            plane: representation.plane,
            spatialProfile: profile,
            sourceRevision: 'v1',
        })).to.throw(GeoDiagnosticError)
    })

    it('rejects a layer assembled from a different field identity', () => {

        const { representation, profile, viewAdapter, demandProducer } = fixture()
        const other = geoField({
            id: 'other-height',
            domain: representation.field.domain,
            kind: representation.field.fieldKind,
            channels: representation.field.channels,
            sampleType: representation.field.sampleType,
            unit: representation.field.unit,
            noData: representation.field.noData,
            interpolation: representation.field.interpolation,
        })

        expect(() => mapFieldLayer({
            id: 'mismatch',
            field: other,
            representation,
            spatialProfile: profile,
            viewAdapter,
            demandProducer,
        })).to.throw(GeoDiagnosticError)
    })
})
