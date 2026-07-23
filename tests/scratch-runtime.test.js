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
        createBufferCalls: [],
        createBuffer(descriptor) {
            this.createBufferCalls.push(descriptor)
            return {
                descriptor,
                destroyed: false,
                destroy() {
                    this.destroyed = true
                },
            }
        },
        destroy() {
            this.destroyCalled = true
        },
    }
    const adapter = {
        features: new Set([ 'timestamp-query' ]),
        limits: { maxBufferSize: 1024 },
        info: {
            vendor: 'test-vendor',
            architecture: 'test-architecture',
            device: 'test-device',
            description: 'test adapter',
            subgroupMinSize: 4,
            subgroupMaxSize: 32,
            isFallbackAdapter: false,
        },
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
            featureLevel: 'compatibility',
            powerPreference: 'high-performance',
            forceFallbackAdapter: false,
            xrCompatible: true,
            requiredFeatures: [ 'timestamp-query' ],
            requiredLimits: { maxBufferSize: 512, maxStorageBufferBindingSize: undefined },
            defaultQueue: { label: 'test queue' },
        })

        expect(runtime).to.be.instanceOf(ScratchRuntime)
        expect(gpu.requestAdapterCalls).to.deep.equal([
            {
                featureLevel: 'compatibility',
                powerPreference: 'high-performance',
                forceFallbackAdapter: false,
                xrCompatible: true,
            },
        ])
        expect(adapter.requestDeviceCalls).to.deep.equal([
            {
                label: 'test runtime',
                requiredFeatures: [ 'timestamp-query' ],
                requiredLimits: {
                    maxBufferSize: 512,
                    maxStorageBufferBindingSize: undefined,
                },
                defaultQueue: { label: 'test queue' },
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
        expect(runtime.requestFacts).to.deep.equal({
            adapter: {
                featureLevel: 'compatibility',
                powerPreference: 'high-performance',
                forceFallbackAdapter: false,
                xrCompatible: true,
            },
            device: {
                label: 'test runtime',
                requiredFeatures: [ 'timestamp-query' ],
                requiredLimits: {
                    maxBufferSize: 512,
                    maxStorageBufferBindingSize: undefined,
                },
                defaultQueue: { label: 'test queue' },
            },
        })
        expect(runtime.adapterInfo).to.deep.equal({
            available: true,
            vendor: 'test-vendor',
            architecture: 'test-architecture',
            device: 'test-device',
            description: 'test adapter',
            subgroupMinSize: 4,
            subgroupMaxSize: 32,
            isFallbackAdapter: false,
        })
        expect(Object.isFrozen(runtime.requestFacts)).to.equal(true)
        expect(Object.isFrozen(runtime.requestFacts.adapter)).to.equal(true)
        expect(Object.isFrozen(runtime.requestFacts.device.requiredFeatures)).to.equal(true)
        expect(Object.isFrozen(runtime.requestFacts.device.requiredLimits)).to.equal(true)
        expect(Object.isFrozen(runtime.requestFacts.device.defaultQueue)).to.equal(true)
        expect(Object.isFrozen(runtime.adapterInfo)).to.equal(true)
        expect(JSON.parse(JSON.stringify(runtime.adapterInfo))).to.deep.equal(runtime.adapterInfo)
        expect(runtime.isDisposed).to.equal(false)
        expect(runtime.isDeviceLost).to.equal(false)
    })

    it('defaults to core and snapshots request descriptors before asynchronous adapter work', async() => {

        const { gpu, adapter } = createFakeGpu()
        let resolveAdapter
        gpu.requestAdapter = function(options) {
            this.requestAdapterCalls.push(options)
            return new Promise(resolve => {
                resolveAdapter = () => resolve(adapter)
            })
        }
        const requiredFeatures = [ 'timestamp-query' ]
        const requiredLimits = { maxBufferSize: 512 }
        const defaultQueue = { label: 'initial queue' }
        const creation = ScratchRuntime.create({
            gpu,
            requiredFeatures,
            requiredLimits,
            defaultQueue,
        })

        requiredFeatures[0] = 'shader-f16'
        requiredLimits.maxBufferSize = 2048
        defaultQueue.label = 'mutated queue'
        resolveAdapter()
        const runtime = await creation

        expect(gpu.requestAdapterCalls).to.deep.equal([ { featureLevel: 'core' } ])
        expect(adapter.requestDeviceCalls).to.deep.equal([ {
            requiredFeatures: [ 'timestamp-query' ],
            requiredLimits: { maxBufferSize: 512 },
            defaultQueue: { label: 'initial queue' },
        } ])
        expect(runtime.requestFacts.adapter.featureLevel).to.equal('core')
        expect(runtime.requestFacts.device).to.deep.equal({
            requiredFeatures: [ 'timestamp-query' ],
            requiredLimits: { maxBufferSize: 512 },
            defaultQueue: { label: 'initial queue' },
        })
    })

    it('represents absent or partial adapter info without serializing the native adapter', async() => {

        const { gpu, adapter } = createFakeGpu()
        adapter.info = {
            vendor: 'partial-vendor',
            architecture: '',
        }
        const runtime = await ScratchRuntime.create({ gpu })

        expect(runtime.adapterInfo).to.deep.equal({
            available: true,
            vendor: 'partial-vendor',
            architecture: '',
        })
        expect(JSON.stringify(runtime.adapterInfo)).not.to.include('requestDevice')

        delete adapter.info
        const withoutInfo = await ScratchRuntime.create({ gpu })
        expect(withoutInfo.adapterInfo).to.deep.equal({ available: false })
    })

    it('rejects invalid feature levels before requesting an adapter', async() => {

        const { gpu } = createFakeGpu()
        let caught

        try {
            await ScratchRuntime.create({ gpu, featureLevel: 'maximum' })
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic).to.include({
            code: 'SCRATCH_RUNTIME_REQUEST_INVALID',
            severity: 'error',
            phase: 'runtime',
        })
        expect(caught.diagnostic.actual).to.deep.include({
            field: 'featureLevel',
            value: 'maximum',
        })
        expect(gpu.requestAdapterCalls).to.have.length(0)
    })

    for (const testCase of [
        {
            name: 'runtime label',
            options: { label: 42 },
            field: 'label',
        },
        {
            name: 'power preference',
            options: { powerPreference: 'maximum-performance' },
            field: 'powerPreference',
        },
        {
            name: 'fallback flag',
            options: { forceFallbackAdapter: 1 },
            field: 'forceFallbackAdapter',
        },
        {
            name: 'XR flag',
            options: { xrCompatible: 'yes' },
            field: 'xrCompatible',
        },
        {
            name: 'required feature entry',
            options: { requiredFeatures: [ 'timestamp-query', 7 ] },
            field: 'requiredFeatures',
        },
        {
            name: 'required limit value',
            options: { requiredLimits: { maxBufferSize: -1 } },
            field: 'requiredLimits.maxBufferSize',
        },
        {
            name: 'required limit precision',
            options: { requiredLimits: { maxBufferSize: Number.MAX_SAFE_INTEGER + 1 } },
            field: 'requiredLimits.maxBufferSize',
        },
        {
            name: 'default queue label',
            options: { defaultQueue: { label: 8 } },
            field: 'defaultQueue.label',
        },
    ]) {
        it(`rejects invalid ${testCase.name} before requesting an adapter`, async() => {

            const { gpu } = createFakeGpu()
            let caught

            try {
                await ScratchRuntime.create({ gpu, ...testCase.options })
            } catch (error) {
                caught = error
            }

            expect(caught).to.be.instanceOf(ScratchDiagnosticError)
            expect(caught.diagnostic).to.include({
                code: 'SCRATCH_RUNTIME_REQUEST_INVALID',
                severity: 'error',
                phase: 'runtime',
            })
            expect(caught.diagnostic.actual.field).to.equal(testCase.field)
            expect(gpu.requestAdapterCalls).to.have.length(0)
        })
    }

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
            message: '[native device-loss message omitted]',
            nativeMessageOmitted: true,
        })
    })

    it('keeps disposed lifecycle authority after public assertActive shadowing', async() => {

        const { gpu, device } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        Object.defineProperty(runtime, 'assertActive', {
            configurable: true,
            value() {},
        })
        runtime.dispose()
        let caught

        try {
            await runtime.createBuffer({ size: 4, usage: 1 })
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(device.createBufferCalls).to.have.length(0)
    })

    it('keeps device-loss lifecycle authority after public assertActive shadowing', async() => {

        let loseDevice
        const { gpu, device } = createFakeGpu()
        device.lost = new Promise((resolve) => {
            loseDevice = resolve
        })
        const runtime = await ScratchRuntime.create({ gpu })
        Object.defineProperty(runtime, 'assertActive', {
            configurable: true,
            value() {},
        })

        loseDevice({ reason: 'unknown', message: 'test loss' })
        await Promise.resolve()
        let caught

        try {
            await runtime.createBuffer({ size: 4, usage: 1 })
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST')
        expect(device.createBufferCalls).to.have.length(0)
    })

    it('keeps downstream runtime authority after public assertActive shadowing', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const submission = runtime.createSubmission()
        Object.defineProperty(runtime, 'assertActive', {
            configurable: true,
            value() {},
        })
        runtime.dispose()
        let caught

        try {
            submission.submit()
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
    })
})
