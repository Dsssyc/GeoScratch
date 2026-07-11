import { expect } from 'chai'
import {
    BufferResource,
    Resource,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import { replaceResourceAllocationForTest } from './scratch-test-utils.js'

function createFakeGpu() {

    const buffers = []
    const textures = []
    const device = {
        features: new Set(),
        limits: {},
        queue: {},
        lost: new Promise(() => {}),
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
        const resource = new Resource(runtime, {
            label: 'logical resource',
            resourceKind: 'TestResource',
            descriptor: { role: 'test' },
        })

        expect(resource.runtime).to.equal(runtime)
        expect(resource.id).to.be.a('string').and.not.equal('')
        expect(resource.label).to.equal('logical resource')
        expect(resource.resourceKind).to.equal('TestResource')
        expect(resource.descriptor).to.deep.equal({ role: 'test' })
        expect(resource.isDisposed).to.equal(false)
        expect(resource.state).to.equal('empty')
        expect(resource.isReady).to.equal(false)
        expect(resource.allocationVersion).to.equal(1)
        expect(resource.contentEpoch).to.equal(0)

        resource.dispose()

        expect(resource.isDisposed).to.equal(true)
        expect(resource.state).to.equal('disposed')
        expect(resource.isReady).to.equal(false)
        expect(() => resource.assertUsable()).to.throw(ScratchDiagnosticError)
    })

    it('enforces resource ownership across runtimes with structured diagnostics', async() => {

        const runtimeA = await ScratchRuntime.create({ gpu: createFakeGpu().gpu, label: 'runtime A' })
        const runtimeB = await ScratchRuntime.create({ gpu: createFakeGpu().gpu, label: 'runtime B' })
        const resource = new Resource(runtimeA, {
            label: 'owned resource',
            resourceKind: 'TestResource',
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
                resourceKind: 'TestResource',
            })
            expect(error.diagnostic.expected).to.deep.equal({ runtimeId: runtimeA.id })
            expect(error.diagnostic.actual).to.deep.equal({ runtimeId: runtimeB.id })
        }
    })

    it('creates minimal BufferResource objects without implicit transfer helpers', async() => {

        const { gpu, buffers } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        const buffer = runtime.createBuffer({
            label: 'positions',
            size: 64,
            usage: 1,
            mappedAtCreation: false,
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
            mappedAtCreation: false,
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
        expect(buffer.state).to.equal('disposed')
        expect(buffers[0].destroyed).to.equal(true)
        expect(() => buffer.assertUsable()).to.throw(ScratchDiagnosticError)
    })

    it('tracks readiness separately from allocation and disposal', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const buffer = runtime.createBuffer({
            label: 'readiness buffer',
            size: 64,
            usage: 1,
        })
        const texture = runtime.createTexture({
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

        buffer._advanceContentEpoch()
        texture._advanceContentEpoch()

        expect(buffer.contentEpoch).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('ready')
        expect(texture.state).to.equal('ready')
        expect(buffer.isReady).to.equal(true)
        expect(texture.isReady).to.equal(true)

        const bufferAllocationVersion = buffer.allocationVersion
        const textureAllocationVersion = texture.allocationVersion

        replaceResourceAllocationForTest(buffer)
        replaceResourceAllocationForTest(texture)

        expect(buffer.allocationVersion).to.equal(bufferAllocationVersion + 1)
        expect(texture.allocationVersion).to.equal(textureAllocationVersion + 1)
        expect(buffer.contentEpoch).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('empty')
        expect(texture.state).to.equal('empty')
        expect(buffer.isReady).to.equal(false)
        expect(texture.isReady).to.equal(false)
    })
})
