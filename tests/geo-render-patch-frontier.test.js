import { expect } from 'chai'
import {
    GeoDiagnosticError,
    decodeGpuRenderPatchState,
    gpuRenderPatchReadWgslModule,
    webMercatorTerrainWgslModule,
} from 'geoscratch/geo'

describe('Geo GPU render-patch frontier', () => {

    it('publishes a complete bounded read-side lookup and stitching module', () => {

        const module = gpuRenderPatchReadWgslModule({
            namespace: 'TerrainPatch',
            group: 1,
            visibleInstancesBinding: 2,
            lookupEntriesBinding: 3,
        })

        expect(module).to.deep.include({
            kind: 'gpu-render-patch-read-wgsl-module',
            namespace: 'TerrainPatch',
        })
        expect(module.bindings).to.deep.equal({
            group: 1,
            visibleInstances: 2,
            lookupEntries: 3,
        })
        expect(module.code).to.include('@group(1) @binding(2)')
        expect(module.code).to.include('@group(1) @binding(3)')
        expect(module.code).to.include('fn TerrainPatch_lookup(')
        expect(module.code).to.include('fn TerrainPatch_covering(')
        expect(module.code).to.include('fn TerrainPatch_neighbor(')
        expect(module.code).to.include('fn TerrainPatch_snap_edge_coordinate(')
        expect(module.code).not.to.match(/\blet patch\b/)
        expect(module.layoutDependencies).to.have.length.greaterThan(1)
        expect(Object.isFrozen(module)).to.equal(true)
    })

    it('generates the complete Web Mercator terrain vertex and diagnostic presentation', () => {

        const module = webMercatorTerrainWgslModule({
            fieldNamespace: 'HeightField',
            addressNamespace: 'HeightAddress',
            cellsPerPatchEdge: 64,
            sceneGroup: 0,
            mapMetaBinding: 0,
            configBinding: 1,
            dataGroup: 1,
            indicesBinding: 0,
            gridPositionsBinding: 1,
            visibleInstancesBinding: 2,
            lookupEntriesBinding: 3,
        })

        expect(module).to.deep.include({
            kind: 'web-mercator-terrain-wgsl-module',
            namespace: 'WebMercatorTerrain',
            vertexEntryPoint: 'WebMercatorTerrain_vertex',
            tileWireframeFragmentEntryPoint: 'WebMercatorTerrain_tile_wireframe',
        })
        expect(module.code).to.include('struct WebMercatorTerrainVertexOutput')
        expect(module.code).to.include('fn WebMercatorTerrain_fixed_position(')
        expect(module.code).to.include('HeightAddressFixedPosition')
        expect(module.code).to.include('HeightAddressFixed_signed_difference_f32')
        expect(module.code).to.include('WebMercatorTerrainPatch_neighbor')
        expect(module.code).to.include('HeightField_sample_vertex')
        expect(module.code).not.to.match(/\blet sample\b/)
        expect(module.code).to.include('@vertex\nfn WebMercatorTerrain_vertex(')
        expect(module.code).to.include('@fragment\nfn WebMercatorTerrain_tile_wireframe(')
        expect(module.layoutDependencies).to.have.length.greaterThan(2)
    })

    it('decodes bounded delayed GPU selection facts', () => {

        const words = new Uint32Array(37)
        words.set([
            25,
            0,
            0,
            10,
            12,
            3 * 256,
            8 * 256,
            41,
            9,
            23,
            80,
            3,
            8,
        ])
        words.set([
            80, 52, 27, 20, 18, 16, 14, 12, 11,
            10, 9, 9, 8, 8, 8, 8, 8,
        ], 13)
        words.set([
            22,
            1,
            1,
            14,
            25,
            2,
            4,
        ], 30)
        const facts = decodeGpuRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 41 }
        )

        expect(facts).to.deep.equal({
            selectedPatchCount: 25,
            descriptorOverflowCount: 0,
            lookupOverflowCount: 0,
            minimumMatrixLevel: 10,
            maximumMatrixLevel: 12,
            minimumCellSpanPixels: 3,
            maximumCellSpanPixels: 8,
            frameEpoch: 41,
            baselinePatchBudget: 9,
            framePatchBudget: 23,
            requestedPatchCount: 80,
            minimumTrialPatchCount: 8,
            renderRootPatchCount: 8,
            selectedBiasStep: 3,
            selectedBiasLevels: 0.75,
            budgetLimitedByMinimumTrial: false,
            basePatchCount: 20,
            budgetFillSplitCount: 2,
            budgetLimitedRefinementCount: 4,
            unbalancedPatchCount: 22,
            balanceSplitCount: 1,
            balanceOverheadPatchCount: 3,
            maximumAdjacentLevelDelta: 1,
            balancePassCount: 14,
        })
    })

    it('accepts a non-monotonic complete-cut series and reports its actual minimum', () => {

        const words = new Uint32Array(37)
        words.set([
            9,
            0,
            0,
            8,
            11,
            1 * 256,
            65_535 * 256,
            17,
            12,
            31,
            9,
            0,
            2,
        ])
        words.set([
            9, 9, 9, 9, 9, 6, 2, 2, 2,
            2, 2, 2, 2, 2, 2, 2, 3,
        ], 13)
        words.set([ 9, 0, 1, 14, 9 ], 30)

        const facts = decodeGpuRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 17 }
        )

        expect(facts).to.deep.include({
            selectedPatchCount: 9,
            requestedPatchCount: 9,
            selectedBiasStep: 0,
            minimumTrialPatchCount: 2,
            renderRootPatchCount: 3,
            budgetLimitedByMinimumTrial: false,
            basePatchCount: 9,
            budgetFillSplitCount: 0,
            budgetLimitedRefinementCount: 0,
            unbalancedPatchCount: 9,
            balanceSplitCount: 0,
            balanceOverheadPatchCount: 0,
            maximumAdjacentLevelDelta: 1,
            balancePassCount: 14,
        })
        expect(facts).not.to.have.property('sourceFloorPatchCount')
        expect(facts).not.to.have.property('budgetLimitedBySourceFloor')
    })

    it('rejects feedback from a different frame epoch', () => {

        expect(() => decodeGpuRenderPatchState(
            new Uint8Array(148),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 9 }
        )).to.throw(GeoDiagnosticError, 'frame epoch')
    })

    it('rejects a final render cut whose adjacent patch levels differ by more than one', () => {

        const words = new Uint32Array(37)
        words.set([
            4,
            0,
            0,
            8,
            10,
            2 * 256,
            8 * 256,
            7,
            9,
            12,
            4,
            0,
            4,
        ])
        words.fill(4, 13, 30)
        words.set([ 4, 0, 2, 14, 4 ], 30)

        expect(() => decodeGpuRenderPatchState(
            new Uint8Array(words.buffer),
            { maximumRenderPatches: 12_544, expectedFrameEpoch: 7 }
        )).to.throw('level-difference-one')
    })
})
