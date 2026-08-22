import { expect } from 'chai'
import fs from 'node:fs'
import * as root from 'geoscratch'
import * as geo from 'geoscratch/geo'
import * as scratch from 'geoscratch/scratch'

const scratchValues = [
    'BeginOcclusionQueryCommand',
    'BindLayout',
    'BindSet',
    'BufferRegion',
    'BufferResource',
    'BundleDrawCommand',
    'ClearBufferCommand',
    'ComputePassSpec',
    'ComputePipeline',
    'CopyCommand',
    'DebugCommand',
    'DispatchCommand',
    'DrawCommand',
    'EndOcclusionQueryCommand',
    'ExecuteRenderBundlesCommand',
    'ExternalImageUploadCommand',
    'ExternalTextureBinding',
    'GPUDiagnosticCapture',
    'GPURuntime',
    'GPURuntimeDiagnostics',
    'LayoutCodec',
    'LifetimeScope',
    'MappedBufferLease',
    'MappedReadbackLease',
    'PersistentCache',
    'Program',
    'QuerySetResource',
    'ReadbackCommand',
    'ReadbackOperation',
    'RenderBundle',
    'RenderPassSpec',
    'RenderPipeline',
    'ResolveQuerySetCommand',
    'Resource',
    'SamplerResource',
    'ScratchDiagnosticError',
    'ShaderModule',
    'SubmissionAuthority',
    'SubmissionBuilder',
    'SubmittedWork',
    'Surface',
    'SurfaceTextureLease',
    'SurfaceTextureView',
    'TaskPhaseBudget',
    'TextureResource',
    'TextureUploadCommand',
    'TextureViewSpec',
    'UploadCommand',
    'WorkerContextHandle',
    'WorkerContextPool',
    'WorkerGroup',
    'WorkerModuleCatalog',
    'WorkerSystem',
    'WorkerTaskHandle',
    'createCacheDiagnostic',
    'createLayoutReadbackView',
    'createScratchDiagnostic',
    'createScratchDiagnosticReport',
    'defineWorkerModule',
    'defineWorkerModuleBuild',
    'defineWorkerModuleContract',
    'describeLayoutCompatibilityDifference',
    'inspectShader',
    'isLayoutArtifact',
    'isLayoutBufferViewContract',
    'isLayoutCodec',
    'isLayoutUploadView',
    'isScratchDiagnosticError',
    'layoutArtifactAcceptsBindingByteLength',
    'layoutArtifactAcceptsViewByteLength',
    'layoutArtifactByteLength',
    'layoutArtifactRuntimeElementCount',
    'layoutArtifactsAbiCompatible',
    'layoutArtifactsSchemaCompatible',
    'layoutCodec',
    'persistentCacheDescriptor',
    'persistentCacheKey',
    'plane',
    'recommendedWorkerCount',
    'sphere',
    'transferWorkerResult',
    'workerRemoteErrorCode',
    'workerRemoteErrorFacts',
]

