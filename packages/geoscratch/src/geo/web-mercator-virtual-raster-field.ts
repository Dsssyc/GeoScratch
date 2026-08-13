import {
    geoField,
    tiledFieldRepresentation,
    type GeoField,
    type GeoFieldInterpolation,
    type TiledFieldRepresentation,
} from './geo-field.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    webMercatorPlanarTileSpatialProfile,
    type WebMercatorPlanarTileSpatialProfile,
} from './tile-spatial-profile.js'
import type { TileMatrixCoverage } from './tile-matrix.js'
import {
    virtualRasterPlane,
    virtualRasterTileAddressSpace,
    type VirtualRasterAddressSpace,
    type VirtualRasterFieldKind,
    type VirtualRasterPageIdentity,
    type VirtualRasterPlane,
    type VirtualRasterSampleType,
} from './virtual-raster.js'
import {
    WebMercatorQuad,
    webMercatorQuadAddressCodec,
    type WebMercatorQuadAddressCodec,
} from './web-mercator-quad.js'

export type WebMercatorVirtualRasterFieldDescriptor = Readonly<{
    id: string
    addressSpaceId: string
    sourceRevision: string
    coverage: TileMatrixCoverage
    geographicBounds: readonly [number, number, number, number]
    coordinateBits?: number
    label?: string
    fieldKind: VirtualRasterFieldKind
    channels: 1 | 2 | 3 | 4
    sampleType: VirtualRasterSampleType
    gpuFormat: GPUTextureFormat
    unit?: string
    noData?: number
    interpolation: GeoFieldInterpolation
    scale?: number | readonly number[]
    offset?: number | readonly number[]
    auxiliaryAxes?: readonly Readonly<{ name: string, value: string | number }>[]
}>

export type WebMercatorVirtualRasterField = Readonly<{
    kind: 'web-mercator-virtual-raster-field'
    id: string
    sourceId: string
    sourceRevision: string
    geographicBounds: readonly [number, number, number, number]
    coverage: TileMatrixCoverage
    addressSpace: VirtualRasterAddressSpace
    addressCodec: WebMercatorQuadAddressCodec
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    field: GeoField
    representation: TiledFieldRepresentation
    plane: VirtualRasterPlane
    safetyCoverPages: readonly VirtualRasterPageIdentity[]
}>

/** Composes WebMercatorQuad addressing, field semantics, coverage, and Virtual Raster storage. */
export function webMercatorVirtualRasterField(
    descriptor: WebMercatorVirtualRasterFieldDescriptor
): WebMercatorVirtualRasterField {

    const bounds = normalizeDescriptor(descriptor)
    const addressSpace = virtualRasterTileAddressSpace({
        id: descriptor.addressSpaceId,
        coverage: descriptor.coverage,
    })
    const addressCodec = webMercatorQuadAddressCodec({
        coverage: descriptor.coverage,
        ...(descriptor.coordinateBits === undefined
            ? {}
            : { coordinateBits: descriptor.coordinateBits }),
    })
    const spatialProfile = webMercatorPlanarTileSpatialProfile({ addressCodec })
    const plane = virtualRasterPlane({
        id: descriptor.id + '.' + descriptor.sourceRevision,
        addressSpace,
        kind: descriptor.fieldKind,
        channels: descriptor.channels,
        sampleType: descriptor.sampleType,
        gpuFormat: descriptor.gpuFormat,
        ...(descriptor.noData === undefined ? {} : { noData: descriptor.noData }),
        ...(descriptor.scale === undefined ? {} : { scale: descriptor.scale }),
        ...(descriptor.offset === undefined ? {} : { offset: descriptor.offset }),
        ...(descriptor.auxiliaryAxes === undefined
            ? {}
            : { auxiliaryAxes: descriptor.auxiliaryAxes }),
    })
    const field = geoField({
        id: descriptor.id,
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
        domain: addressCodec.positionCodec.domain,
        kind: descriptor.fieldKind,
        channels: descriptor.channels,
        sampleType: descriptor.sampleType,
        ...(descriptor.unit === undefined ? {} : { unit: descriptor.unit }),
        ...(descriptor.noData === undefined ? {} : { noData: descriptor.noData }),
        interpolation: descriptor.interpolation,
    })
    const representation = tiledFieldRepresentation({
        id: descriptor.id + '.WebMercatorQuad.' + descriptor.sourceRevision,
        field,
        plane,
        spatialProfile,
        sourceRevision: descriptor.sourceRevision,
    })
    const rootLimit = descriptor.coverage.limits[0]!
    const safetyCoverPages: VirtualRasterPageIdentity[] = []
    for (let row = rootLimit.minTileRow; row <= rootLimit.maxTileRow; row++) {
        for (let col = rootLimit.minTileCol; col <= rootLimit.maxTileCol; col++) {
            safetyCoverPages.push(addressSpace.pageFromTile({
                matrixId: rootLimit.matrixId,
                tileRow: row,
                tileCol: col,
            }))
        }
    }
    return Object.freeze({
        kind: 'web-mercator-virtual-raster-field',
        id: representation.id,
        sourceId: descriptor.id,
        sourceRevision: descriptor.sourceRevision,
        geographicBounds: bounds,
        coverage: descriptor.coverage,
        addressSpace,
        addressCodec,
        spatialProfile,
        field,
        representation,
        plane,
        safetyCoverPages: Object.freeze(safetyCoverPages),
    })
}

function normalizeDescriptor(
    descriptor: WebMercatorVirtualRasterFieldDescriptor
): readonly [number, number, number, number] {

    const bounds = descriptor?.geographicBounds
    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        typeof descriptor.addressSpaceId !== 'string' || descriptor.addressSpaceId.length === 0 ||
        typeof descriptor.sourceRevision !== 'string' || descriptor.sourceRevision.length === 0 ||
        descriptor.coverage?.kind !== 'tile-matrix-coverage' ||
        descriptor.coverage.tileMatrixSet !== WebMercatorQuad ||
        !Array.isArray(bounds) || bounds.length !== 4 ||
        bounds.some(value => !Number.isFinite(value)) ||
        bounds[0] < -180 || bounds[2] > 180 ||
        bounds[1] < -WebMercatorQuad.maxLatitude ||
        bounds[3] > WebMercatorQuad.maxLatitude ||
        bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        return throwGeoDiagnostic({
            code: 'GEO_FIELD_INVALID',
            phase: 'source',
            subject: {
                kind: 'web-mercator-virtual-raster-field',
                ...(typeof descriptor?.id === 'string' ? { id: descriptor.id } : {}),
            },
            message: 'A WebMercator Virtual Raster field requires stable identities, standard coverage, and ordered geographic bounds.',
            expected: {
                id: 'non-empty string',
                addressSpaceId: 'non-empty string',
                sourceRevision: 'non-empty string',
                tileMatrixSetId: WebMercatorQuad.id,
                geographicBounds: [
                    -180,
                    -WebMercatorQuad.maxLatitude,
                    180,
                    WebMercatorQuad.maxLatitude,
                ],
            },
            actual: descriptor,
        })
    }
    return Object.freeze([ ...bounds ]) as readonly [number, number, number, number]
}
