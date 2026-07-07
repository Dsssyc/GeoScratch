import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    Surface,
} from '../packages/geoscratch/src/index.js'

function createFakeGpu() {

    const device = {
        features: new Set(),
        limits: {},
        queue: {},
        lost: new Promise(() => {}),
        createBuffer(descriptor) {
            return {
                descriptor,
                destroy() {},
            }
        },
        destroy() {},
    }
    const adapter = {
        features: new Set(),
        limits: {},
        async requestDevice() {
            return device
        },
    }
    const gpu = {
        async requestAdapter() {
            return adapter
        },
        getPreferredCanvasFormat() {
            return 'bgra8unorm'
        },
    }

    return { gpu, device }
}

function createFakeCanvas() {

    const context = {
        configureCalls: [],
        unconfigureCalls: 0,
        texture: { label: 'presentation texture' },
        configure(descriptor) {
            this.configureCalls.push(descriptor)
        },
        unconfigure() {
            this.unconfigureCalls++
        },
        getCurrentTexture() {
            return this.texture
        },
    }
    const canvas = {
        width: 1,
        height: 1,
        getContext(kind) {
            if (kind !== 'webgpu') return null
            return context
        },
    }

    return { canvas, context }
}

describe('Surface', () => {

    it('is created explicitly from a runtime and owns canvas configuration state', async() => {

        const { gpu, device } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })

        const surface = runtime.createSurface(canvas, {
            label: 'main surface',
            format: 'preferred',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })

        expect(surface).to.be.instanceOf(Surface)
        expect(surface.runtime).to.equal(runtime)
        expect(surface.canvas).to.equal(canvas)
        expect(surface.context).to.equal(context)
        expect(surface.format).to.equal('bgra8unorm')
        expect(surface.alphaMode).to.equal('premultiplied')
        expect(surface.size).to.deep.equal({ width: 320, height: 180 })
        expect(surface.isConfigured).to.equal(true)
        expect(surface.isDisposed).to.equal(false)
        expect(canvas.width).to.equal(320)
        expect(canvas.height).to.equal(180)
        expect(context.configureCalls).to.deep.equal([
            {
                device,
                format: 'bgra8unorm',
                alphaMode: 'premultiplied',
            },
        ])
    })

    it('supports resize/configure lifecycle independently from runtime disposal', async() => {

        const { gpu, device } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, {
            format: 'rgba8unorm',
            size: { width: 320, height: 180 },
        })

        surface.resize({ width: 640, height: 360 })

        expect(surface.size).to.deep.equal({ width: 640, height: 360 })
        expect(canvas.width).to.equal(640)
        expect(canvas.height).to.equal(360)
        expect(context.configureCalls).to.have.length(2)
        expect(context.configureCalls[1]).to.deep.equal({
            device,
            format: 'rgba8unorm',
            alphaMode: 'opaque',
        })

        surface.dispose()

        expect(surface.isDisposed).to.equal(true)
        expect(runtime.isDisposed).to.equal(false)
        expect(context.unconfigureCalls).to.equal(1)
    })

    it('rejects surface use after disposal with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const { canvas } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, { format: 'rgba8unorm' })

        surface.dispose()

        try {
            surface.getCurrentTexture()
            throw new Error('expected disposed surface access to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SURFACE_DISPOSED',
                severity: 'error',
                phase: 'runtime',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'Surface',
                id: surface.id,
            })
        }
    })
})
