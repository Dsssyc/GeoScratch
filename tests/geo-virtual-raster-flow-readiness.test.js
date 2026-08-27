import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('Geo virtual-raster Flow readiness contract', () => {

    const fixture = read('tests', 'fixtures', 'geo-virtual-raster-dynamic-flow.ts')
    const browser = read('tests', 'browser', 'geo-virtual-raster-dynamic-flow.mjs')
    const readiness = read('docs', 'review', 'geo-virtual-raster-flow-readiness.md')
    const demAudit = read('docs', 'review', 'geo-virtual-raster-dem-audit.md')

    it('keeps the executable proof at the required public-API boundary', () => {

        expect(fixture).to.include('const PARTICLE_COUNT = 262_144')
        expect(fixture).to.include("cellLocalF32Codec({")
        expect(fixture).to.include('virtualRasterAddressSpace({')
        expect(fixture).to.include('new VirtualRasterResidency({')
        expect(fixture).to.include('createVirtualRasterGpuState(runtime')
        expect(fixture).to.include('createComputePipeline({')
        expect(fixture).to.include('createDispatchCommand({')
        expect(fixture.match(/createReadback\(\{/g)).to.have.length(1)
        expect(fixture).not.to.include('runtime.device')
        expect(fixture).not.to.include('runtime.queue')
        expect(fixture).not.to.include('examples/flowLayer')
        expect(browser).to.include('value.sourceFacts.modifiesVisibleFlowLayer')
    })

    it('owns the existing Flow regression Chrome process through BrowserServer', () => {

        const regression = read('tests', 'browser', 'scratch-flow-layer.mjs')

        expect(regression).to.include('chromium.launchServer({')
        expect(regression).to.include('browserServer.process()')
        expect(regression).to.include('browserServer.close()')
        expect(regression).to.include('browserServer.kill()')
        expect(regression).to.include('waitForBrowserProcessExit(browserProcess')
        expect(regression).to.include('browserProcess.exitCode === 0')
        expect(regression).to.include('browserProcessExited')
        expect(regression).not.to.include('chromium.launch({')
    })

    it('uses workgroup reduction and records every bounded proof fact', () => {

        expect(fixture).to.include('var<workgroup> workgroup_counters')
        expect(fixture).to.include('workgroupBarrier()')
        expect(fixture.match(/atomicAdd\(&counters\[/g)).to.have.length(4)
        for (const fact of [
            'logicalAddressBytesPersisted',
            'computeAddressMaterializationPassCount',
            'cpuParticleMirrorBytesPerStep',
            'finalReadbackCount',
            'requestedLodRange',
            'resolvedLodRange',
            'snapshotEpochs',
            'coordinateErrorBound',
        ]) {
            expect(fixture).to.include(fact)
            expect(browser).to.include(fact)
        }
    })

    it('records the independent velocity-only Flow Field readiness boundary', () => {

        for (const requirement of [
            'independent `Flow Field`',
            'velocity-only',
            'no support/mask plane',
            '27 slices',
            'simulation, render-demand, and resolved-residency levels',
            'prediction',
            'split/merge',
            'history',
            '`flowVoronoi.wgsl`',
            '`flow-worker.ts`',
            '`FLOW_DISPLAY_EXTENT`',
            'does not modify or migrate',
        ]) expect(readiness).to.include(requirement)
    })

    it('records the DEM one-to-one audit and the inherited depth limitation', () => {

        for (const requirement of [
            'Required behavior',
            'Current owner and implementation',
            'Automated evidence',
            'Status',
            'Remaining limitation',
            'Terrain selection',
            'terrain-presentation.wgsl',
            'stitch',
            'Elevation',
            'Projection',
            'projects each candidate AABB',
            'logical selected-patch lookup',
            'indirect',
            'Resize',
            'Lifecycle',
            'zero console warnings/errors',
            'Yangtze',
            'COG',
            'virtual',
            '30x',
            '50x',
        ]) expect(demAudit).to.include(requirement)
    })
})
