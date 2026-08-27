import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import {
    createFlowTemporalBindings,
} from '../examples/flowField/flow-temporal-bindings.ts'

const wrapper = fs.readFileSync(path.join(
    process.cwd(),
    'examples',
    'flowField',
    'shaders',
    'temporal-velocity.wgsl'
), 'utf8')

describe('Flow Field temporal bindings', () => {

    it('creates one stable group-1 layout and current-generation frame', async() => {

        const fixture = temporalFixture()
        const provider = await createFlowTemporalBindings({
            temporal: fixture.temporal,
            requestedLevel: 0,
            wrapper,
        })
        const frame = provider.frame()

        expect(provider.layout.group).to.equal(1)
        expect(provider.layout.entries).to.deep.equal([
            {
                binding: 0,
                name: 'currentPageTable',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'currentAtlas',
                type: 'texture',
                sampleType: 'unfilterable-float',
                viewDimension: '2d',
                visibility: [ 'compute' ],
            },
            {
                binding: 2,
                name: 'nextPageTable',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 3,
                name: 'nextAtlas',
                type: 'texture',
                sampleType: 'unfilterable-float',
                viewDimension: '2d',
                visibility: [ 'compute' ],
            },
        ])
        expect(provider.module.bindings.group).to.equal(1)
        expect(provider.wgsl).to.equal(provider.module.code)
        expect(frame).to.deep.include({
            progress: 0.25,
            requestedLevel: 0,
        })
        expect(frame.resources).to.deep.equal([
            fixture.currentResources.pageTable.buffer,
            fixture.currentResources.atlas.texture,
            fixture.nextResources.pageTable.buffer,
            fixture.nextResources.atlas.texture,
        ])
        expect(provider.facts()).to.deep.include({
            generation: 1,
            requestedLevel: 0,
            refreshCount: 0,
            ownsTemporal: false,
            disposed: false,
        })

        provider.setRequestedLevel(1)
        expect(provider.frame().requestedLevel).to.equal(1)
        expect(() => provider.setRequestedLevel(2)).to.throw(RangeError)
        provider.dispose()
        expect(fixture.temporalDisposeCount).to.equal(0)
    })

    it('creates the rotated set before releasing the old set and hard-fails stale frames', async() => {

        const fixture = temporalFixture()
        const provider = await createFlowTemporalBindings({
            temporal: fixture.temporal,
            requestedLevel: 0,
            wrapper,
        })
        const oldSet = provider.frame().bindSet
        fixture.rotate()

        expect(() => provider.frame()).to.throw(/refresh/i)
        expect(provider.facts().generation).to.equal(1)
        expect(await provider.refresh()).to.equal(true)

        const nextFrame = provider.frame()
        expect(nextFrame.bindSet).to.not.equal(oldSet)
        expect(oldSet.isDisposed).to.equal(true)
        expect(fixture.events.slice(-2)).to.deep.equal([
            'create-set:g2',
            'dispose-set:g1',
        ])
        expect(provider.facts()).to.deep.include({
            generation: 2,
            temporalGeneration: 2,
            refreshCount: 1,
        })

        fixture.replaceAllocations()
        expect(await provider.refresh()).to.equal(false)
        expect(provider.frame().bindSet).to.equal(nextFrame.bindSet)
        expect(provider.facts().refreshCount).to.equal(1)

        provider.dispose()
        provider.dispose()
        expect(fixture.temporalDisposeCount).to.equal(0)
    })

    it('loads the production wrapper through the colocated raw asset path', () => {

        const source = fs.readFileSync(path.join(
            process.cwd(), 'examples', 'flowField', 'flow-temporal-bindings.ts'
        ), 'utf8')
        expect(source).to.include("import('./shaders/temporal-velocity.wgsl?raw')")
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.include('packages/geoscratch/src')
    })
})

function temporalFixture() {

    const events = []
    const runtime = fakeRuntime(events)
    let generation = 1
    let progress = 0.25
    let current = fakeTimeRuntime(runtime, 'current-g1')
    let next = fakeTimeRuntime(runtime, 'next-g1')
    let prefetch = fakeTimeRuntime(runtime, 'prefetch-g1')
    let temporalDisposeCount = 0
    const temporal = {
        get current() { return current },
        get next() { return next },
        get prefetch() { return prefetch },
        snapshot: () => Object.freeze({ generation, progress }),
        activeBindResources: () => Object.freeze({
            generation,
            current: Object.freeze({
                timeIndex: generation - 1,
                pageTable: current.gpu.pageTable.region(),
                atlas: current.gpu.atlasView,
            }),
            next: Object.freeze({
                timeIndex: generation,
                pageTable: next.gpu.pageTable.region(),
                atlas: next.gpu.atlasView,
            }),
        }),
        async dispose() { temporalDisposeCount++ },
    }
    return {
        events,
        temporal,
        get temporalDisposeCount() { return temporalDisposeCount },
        get currentResources() {
            return {
                pageTable: current.gpu.pageTable.region(),
                atlas: current.gpu.atlasView,
            }
        },
        get nextResources() {
            return {
                pageTable: next.gpu.pageTable.region(),
                atlas: next.gpu.atlasView,
            }
        },
        rotate() {

            generation = 2
            progress = 0
            current = next
            next = prefetch
            prefetch = fakeTimeRuntime(runtime, 'prefetch-g2')
        },
        replaceAllocations() {

            current.gpu.pageTable.allocationVersion++
            next.gpu.pageTable.allocationVersion++
        },
    }
}

function fakeTimeRuntime(runtime, id) {

    const model = velocityModel(id)
    const pageTable = fakeResource(runtime, `${id}-page-table`)
    const atlas = fakeResource(runtime, `${id}-atlas`)
    return {
        model,
        gpu: {
            runtime,
            pageTable,
            atlas,
            atlasView: Object.freeze({ texture: atlas, id: `${id}-atlas-view` }),
        },
    }
}

function velocityModel(id) {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            {
                matrixId: '8',
                minTileRow: 105,
                maxTileRow: 105,
                minTileCol: 214,
                maxTileCol: 214,
            },
            {
                matrixId: '9',
                minTileRow: 210,
                maxTileRow: 210,
                minTileCol: 428,
                maxTileCol: 428,
            },
        ],
    })
    return webMercatorVirtualRasterField({
        id: `flow-${id}`,
        addressSpaceId: `flow-address-${id}`,
        sourceRevision: 'test-v1',
        coverage,
        geographicBounds: [ 120, 30, 122, 32 ],
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        interpolation: 'linear',
    })
}

function fakeResource(runtime, id) {

    const resource = {
        runtime,
        id,
        allocationVersion: 1,
        region: () => Object.freeze({ buffer: resource, id: `${id}-region` }),
    }
    return resource
}

function fakeRuntime(events) {

    return {
        async createBindLayout(descriptor) {

            return { ...descriptor, runtime: this, dispose() {} }
        },
        async createBindSet(layout, bindings, options) {

            const generation = Number(/generation (\d+)/.exec(options.label)?.[1])
            events.push(`create-set:g${generation}`)
            return {
                layout,
                bindings,
                isDisposed: false,
                dispose() {

                    if (this.isDisposed) return
                    this.isDisposed = true
                    events.push(`dispose-set:g${generation}`)
                },
            }
        },
    }
}
