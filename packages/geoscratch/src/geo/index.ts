export { MercatorCoordinate } from './mercatorCoordinate.js'
export {
    GeoDiagnosticError,
    createGeoDiagnostic,
    isGeoDiagnosticError,
} from './diagnostics.js'
export type {
    GeoDiagnostic,
    GeoDiagnosticInput,
    GeoDiagnosticPhase,
    GeoDiagnosticSeverity,
    GeoDiagnosticSubject,
} from './diagnostics.js'
export {
    coordinateDomain,
    localVector,
    surfaceDomain,
} from './coordinate-domain.js'
export type {
    AuxiliaryAxis,
    CoordinateAxis,
    CoordinateDimension,
    CoordinateDomain,
    CoordinateDomainDescriptor,
    LocalVector,
    LocalVectorOptions,
    SurfaceDomainDescriptor,
} from './coordinate-domain.js'
export {
    CellLocalF32Codec,
    WideFixedCodec,
    cellLocalF32Codec,
    wideFixedCodec,
} from './position-codec.js'
export type {
    CellLocalF32CodecOptions,
    CellLocalPosition,
    CellLocalPositionInput,
    CoordinateOverflowPolicy,
    CoordinateWrapPolicy,
    PositionEncoding,
    PositionPrecisionFacts,
    PositionWgslOptions,
    WideFixedAxis,
    WideFixedCodecOptions,
    WideFixedLodAddress,
    WideFixedPosition,
} from './position-codec.js'
export {
    TileMatrixCoverage,
    tileMatrixCoverage,
    tileMatrixSet,
} from './tile-matrix.js'
export type {
    TileCoordinate,
    TileCoordinateDescriptor,
    TileMatrix,
    TileMatrixCornerOfOrigin,
    TileMatrixCoverageDescriptor,
    TileMatrixCoverageWgslOptions,
    TileMatrixDescriptor,
    TileMatrixId,
    TileMatrixLimits,
    TileMatrixSet,
    TileMatrixSetBoundingBox,
    TileMatrixSetDescriptor,
} from './tile-matrix.js'
export {
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_MAX_LATITUDE,
    WEB_MERCATOR_QUAD_MAX_ZOOM,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
    WebMercatorQuadAddressCodec,
    webMercatorQuadAddressCodec,
} from './web-mercator-quad.js'
export type {
    GeographicPosition2D,
    ProjectedPosition2D,
    WebMercatorQuadAddressCodecDescriptor,
    WebMercatorQuadAddressWgslOptions,
    WebMercatorQuadModel,
    WebMercatorQuadPosition,
    WebMercatorQuadTileBounds,
    WebMercatorTileSampleAddress,
} from './web-mercator-quad.js'
export {
    VirtualRasterAccessor,
    VirtualRasterAddressSpace,
    VirtualRasterSnapshot,
    virtualRasterAccessor,
    virtualRasterAddressSpace,
    virtualRasterPlane,
    virtualRasterSamplingProfile,
    virtualRasterSource,
} from './virtual-raster.js'
export type {
    VirtualRasterAccessorDescriptor,
    VirtualRasterAccessorWgslOptions,
    VirtualRasterAddressSpaceDescriptor,
    VirtualRasterFieldKind,
    VirtualRasterFilter,
    VirtualRasterOuterBoundary,
    VirtualRasterPageDescriptor,
    VirtualRasterPageIdentity,
    VirtualRasterPagePayload,
    VirtualRasterPageTableEntry,
    VirtualRasterPhysicalPage,
    VirtualRasterPlane,
    VirtualRasterPlaneDescriptor,
    VirtualRasterSample,
    VirtualRasterSampleDescriptor,
    VirtualRasterSampleStatus,
    VirtualRasterSampleType,
    VirtualRasterSamplingProfile,
    VirtualRasterSamplingProfileDescriptor,
    VirtualRasterSnapshotResolveStatus,
    VirtualRasterSource,
    VirtualRasterSourceDescriptor,
    VirtualRasterSourceLoadContext,
} from './virtual-raster.js'
export { VirtualRasterResidency } from './virtual-raster-residency.js'
export type {
    VirtualRasterHistoryEntry,
    VirtualRasterRequestOutcome,
    VirtualRasterRequestStatus,
    VirtualRasterResidencyDescriptor,
    VirtualRasterResidencyFacts,
} from './virtual-raster-residency.js'
export {
    VirtualRasterGpuState,
    createVirtualRasterGpuState,
} from './virtual-raster-gpu.js'
export type {
    VirtualRasterGpuFacts,
    VirtualRasterGpuStateDescriptor,
    VirtualRasterGpuUpdate,
} from './virtual-raster-gpu.js'
export {
    GeoQuadNode2D,
    Node2D,
    type MapOptions,
} from './tiling/geoQuadNode2D.js'
