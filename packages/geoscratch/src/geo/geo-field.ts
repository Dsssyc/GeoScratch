import type { CoordinateDomain } from './coordinate-domain.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { TileSpatialProfile } from './tile-spatial-profile.js'
import type {
    VirtualRasterFieldKind,
    VirtualRasterPlane,
    VirtualRasterSampleType,
} from './virtual-raster.js'

export type GeoFieldInterpolation = 'nearest' | 'linear'

export type GeoFieldDescriptor = Readonly<{
    id: string
    label?: string
    domain: CoordinateDomain
    kind: VirtualRasterFieldKind
    channels: 1 | 2 | 3 | 4
    sampleType: VirtualRasterSampleType
    unit?: string
    noData?: number
    interpolation: GeoFieldInterpolation
}>

export type GeoField = Readonly<{
    kind: 'geo-field'
    id: string
    label?: string
    domain: CoordinateDomain
    fieldKind: VirtualRasterFieldKind
    channels: 1 | 2 | 3 | 4
    sampleType: VirtualRasterSampleType
    unit?: string
    noData?: number
    interpolation: GeoFieldInterpolation
}>

export type TiledFieldRepresentationDescriptor = Readonly<{
    id: string
    field: GeoField
    plane: VirtualRasterPlane
    spatialProfile: TileSpatialProfile
    sourceRevision: string
}>

export type TiledFieldRepresentation = Readonly<{
    kind: 'tiled-field-representation'
    id: string
    field: GeoField
    plane: VirtualRasterPlane
    spatialProfile: TileSpatialProfile
    sourceRevision: string
}>

export function geoField(descriptor: GeoFieldDescriptor): GeoField {

    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        (descriptor.label !== undefined && typeof descriptor.label !== 'string') ||
        descriptor.domain?.kind !== 'coordinate-domain' ||
        !validFieldChannels(descriptor.kind, descriptor.channels) ||
        (descriptor.sampleType !== 'unorm8' && descriptor.sampleType !== 'float32') ||
        (descriptor.unit !== undefined &&
            (typeof descriptor.unit !== 'string' || descriptor.unit.length === 0)) ||
        (descriptor.noData !== undefined && !Number.isFinite(descriptor.noData)) ||
        (descriptor.interpolation !== 'nearest' && descriptor.interpolation !== 'linear')) {
        return invalidField(
            'A Geo field requires a domain and internally consistent sample semantics.',
            {
                id: 'non-empty string',
                domain: 'CoordinateDomain',
                channels: 'compatible with field kind',
                sampleType: [ 'unorm8', 'float32' ],
                interpolation: [ 'nearest', 'linear' ],
            },
            descriptor
        )
    }
    return Object.freeze({
        kind: 'geo-field' as const,
        id: descriptor.id,
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        domain: descriptor.domain,
        fieldKind: descriptor.kind,
        channels: descriptor.channels,
        sampleType: descriptor.sampleType,
        ...(descriptor.unit === undefined ? {} : { unit: descriptor.unit }),
        ...(descriptor.noData === undefined ? {} : { noData: descriptor.noData }),
        interpolation: descriptor.interpolation,
    })
}

export function tiledFieldRepresentation(
    descriptor: TiledFieldRepresentationDescriptor
): TiledFieldRepresentation {

    const coverage = descriptor?.plane?.addressSpace?.tileCoverage
    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        descriptor.field?.kind !== 'geo-field' ||
        descriptor.plane?.kind !== 'virtual-raster-plane' ||
        descriptor.spatialProfile?.kind !== 'tile-spatial-profile' ||
        typeof descriptor.sourceRevision !== 'string' || descriptor.sourceRevision.length === 0 ||
        coverage === undefined || coverage !== descriptor.spatialProfile.coverage ||
        descriptor.field.fieldKind !== descriptor.plane.fieldKind ||
        descriptor.field.channels !== descriptor.plane.channels ||
        descriptor.field.sampleType !== descriptor.plane.sampleType ||
        descriptor.field.noData !== descriptor.plane.noData) {
        return invalidField(
            'A tiled field representation must preserve field semantics over one matching tile profile and plane.',
            {
                fieldPlaneSemantics: 'same kind, channels, sample type, and no-data',
                coverage: 'plane address-space coverage equals spatial profile coverage',
                sourceRevision: 'non-empty string',
            },
            descriptor
        )
    }
    return Object.freeze({
        kind: 'tiled-field-representation' as const,
        id: descriptor.id,
        field: descriptor.field,
        plane: descriptor.plane,
        spatialProfile: descriptor.spatialProfile,
        sourceRevision: descriptor.sourceRevision,
    })
}

function validFieldChannels(kind: VirtualRasterFieldKind, channels: number): boolean {

    if (!Number.isSafeInteger(channels) || channels < 1 || channels > 4) return false
    switch (kind) {
        case 'scalar':
        case 'categorical':
        case 'mask': return channels === 1
        case 'color': return channels === 3 || channels === 4
        case 'vector': return channels >= 2
        case 'multiband': return true
        default: return false
    }
}

function invalidField(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_FIELD_INVALID',
        phase: 'source',
        subject: { kind: 'geo-field' },
        message,
        expected,
        actual,
    })
}

