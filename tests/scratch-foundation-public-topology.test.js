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
    'WorkerGroup',
    'WorkerSystem',
    'WorkerTaskHandle',
    'createCacheDiagnostic',
    'createLayoutReadbackView',
    'createScratchDiagnostic',
    'createScratchDiagnosticReport',
    'defineWorkerModule',
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
    'persistentCacheKey',
    'plane',
    'sphere',
    'transferWorkerResult',
]

const geoValues = [
    'CellLocalF32Codec',
    'GeoDiagnosticError',
    'GpuTileFrontier',
    'MercatorCoordinate',
    'TileMatrixCoverage',
    'ViewDemandProducer',
    'VirtualRasterAccessor',
    'VirtualRasterAddressSpace',
    'VirtualRasterGpuFeedbackRing',
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
    'WebMercatorQuad',
    'WebMercatorQuadAddressCodec',
    'WideFixedCodec',
    'adoptVirtualRasterPageTransfer',
    'cellLocalF32Codec',
    'coordinateDomain',
    'createGeoDiagnostic',
    'createGeoViewAdapter',
    'createGeoViewSnapshot',
    'createVirtualRasterGpuState',
    'discardOwnedVirtualRasterPagePayload',
    'discardVirtualRasterPageTransfer',
    'geoField',
    'gpuTileFrontierPolicy',
    'gpuTileFrontierRenderWgslModule',
    'isGeoDiagnosticError',
    'localVector',
    'mapFieldLayer',
    'mapLibrePlanarViewAdapter',
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
    'virtualRasterDemandSet',
    'virtualRasterDemandSetFromViewDemands',
    'virtualRasterPlane',
    'virtualRasterSamplingProfile',
    'virtualRasterSource',
    'virtualRasterTileAddressSpace',
    'webMercatorPlanarTileSpatialProfile',
    'webMercatorQuadAddressCodec',
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
