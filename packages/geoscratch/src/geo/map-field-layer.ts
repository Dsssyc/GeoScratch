import { throwGeoDiagnostic } from './diagnostics.js'
import type { GeoField, TiledFieldRepresentation } from './geo-field.js'
import type { GeoViewAdapter } from './geo-view.js'
import type { TileSpatialProfile } from './tile-spatial-profile.js'
import type { ViewDemandProducer } from './view-tile-demand.js'

export type MapFieldLayerDescriptor<Input = unknown> = Readonly<{
    id: string
    field: GeoField
    representation: TiledFieldRepresentation
    spatialProfile: TileSpatialProfile
    viewAdapter: GeoViewAdapter<Input>
    demandProducer: ViewDemandProducer
}>

export type MapFieldLayer<Input = unknown> = Readonly<{
    kind: 'map-field-layer'
    id: string
    field: GeoField
    representation: TiledFieldRepresentation
    spatialProfile: TileSpatialProfile
    viewAdapter: GeoViewAdapter<Input>
    demandProducer: ViewDemandProducer
}>

/** Composes a planar field representation, view adapter, and demand producer without owning them. */
export function mapFieldLayer<Input = unknown>(
    descriptor: MapFieldLayerDescriptor<Input>
): MapFieldLayer<Input> {

    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        descriptor.field?.kind !== 'geo-field' ||
        descriptor.representation?.kind !== 'tiled-field-representation' ||
        descriptor.spatialProfile?.kind !== 'tile-spatial-profile' ||
        descriptor.spatialProfile.coordinateFrame !== 'planar' ||
        descriptor.viewAdapter?.kind !== 'geo-view-adapter' ||
        descriptor.demandProducer?.kind !== 'view-demand-producer' ||
        descriptor.representation.field !== descriptor.field ||
        descriptor.representation.spatialProfile !== descriptor.spatialProfile) {
        return throwGeoDiagnostic({
            code: 'GEO_MAP_FIELD_LAYER_INVALID',
            phase: 'selection',
            subject: { kind: 'map-field-layer', id: descriptor?.id },
            message: 'A Map field layer requires one compatible field, planar representation, view adapter, and demand producer.',
            expected: {
                field: 'same identity as representation.field',
                spatialProfile: 'same planar profile as representation.spatialProfile',
                viewAdapter: 'GeoViewAdapter',
                demandProducer: 'ViewDemandProducer',
            },
            actual: descriptor,
        })
    }
    return Object.freeze({
        kind: 'map-field-layer' as const,
        id: descriptor.id,
        field: descriptor.field,
        representation: descriptor.representation,
        spatialProfile: descriptor.spatialProfile,
        viewAdapter: descriptor.viewAdapter,
        demandProducer: descriptor.demandProducer,
    })
}
