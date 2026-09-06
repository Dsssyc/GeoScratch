import { expect } from 'chai'
import {
    createGeoFrameController,
    mapLibreFrameDriver,
} from 'geoscratch/geo'

describe('MapLibre frame driver', () => {

    it('admits controller work inside the host layer and captures once per view revision', async() => {

        const map = fakeMapLibreMap()
        const captures = []
        const submissions = []
        let camera = 4
        const controller = createGeoFrameController({
            driver: mapLibreFrameDriver({
                id: 'terrain-frames',
                map,
                capture() {
                    captures.push(camera)
                    return Object.freeze({ camera })
                },
            }),
            render(_frameNumber, capture) {
                submissions.push(capture.camera)
                return Promise.resolve({
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.camera,
                })
            },
        })

        expect(map.layerIds).to.deep.equal([ 'terrain-frames' ])
        expect(map.repaintCount).to.equal(1)
        const initialHostFrame = map.renderLayer('terrain-frames')
        expect(submissions).to.deep.equal([ 4 ])
        await initialHostFrame

        controller.invalidate()
        await map.renderLayer('terrain-frames')
        expect(captures).to.deep.equal([ 4 ])
        expect(submissions).to.deep.equal([ 4, 4 ])

        camera = 8
        map.emit('move')
        map.emit('move')
        expect(map.repaintCount).to.equal(3)
        await map.renderLayer('terrain-frames')
        expect(captures).to.deep.equal([ 4, 8 ])
        expect(submissions).to.deep.equal([ 4, 4, 8 ])
        expect(controller.snapshot()).to.deep.include({
            latestCaptureRevision: 2,
            submittedCaptureRevision: 2,
        })

        camera = 9
        map.emit('resize')
        await map.renderLayer('terrain-frames')
        expect(captures).to.deep.equal([ 4, 8, 9 ])
        expect(submissions).to.deep.equal([ 4, 4, 8, 9 ])
    })

    it('reattaches after style load and releases only owned host state', async() => {

        const map = fakeMapLibreMap()
        const controller = createGeoFrameController({
            driver: mapLibreFrameDriver({
                id: 'terrain-frames',
                map,
                capture: () => Object.freeze({ camera: 1 }),
            }),
            render: async() => ({
                observation: Promise.resolve(),
                needsFollowUp: false,
                value: undefined,
            }),
        })

        await map.renderLayer('terrain-frames')
        map.clearStyleLayers()
        map.emit('style.load')
        expect(map.layerIds).to.deep.equal([ 'terrain-frames' ])
        expect(map.listenerCount('move')).to.equal(1)
        expect(map.listenerCount('resize')).to.equal(1)
        expect(map.listenerCount('style.load')).to.equal(1)

        controller.invalidate()
        expect(map.pendingLayerFrameCount).to.equal(1)
        expect(controller.stop()).to.equal(true)
        expect(controller.stop()).to.equal(false)
        expect(map.layerIds).to.deep.equal([])
        expect(map.listenerCount('move')).to.equal(0)
        expect(map.listenerCount('resize')).to.equal(0)
        expect(map.listenerCount('style.load')).to.equal(0)
        expect(controller.snapshot().cancelledFrameCount).to.equal(1)
    })

    it('defers attachment and delivers the latest invalidation after initial style load', async() => {

        const map = fakeMapLibreMap({ styleLoaded: false })
        const captures = []
        const submissions = []
        let camera = 1
        const controller = createGeoFrameController({
            driver: mapLibreFrameDriver({
                id: 'terrain-frames',
                map,
                capture() {
                    captures.push(camera)
                    return Object.freeze({ camera })
                },
            }),
            render(_frameNumber, capture) {
                submissions.push(capture.camera)
                return Promise.resolve({
                    observation: Promise.resolve(),
                    needsFollowUp: false,
                    value: capture.camera,
                })
            },
        })

        expect(map.layerIds).to.deep.equal([])
        expect(map.repaintCount).to.equal(0)
        camera = 2
        controller.invalidate()
        camera = 3
        controller.invalidate()
        expect(captures).to.deep.equal([])

        map.setStyleLoaded(true)
        map.emit('style.load')
        expect(map.layerIds).to.deep.equal([ 'terrain-frames' ])
        expect(map.repaintCount).to.equal(1)
        await map.renderLayer('terrain-frames')
        expect(captures).to.deep.equal([ 3 ])
        expect(submissions).to.deep.equal([ 3 ])
    })

    it('does not attach after stopping before initial style load', () => {

        const map = fakeMapLibreMap({ styleLoaded: false })
        const controller = createGeoFrameController({
            driver: mapLibreFrameDriver({
                id: 'terrain-frames',
                map,
                capture: () => Object.freeze({ camera: 1 }),
            }),
            render: async() => ({
                observation: Promise.resolve(),
                needsFollowUp: false,
                value: undefined,
            }),
        })

        controller.invalidate()
        expect(controller.stop()).to.equal(true)
        map.setStyleLoaded(true)
        map.emit('style.load')
        map.emit('idle')
        expect(map.layerIds).to.deep.equal([])
        expect(map.repaintCount).to.equal(0)
        expect(map.listenerCount('style.load')).to.equal(0)
        expect(map.listenerCount('idle')).to.equal(0)
    })

    it('recovers on idle when style.load occurred before driver start', async() => {
        const map = fakeMapLibreMap({ styleLoaded: false })
        map.emit('style.load')
        const frames = []
        let camera = 1
        const controller = createGeoFrameController({
            driver: mapLibreFrameDriver({ id: 'flow-frames', map, capture: () => camera }),
            render: async(_frame, value) => {
                frames.push(value)
                return { observation: Promise.resolve(), needsFollowUp: false, value }
            },
        })
        controller.invalidate()
        camera = 2
        controller.invalidate()
        map.emit('idle')
        expect(map.layerIds).to.deep.equal([])
        expect(map.repaintCount).to.equal(0)
        map.setStyleLoaded(true)
        map.emit('idle')
        expect(map.layerIds).to.deep.equal(['flow-frames'])
        await map.renderLayer('flow-frames')
        expect(frames).to.deep.equal([2])
        const repaints = map.repaintCount
        map.emit('idle')
        expect(map.repaintCount).to.equal(repaints)
        controller.stop()
        expect(map.listenerCount('idle')).to.equal(0)
    })

    it('preserves a foreign layer installed while waiting for idle readiness', () => {
        const map = fakeMapLibreMap({ styleLoaded: false })
        const driver = mapLibreFrameDriver({ id: 'flow-frames', map, capture: () => 1 })
        driver.start(() => false)
        const foreign = { id: 'flow-frames', type: 'custom', render() {} }
        map.addLayer(foreign)
        map.setStyleLoaded(true)
        expect(() => map.emit('idle')).to.throw().with.nested.property(
            'diagnostic.code', 'GEO_MAPLIBRE_FRAME_LAYER_CONFLICT')
        driver.stop()
        expect(map.getLayer('flow-frames')).to.equal(foreign)
        expect(map.listenerCount('idle')).to.equal(0)
    })

    it('reports invalid hosts and preserves a conflicting host layer', () => {

        expect(() => mapLibreFrameDriver({
            id: 'terrain-frames',
            map: {},
            capture: () => undefined,
        })).to.throw().with.nested.property(
            'diagnostic.code',
            'GEO_MAPLIBRE_FRAME_DRIVER_INVALID'
        )

        const map = fakeMapLibreMap()
        const existing = Object.freeze({
            id: 'terrain-frames',
            type: 'custom',
            render() {},
        })
        map.addLayer(existing)
        expect(() => createGeoFrameController({
            driver: mapLibreFrameDriver({
                id: 'terrain-frames',
                map,
                capture: () => undefined,
            }),
            render: async() => ({
                observation: Promise.resolve(),
                needsFollowUp: false,
                value: undefined,
            }),
        })).to.throw().with.nested.property(
            'diagnostic.code',
            'GEO_MAPLIBRE_FRAME_LAYER_CONFLICT'
        )
        expect(map.getLayer('terrain-frames')).to.equal(existing)
    })
})

