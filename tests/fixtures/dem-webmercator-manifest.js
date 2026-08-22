const bounds = [ 120.04373606134682, 31.173901952209487, 121.96623240116922, 32.08401085804678 ]
const limits = [
    { matrixId: '4', minTileRow: 6, maxTileRow: 6, minTileCol: 13, maxTileCol: 13 },
    { matrixId: '5', minTileRow: 12, maxTileRow: 13, minTileCol: 26, maxTileCol: 26 },
    { matrixId: '6', minTileRow: 25, maxTileRow: 26, minTileCol: 53, maxTileCol: 53 },
    { matrixId: '7', minTileRow: 51, maxTileRow: 52, minTileCol: 106, maxTileCol: 107 },
    { matrixId: '8', minTileRow: 103, maxTileRow: 104, minTileCol: 213, maxTileCol: 214 },
    { matrixId: '9', minTileRow: 207, maxTileRow: 209, minTileCol: 426, maxTileCol: 429 },
    { matrixId: '10', minTileRow: 415, maxTileRow: 418, minTileCol: 853, maxTileCol: 858 },
]
const tileElevationBounds = limits.flatMap(limit => {
    const matrixLevel = Number(limit.matrixId)
    return Array.from(
        { length: limit.maxTileRow - limit.minTileRow + 1 },
        (_, rowOffset) => Array.from(
            { length: limit.maxTileCol - limit.minTileCol + 1 },
            (_, colOffset) => ({
                matrixLevel,
                tileRow: limit.minTileRow + rowOffset,
                tileCol: limit.minTileCol + colOffset,
                minimumElevationMeters: -80 + (matrixLevel % 3),
                maximumElevationMeters: 4 - (matrixLevel % 2),
            })
        )
    ).flat()
})

export const demWebMercatorManifest = Object.freeze({
    schemaVersion: 3,
    sourceHash: 'aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1',
    contentVersion: 'dem-aa7a584830f19877-cog-wmq-v4',
    source: {
        crs: 'EPSG:4326',
        geographicBounds: bounds,
        rasterDimensions: { width: 1024, height: 558 },
        sampleType: 'uint8',
        bitsPerSample: 8,
    },
    projectedBounds: {
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
        bounds: [ 13363275.903308092, 3654711.03675981, 13577289.36868858, 3773537.869423257 ],
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
        tileMatrixIds: [ '4', '5', '6', '7', '8', '9', '10' ],
        limits,
    },
    tileElevationBounds,
    nativeResolution: {
        closestTileMatrix: '10',
        tileMatrixCellSizeMeters: 152.8740565703525,
        sourceProjectedPixelSizeMeters: [ 209.00924353563227, 212.95131283771864 ],
        tileMatrixCellsPerSourcePixel: [ 1.3672184320890406, 1.3930073120628352 ],
        resampling: 'nearest',
    },
    nodata: null,
    scale: 0.3311509803921568,
    offset: -80.06899999999999,
    overviewLevels: [ 2, 4, 8 ],
    pixelOrientation: {
        source: 'north-up-row-major',
        cog: 'north-up-row-major',
        tile: 'north-up-row-major',
    },
    outerBoundary: 'clamp',
    cacheValidators: {
        coherence: 'immutable',
        encodedRepresentation: 'image/png',
        decoderVersion: 'dem-png-unorm8-v1',
        etag: 'content-version-and-standard-tile',
    },
})
