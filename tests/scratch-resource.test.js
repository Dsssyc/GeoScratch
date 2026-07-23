import { expect } from 'chai'
import {
    BufferResource,
    Resource,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    replaceResourceAllocationForTest,
} from './scratch-test-utils.js'

function createFakeGpu() {

    const buffers = []
    const textures = []
    const errorScopes = []
    const device = {
        features: new Set(),
        limits: {},
        queue: {},
        lost: new Promise(() => {}),
        pushErrorScope(filter) {
            errorScopes.push({ filter, error: null })
        },
        popErrorScope() {
            const scope = errorScopes.pop()
            return scope === undefined
                ? Promise.reject(new Error('No fake error scope is open.'))
                : Promise.resolve(scope.error)
        },
        createBuffer(descriptor) {
            const buffer = {
                descriptor,
                destroyed: false,
                destroy() {
                    this.destroyed = true
                },
            }
            buffers.push(buffer)
            return buffer
        },
        createTexture(descriptor) {
            const texture = {
                descriptor,
                views: [],
                destroyed: false,
                createView(viewDescriptor = {}) {
                    const view = {
                        texture: this,
                        descriptor: viewDescriptor,
                    }
                    this.views.push(view)
                    return view
                },
                destroy() {
                    this.destroyed = true
                },
            }
            textures.push(texture)
            return texture
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
    }

    return { gpu, buffers, textures }
}

describe('scratch resources', () => {

    it('tracks logical resource identity and lifecycle state', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu, label: 'resource runtime' })
        expect(() => new Resource(runtime)).to.throw(TypeError, 'abstract')
        expect(Object.getOwnPropertyDescriptor(Resource.prototype, 'state')).to.equal(undefined)
        expect(Object.getOwnPropertyDescriptor(Resource.prototype, 'contentEpoch')).to.equal(undefined)
        expect(Object.getOwnPropertyDescriptor(Resource.prototype, 'isReady')).to.equal(undefined)

        const resource = await runtime.createBuffer({
            label: 'logical resource',
            size: 16,
            usage: 1,
        })

        expect(resource.runtime).to.equal(runtime)
        expect(resource.id).to.be.a('string').and.not.equal('')
        expect(resource.label).to.equal('logical resource')
        expect(resource.resourceKind).to.equal('BufferResource')
        expect(resource.descriptor).to.deep.equal({
            label: 'logical resource',
            size: 16,
            usage: 1,
        })
        expect(resource.isDisposed).to.equal(false)
        expect(resource.allocationVersion).to.equal(1)

        resource.dispose()

        expect(resource.isDisposed).to.equal(true)
        expect(() => resource.assertUsable()).to.throw(ScratchDiagnosticError)
    })

    it('enforces resource ownership across runtimes with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu, label: 'runtime A' })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu, label: 'runtime B' })
        const resource = await runtimeA.createBuffer({
            label: 'owned resource',
            size: 16,
            usage: 1,
        })

        try {
            resource.assertRuntime(runtimeB)
            throw new Error('expected resource ownership validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'resource',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'Resource',
                id: resource.id,
                label: 'owned resource',
                resourceKind: 'BufferResource',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: runtimeA.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: runtimeB.id })
        }
    })

    it('creates minimal BufferResource objects without implicit transfer helpers', async() => {

        const { gpu, buffers } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        const buffer = await runtime.createBuffer({
            label: 'positions',
            size: 64,
            usage: 1,
        })

        expect(buffer).to.be.instanceOf(BufferResource)
        expect(buffer.runtime).to.equal(runtime)
        expect(buffer.gpuBuffer).to.equal(buffers[0])
        expect(buffer.size).to.equal(64)
        expect(buffer.usage).to.equal(1)
        expect(buffer.descriptor).to.deep.equal({
            label: 'positions',
            size: 64,
            usage: 1,
        })
        expect(buffer.allocationVersion).to.equal(1)
        expect(buffer.contentEpoch).to.equal(0)
        expect(buffer.state).to.equal('empty')
        expect(buffer.isReady).to.equal(false)
        expect(buffer.write).to.equal(undefined)
        expect(buffer.toArray).to.equal(undefined)
        expect(buffer.toBytes).to.equal(undefined)

        buffer.dispose()

        expect(buffer.isDisposed).to.equal(true)
        expect(buffer.state).to.equal('empty')
        expect(buffer.isReady).to.equal(false)
        expect(buffers[0].destroyed).to.equal(true)
        expect(() => buffer.assertUsable()).to.throw(ScratchDiagnosticError)
    })

    it('tracks readiness separately from allocation and disposal', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const buffer = await runtime.createBuffer({
            label: 'readiness buffer',
            size: 64,
            usage: 1,
        })
        const texture = await runtime.createTexture({
            label: 'readiness texture',
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: 4,
        })

        expect(buffer).to.be.instanceOf(BufferResource)
        expect(texture).to.be.instanceOf(TextureResource)
        expect(buffer.state).to.equal('empty')
        expect(texture.state).to.equal('empty')
        expect(buffer.isReady).to.equal(false)
        expect(texture.isReady).to.equal(false)

        advanceResourceContentEpochForTest(buffer)
        advanceResourceContentEpochForTest(texture)

        expect(buffer.contentEpoch).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('ready')
        expect(texture.state).to.equal('ready')
        expect(buffer.isReady).to.equal(true)
        expect(texture.isReady).to.equal(true)

        const bufferAllocationVersion = buffer.allocationVersion
        const textureAllocationVersion = texture.allocationVersion
        const originalGpuBuffer = buffer.gpuBuffer

        const replacementGpuBuffer = replaceResourceAllocationForTest(buffer, {
            ...buffer.descriptor,
            size: 32,
            usage: 2,
        })
        replaceResourceAllocationForTest(texture)

        expect(buffer.allocationVersion).to.equal(bufferAllocationVersion + 1)
        expect(texture.allocationVersion).to.equal(textureAllocationVersion + 1)
        expect(buffer.contentEpoch).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('empty')
        expect(texture.state).to.equal('empty')
        expect(buffer.isReady).to.equal(false)
        expect(texture.isReady).to.equal(false)
        expect(buffer.gpuBuffer).to.equal(replacementGpuBuffer)
        expect(replacementGpuBuffer).not.to.equal(originalGpuBuffer)
        expect(originalGpuBuffer.destroyed).to.equal(true)
        expect(buffer.size).to.equal(32)
        expect(buffer.usage).to.equal(2)
        expect(buffer.descriptor).to.deep.equal({
            label: 'readiness buffer',
            size: 32,
            usage: 2,
        })
    })

    it('rejects noncanonical raw resource descriptor integers before native issue', async() => {

        const { gpu, buffers, textures } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        for (const descriptor of [
            { size: 4.5, usage: 1 },
            { size: Number.MAX_SAFE_INTEGER + 1, usage: 1 },
            { size: 16, usage: 1.5 },
            { size: 16, usage: 0x1_0000_0000 },
        ]) {
            await expectResourceDiagnostic(runtime.createBuffer(descriptor))
        }
        for (const descriptor of [
            { size: { width: 2, height: 2 }, usage: 4.5 },
            { size: { width: 2, height: 2 }, usage: 0x1_0000_0000 },
            { size: { width: Number.MAX_SAFE_INTEGER, height: 2 }, usage: 4 },
        ]) {
            await expectResourceDiagnostic(runtime.createTexture({
                format: 'rgba8unorm',
                ...descriptor,
            }))
        }

        expect(buffers).to.have.length(0)
        expect(textures).to.have.length(0)
    })
})

async function expectResourceDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({
            code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'resource',
        })
        return
    }
    throw new Error('expected invalid resource descriptor to fail')
}