function fakeMapLibreMap(options = {}) {

    const listeners = new Map()
    const layers = new Map()
    let styleLoaded = options.styleLoaded ?? true
    let repaintCount = 0
    let pendingLayerFrameCount = 0
    return {
        on(event, listener) {
            const entries = listeners.get(event) ?? new Set()
            entries.add(listener)
            listeners.set(event, entries)
        },
        off(event, listener) {
            listeners.get(event)?.delete(listener)
        },
        emit(event) {
            for (const listener of [ ...(listeners.get(event) ?? []) ]) listener()
        },
        addLayer(layer) {
            if (layers.has(layer.id)) throw new Error(`Layer ${layer.id} already exists`)
            layers.set(layer.id, layer)
            layer.onAdd?.(this, {})
        },
        removeLayer(id) {
            const layer = layers.get(id)
            if (layer === undefined) throw new Error(`Layer ${id} does not exist`)
            layers.delete(id)
            layer.onRemove?.(this, {})
        },
        getLayer: id => layers.get(id),
        isStyleLoaded: () => styleLoaded,
        setStyleLoaded(value) {
            styleLoaded = value
        },
        triggerRepaint() {
            repaintCount++
            pendingLayerFrameCount = 1
        },
        async renderLayer(id) {
            const layer = layers.get(id)
            if (layer === undefined) throw new Error(`Layer ${id} does not exist`)
            pendingLayerFrameCount = 0
            layer.render({}, new Float32Array(16), Object.freeze({}))
            await flushTasks()
        },
        clearStyleLayers() {
            for (const layer of layers.values()) layer.onRemove?.(this, {})
            layers.clear()
        },
        listenerCount: event => listeners.get(event)?.size ?? 0,
        get layerIds() {
            return [ ...layers.keys() ]
        },
        get repaintCount() {
            return repaintCount
        },
        get pendingLayerFrameCount() {
            return pendingLayerFrameCount
        },
    }
}

async function flushTasks() {

    await new Promise(resolve => setImmediate(resolve))
}
