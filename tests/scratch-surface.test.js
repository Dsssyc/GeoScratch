import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    Surface,
} from 'geoscratch'

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
        pushErrorScope() {},
        async popErrorScope() {
            return null
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
        getConfigurationCalls: 0,
        configuration: null,
        currentTextureCalls: 0,
        texture: { label: 'presentation texture' },
        configure(descriptor) {
            this.configureCalls.push(descriptor)
            this.configuration = {
                usage: 0x10,
                viewFormats: [],
                colorSpace: 'srgb',
                ...descriptor,
            }
        },
        unconfigure() {
            this.unconfigureCalls++
            this.configuration = null
        },
        getConfiguration() {
            this.getConfigurationCalls++
            return this.configuration === null
                ? null
                : { ...this.configuration, viewFormats: [ ...this.configuration.viewFormats ] }
        },
        getCurrentTexture() {
            this.currentTextureCalls++
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

    it('claims each canvas context exclusively until the owning Surface is disposed', async() => {

        for (const contenderKind of [ 'same-runtime', 'different-runtime' ]) {
            const { gpu } = createFakeGpu()
            const { canvas, context } = createFakeCanvas()
            const ownerRuntime = await ScratchRuntime.create({ gpu })
            const contenderRuntime = contenderKind === 'same-runtime'
                ? ownerRuntime
                : await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
            const owner = ownerRuntime.createSurface(canvas, {
                label: 'owner',
                format: 'rgba8unorm',
                size: { width: 4, height: 4 },
            })

            try {
                contenderRuntime.createSurface(canvas, {
                    label: 'contender',
                    format: 'bgra8unorm',
                    size: { width: 8, height: 8 },
                })
                throw new Error('expected duplicate canvas-context ownership to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_SURFACE_CONTEXT_IN_USE',
                    severity: 'error',
                    phase: 'runtime',
                })
                expect(error.diagnostic.subject).to.include({
                    kind: 'Surface',
                    label: 'contender',
                })
                expect(error.diagnostic.related).to.deep.include(owner.subject)
            }

            expect(context.configureCalls).to.have.length(1)
            expect(context.unconfigureCalls).to.equal(0)
            expect(canvas.width).to.equal(4)
            expect(canvas.height).to.equal(4)

            owner.dispose()
            const replacement = contenderRuntime.createSurface(canvas, {
                format: 'bgra8unorm',
            })

            expect(replacement.context).to.equal(context)
            expect(context.configureCalls).to.have.length(2)
            expect(context.unconfigureCalls).to.equal(1)
        }
    })

    it('releases an uncommitted canvas-context claim after configure fails', async() => {

        const { gpu } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const configure = context.configure.bind(context)
        let shouldFail = true
        context.configure = descriptor => {
            if (shouldFail) {
                shouldFail = false
                throw new Error('synchronous configure failure')
            }
            configure(descriptor)
        }

        try {
            runtime.createSurface(canvas, { format: 'rgba8unorm' })
            throw new Error('expected initial Surface configuration to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SURFACE_CONFIGURATION_FAILED',
                severity: 'error',
                phase: 'runtime',
            })
            expect(error.cause).to.be.instanceOf(Error)
            expect(error.cause.message).to.equal('synchronous configure failure')
        }

        const surface = runtime.createSurface(canvas, {
            format: 'bgra8unorm',
        })

        expect(surface.isConfigured).to.equal(true)
        expect(context.configureCalls).to.have.length(1)
        expect(context.configureCalls[0].format).to.equal('bgra8unorm')
    })

    it('rolls back logical and canvas facts after synchronous reconfigure failure', async() => {

        const { gpu } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, {
            format: 'rgba8unorm',
            alphaMode: 'opaque',
            size: { width: 4, height: 4 },
        })
        const currentConfiguration = context.getConfiguration()
        const configure = context.configure.bind(context)
        context.configure = () => {
            throw new Error('synchronous reconfigure failure')
        }

        try {
            surface.configure({
                format: 'bgra8unorm',
                alphaMode: 'premultiplied',
                size: { width: 8, height: 8 },
            })
            throw new Error('expected Surface reconfiguration to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SURFACE_CONFIGURATION_FAILED',
                severity: 'error',
                phase: 'runtime',
            })
        }

        expect(surface.format).to.equal('rgba8unorm')
        expect(surface.alphaMode).to.equal('opaque')
        expect(surface.size).to.deep.equal({ width: 4, height: 4 })
        expect(surface.isConfigured).to.equal(true)
        expect(canvas.width).to.equal(4)
        expect(canvas.height).to.equal(4)
        expect(context.getConfiguration()).to.deep.equal(currentConfiguration)

        context.configure = configure
        expect(surface.getCurrentTexture()).to.equal(context.texture)
    })

    it('rejects forged Surface aliases before lifecycle or presentation effects', async() => {

        const { gpu } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const owner = runtime.createSurface(canvas, {
            format: 'rgba8unorm',
            size: { width: 4, height: 4 },
        })
        const alias = Object.assign(Object.create(owner), {
            id: 'forged-surface-alias',
            label: 'forged Surface alias',
        })

        for (const action of [
            () => alias.configure({ format: 'bgra8unorm', size: { width: 8, height: 8 } }),
            () => alias.getCurrentTexture(),
            () => alias.dispose(),
        ]) {
            try {
                action()
                throw new Error('expected forged Surface alias use to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
                    severity: 'error',
                    phase: 'runtime',
                })
                expect(error.diagnostic.subject).to.include({
                    kind: 'Surface',
                    id: 'forged-surface-alias',
                })
                expect(error.diagnostic.related).to.deep.include(owner.subject)
            }
        }

        expect(owner.isDisposed).to.equal(false)
        expect(owner.format).to.equal('rgba8unorm')
        expect(owner.size).to.deep.equal({ width: 4, height: 4 })
        expect(canvas.width).to.equal(4)
        expect(canvas.height).to.equal(4)
        expect(context.configureCalls).to.have.length(1)
        expect(context.unconfigureCalls).to.equal(0)
        expect(context.currentTextureCalls).to.equal(0)
    })

    it('releases the privately claimed context after public identity and lifecycle drift', async() => {

        const { gpu } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const drifted = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, {
            format: 'rgba8unorm',
            size: { width: 4, height: 4 },
        })

        surface.context = drifted.context
        surface.isConfigured = false
        surface.isDisposed = true

        try {
            surface.getCurrentTexture()
            throw new Error('expected public Surface identity drift to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
                severity: 'error',
                phase: 'runtime',
            })
        }

        try {
            runtime.createSurface(canvas, { format: 'bgra8unorm' })
            throw new Error('expected public lifecycle drift not to release Surface ownership')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic.code).to.equal('SCRATCH_SURFACE_CONTEXT_IN_USE')
        }

        surface.dispose()

        expect(surface.isDisposed).to.equal(true)
        expect(context.unconfigureCalls).to.equal(1)
        expect(drifted.context.unconfigureCalls).to.equal(0)
        expect(drifted.context.currentTextureCalls).to.equal(0)

        const replacement = runtime.createSurface(canvas, { format: 'bgra8unorm' })
        expect(replacement.context).to.equal(context)
    })

    it('rejects external canvas-context drift before borrowing a current texture', async() => {

        for (const drift of [ 'configure', 'unconfigure', 'canvas-size' ]) {
            const { gpu, device } = createFakeGpu()
            const { canvas, context } = createFakeCanvas()
            const runtime = await ScratchRuntime.create({ gpu })
            const surface = runtime.createSurface(canvas, {
                format: 'rgba8unorm',
                size: { width: 4, height: 4 },
            })

            if (drift === 'configure') {
                context.configure({
                    device,
                    format: 'bgra8unorm',
                    alphaMode: 'opaque',
                })
            } else if (drift === 'unconfigure') {
                context.unconfigure()
            } else {
                canvas.width = 8
            }

            try {
                surface.getCurrentTexture()
                throw new Error('expected external Surface configuration drift to fail')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
                    severity: 'error',
                    phase: 'runtime',
                })
            }

            expect(context.currentTextureCalls).to.equal(0)
        }
    })

    it('releases Surface ownership even when native unconfigure fails', async() => {

        const { gpu } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, { format: 'rgba8unorm' })
        context.unconfigure = () => {
            context.unconfigureCalls++
            throw new Error('synchronous unconfigure failure')
        }

        try {
            surface.dispose()
            throw new Error('expected Surface disposal to report unconfigure failure')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
                severity: 'error',
                phase: 'runtime',
            })
        }

        expect(surface.isDisposed).to.equal(true)
        expect(surface.isConfigured).to.equal(false)
        expect(runtime.isDisposed).to.equal(false)
        expect(context.unconfigureCalls).to.equal(1)

        const replacementRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const replacement = replacementRuntime.createSurface(canvas, { format: 'bgra8unorm' })
        expect(replacement.context).to.equal(context)
    })

    it('continues runtime cleanup after Surface unconfigure fails', async() => {

        const { gpu, device } = createFakeGpu()
        const { canvas, context } = createFakeCanvas()
        const runtime = await ScratchRuntime.create({ gpu })
        const surface = runtime.createSurface(canvas, { format: 'rgba8unorm' })
        const buffer = await runtime.createBuffer({ size: 4, usage: 0x8 })
        let bufferDestroyCalls = 0
        let deviceDestroyCalls = 0
        buffer.gpuBuffer.destroy = () => bufferDestroyCalls++
        device.destroy = () => deviceDestroyCalls++
        context.unconfigure = () => {
            context.unconfigureCalls++
            throw new Error('runtime unconfigure failure')
        }

        try {
            runtime.dispose()
            throw new Error('expected runtime disposal to report Surface failure')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic.code).to.equal('SCRATCH_SURFACE_UNCONFIGURE_FAILED')
        }

        expect(runtime.isDisposed).to.equal(true)
        expect(surface.isDisposed).to.equal(true)
        expect(buffer.isDisposed).to.equal(true)
        expect(bufferDestroyCalls).to.equal(1)
        expect(deviceDestroyCalls).to.equal(1)

        const replacementRuntime = await ScratchRuntime.create({ gpu: createFakeGpu().gpu })
        const replacement = replacementRuntime.createSurface(canvas, { format: 'bgra8unorm' })
        expect(replacement.context).to.equal(context)
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