const geoValues = [
    'CellLocalF32Codec',
    'GeoDiagnosticError',
    'GpuWebMercatorQuadCover',
    'MercatorCoordinate',
    'TileMatrixCoverage',
    'ViewDemandProducer',
    'VirtualRasterAccessor',
    'VirtualRasterAddressSpace',
    'VirtualRasterGpuState',
    'VirtualRasterPublication',
    'VirtualRasterRequestScheduler',
    'VirtualRasterResidency',
    'VirtualRasterResidencyLease',
    'VirtualRasterSnapshot',
    'WEB_MERCATOR_QUAD_HALF_WORLD',
    'WEB_MERCATOR_QUAD_MAX_LATITUDE',
    'WEB_MERCATOR_QUAD_MAX_ZOOM',
    'WEB_MERCATOR_QUAD_WORLD_WIDTH',
    'WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT',
    'WebMercatorQuad',
    'WebMercatorQuadAddressCodec',
    'WideFixedCodec',
    'adoptVirtualRasterPageTransfer',
    'cellLocalF32Codec',
    'coordinateDomain',
    'createGeoDiagnostic',
    'createGeoFrameController',
    'createGeoViewAdapter',
    'createGeoViewSnapshot',
    'createGeoViewSource',
    'createVirtualRasterDemandController',
    'createVirtualRasterGpuState',
    'createVirtualRasterRuntime',
    'createVirtualRasterWorkerExecutor',
    'createWebMercatorTerrainRenderer',
    'decodeGpuWebMercatorQuadCoverFeedback',
    'discardOwnedVirtualRasterPagePayload',
    'discardVirtualRasterPageTransfer',
    'geoField',
    'gpuWebMercatorQuadCoverPolicy',
    'gpuWebMercatorQuadCoverReadWgslModule',
    'isGeoDiagnosticError',
    'localVector',
    'mapFieldLayer',
    'mapLibreFrameDriver',
    'mapLibrePlanarViewAdapter',
    'mapLibrePlanarViewSource',
    'ownedVirtualRasterPagePayload',
    'planarTileSpatialProfile',
    'prepareVirtualRasterPageTransfer',
    'regularQuadTileTopology',
    'surfaceDomain',
    'tileMatrixCoverage',
    'tileMatrixSet',
    'tiledFieldRepresentation',
    'virtualRasterAccessor',
    'virtualRasterAddressSpace',
    'virtualRasterCacheAddress',
    'virtualRasterCacheMetadataMatches',
    'virtualRasterDemandSet',
    'virtualRasterDemandSetFromViewDemands',
    'virtualRasterPlane',
    'virtualRasterSamplingProfile',
    'virtualRasterTileAddressSpace',
    'webMercatorPlanarTileSpatialProfile',
    'webMercatorQuadAddressCodec',
    'webMercatorTerrainWgslModule',
    'webMercatorVirtualRasterField',
    'webMercatorVirtualRasterWgslModule',
    'wideFixedCodec',
]

describe('Scratch foundation public topology', () => {

    it('publishes only Scratch and Geo namespaces from the package root', () => {

        expect(Object.keys(root).sort()).to.deep.equal([ 'geo', 'scratch' ])
        expect(Object.keys(root.scratch).sort()).to.deep.equal(scratchValues)
        expect(Object.keys(root.geo).sort()).to.deep.equal(geoValues)
        expect(root.scratch.GPURuntime).to.equal(scratch.GPURuntime)
        expect(root.scratch.WorkerSystem).to.equal(scratch.WorkerSystem)
        expect(root.geo.WebMercatorQuad).to.equal(geo.WebMercatorQuad)
    })

    it('keeps exact Scratch and Geo runtime value manifests', () => {

        expect(Object.keys(scratch).sort()).to.deep.equal(scratchValues)
        expect(Object.keys(geo).sort()).to.deep.equal(geoValues)
    })

    it('publishes only the four approved package export keys', () => {

        const pkg = JSON.parse(fs.readFileSync(
            new URL('../packages/geoscratch/package.json', import.meta.url),
            'utf8',
        ))

        expect(pkg.exports).to.deep.equal({
            '.': {
                types: './dist/index.d.ts',
                import: './dist/index.js',
            },
            './scratch': {
                types: './dist/scratch.d.ts',
                import: './dist/scratch.js',
            },
            './geo': {
                types: './dist/geo/index.d.ts',
                import: './dist/geo/index.js',
            },
            './package.json': './package.json',
        })
    })

    it('does not resolve removed Worker and geometry subpaths', async () => {

        for (const subpath of [ 'geoscratch/worker', 'geoscratch/geometry' ]) {
            let failure
            try {
                await import(subpath)
            } catch (error) {
                failure = error
            }
            expect(failure, subpath).to.be.instanceOf(Error)
            expect(failure.code, subpath).to.equal('ERR_PACKAGE_PATH_NOT_EXPORTED')
        }
    })
})
