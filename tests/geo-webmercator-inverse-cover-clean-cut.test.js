import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(...segments) {

    return fs.readFileSync(path.join(root, ...segments), 'utf8')
}

function exists(...segments) {

    return fs.existsSync(path.join(root, ...segments))
}

describe('WebMercatorQuad inverse-cover clean cut', () => {

    it('keeps Virtual Raster demand and residency free of view LoD authority', () => {

        const sources = [
            'virtual-raster-demand.ts',
            'virtual-raster-residency.ts',
            'virtual-raster-runtime.ts',
        ].map(file => read('packages', 'geoscratch', 'src', 'geo', file)).join('\n')

        for (const forbidden of [
            'zoomHint',
            'cameraPitchRadians',
            'refineErrorPixels',
            'coarsenErrorPixels',
            'maximumCellSpanReferencePixels',
            'renderMaximumMatrixLevel',
        ]) {
            expect(sources, forbidden).not.to.include(forbidden)
        }
    })

    it('publishes one inverse standard-cover authority and no legacy frontier authority', () => {

        const index = read('packages', 'geoscratch', 'src', 'geo', 'index.ts')
        expect(index).to.include('GpuWebMercatorQuadCover')
        expect(index).to.include('gpuWebMercatorQuadCoverPolicy')
        expect(index).not.to.include('GpuTileFrontier')
        expect(index).not.to.include('GpuRenderPatchFrontier')
        expect(index).not.to.include('createGpuRenderPatchFrontier')
        expect(exists(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'gpu-tile-frontier.ts'
        )).to.equal(false)
        expect(exists(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'gpu-render-patch-frontier.ts'
        )).to.equal(false)
    })

    it('contains no root-forward or repeated-trial selection path', () => {

        const cover = read(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'gpu-web-mercator-quad-cover.ts'
        )
        const wgsl = read(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'gpu-web-mercator-quad-cover-wgsl.ts'
        )
        const terrain = read(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'web-mercator-terrain-renderer.ts'
        )
        const sources = [ cover, wgsl, terrain ].join('\n')

        expect(cover).to.include('export class GpuWebMercatorQuadCover')
        for (const forbidden of [
            'renderRoots',
            'countRenderPatchTrials',
            'biasStepCount',
            'trialCounts',
            'rootTraversalCount',
            'trialCount',
            'maximumDemands',
            'createGpuRenderPatchFrontier',
            'GpuTileFrontier',
            'frontierDecisionKey',
            'frontierEncoding',
        ]) {
            expect(sources, forbidden).not.to.include(forbidden)
        }
    })

    it('keeps desired sample precision observable before passive residency lowering', () => {

        const cover = read(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'gpu-web-mercator-quad-cover.ts'
        )
        const demand = read(
            'packages',
            'geoscratch',
            'src',
            'geo',
            'view-tile-demand.ts'
        )

        expect(cover).to.include('desiredSampleLevel')
        expect(cover).to.include('sourceLevelCeiling')
        expect(demand).to.include('desiredSampleLevel')
        expect(demand).to.include('sourceLevelCeiling')
    })
})
