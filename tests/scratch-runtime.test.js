import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'

function createFakeGpu() {

    const device = {
        features: new Set([ 'timestamp-query' ]),
        limits: { maxBufferSize: 1024 },
        queue: { label: 'queue' },
        lost: new Promise(() => {}),
        destroyCalled: false,
        createBuffer: (descriptor) => ({
            descriptor,
            destroyed: false,
            destroy() {
                this.destroyed = true
            },
        }),
        destroy() {
            this.destroyCalled = true
        },
    }
    const adapter = {
        features: new Set([ 'timestamp-query' ]),
        limits: { maxBufferSize: 1024 },
        requestDeviceCalls: [],
        async requestDevice(descriptor) {
            this.requestDeviceCalls.push(descriptor)
            return device
        },
    }
    const gpu = {
        requestAdapterCalls: [],
        async requestAdapter(options) {
            this.requestAdapterCalls.push(options)
            return adapter
        },
        getPreferredCanvasFormat() {
            return 'bgra8unorm'
        },
    }

    return { gpu, adapter, device }
}

describe('ScratchRuntime', () => {

    it('is created explicitly and asynchronously without a canvas', async() => {

        const { gpu, adapter, device } = createFakeGpu()

        const runtime = await ScratchRuntime.create({
            gpu,
            label: 'test runtime',
            powerPreference: 'high-performance',
            requiredFeatures: [ 'timestamp-query' ],
            requiredLimits: { maxBufferSize: 512 },
        })

        expect(runtime).to.be.instanceOf(ScratchRuntime)
        expect(gpu.requestAdapterCalls).to.deep.equal([
            { powerPreference: 'high-performance' },
        ])
        expect(adapter.requestDeviceCalls).to.deep.equal([
            {
                label: 'test runtime',
                requiredFeatures: [ 'timestamp-query' ],
                requiredLimits: { maxBufferSize: 512 },
            },
        ])
        expect(runtime.label).to.equal('test runtime')
        expect(runtime.adapter).to.equal(adapter)
        expect(runtime.device).to.equal(device)
        expect(runtime.queue).to.equal(device.queue)
        expect(runtime.adapterFeatures).to.equal(adapter.features)
        expect(runtime.adapterLimits).to.equal(adapter.limits)
        expect(runtime.deviceFeatures).to.equal(device.features)
        expect(runtime.deviceLimits).to.equal(device.limits)
        expect(runtime.isDisposed).to.equal(false)
        expect(runtime.isDeviceLost).to.equal(false)
    })

    it('rejects creation failures with structured diagnostics', async() => {

        try {
            await ScratchRuntime.create({ gpu: undefined })
            throw new Error('expected ScratchRuntime.create to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                version: 1,
                code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
                severity: 'error',
                phase: 'runtime',
            })
            expect(error.diagnostic.subject).to.deep.equal({ kind: 'ScratchRuntime' })
        }
    })

    it('tracks disposal and rejects dependent operations after disposal', async() => {

        const { gpu, device } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        runtime.dispose()

        expect(runtime.isDisposed).to.equal(true)
        expect(device.destroyCalled).to.equal(true)

        try {
            await runtime.createBuffer({ size: 4, usage: 1 })
        } catch (error) {
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RUNTIME_DISPOSED',
                severity: 'error',
                phase: 'runtime',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'ScratchRuntime',
                id: runtime.id,
            })
        }
    })

    it('tracks device lost state without recreating a global device', async() => {

        let loseDevice
        const { gpu, device } = createFakeGpu()
        device.lost = new Promise((resolve) => {
            loseDevice = resolve
        })
        const runtime = await ScratchRuntime.create({ gpu })

        loseDevice({ reason: 'unknown', message: 'test loss' })
        await Promise.resolve()

        expect(runtime.isDeviceLost).to.equal(true)
        expect(runtime.deviceLostInfo).to.deep.equal({
            reason: 'unknown',
            message: 'test loss',
        })
    })
})
