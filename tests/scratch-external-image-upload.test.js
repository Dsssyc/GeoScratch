import { expect } from 'chai'
import {
    ExternalImageUploadCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { ExternalImageUploadCommand as CompatExternalImageUploadCommand } from 'geoscratch/scratch'
import { createFakeExternalImageSource, createFakeGpu } from './scratch-test-utils.js'

const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

function externalUploadUsage() {

    return GPU_TEXTURE_USAGE_COPY_DST |
        GPU_TEXTURE_USAGE_TEXTURE_BINDING |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
}

async function createFixture(options = {}) {

    const fake = createFakeGpu()
    for (const feature of options.features ?? []) fake.device.features.add(feature)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const target = await runtime.createTexture({
        label: options.label ?? 'external upload target',
        size: options.targetSize ?? { width: 8, height: 8, depthOrArrayLayers: 2 },
        format: options.format ?? 'rgba8unorm',
        usage: options.usage ?? externalUploadUsage(),
        mipLevelCount: options.mipLevelCount ?? 2,
        sampleCount: options.sampleCount ?? 1,
    })
    const source = options.source ?? createFakeExternalImageSource('ImageData', { width: 8, height: 6 })

    return { ...fake, runtime, target, source }
}

function createCommand(fixture, descriptor = {}) {

    return fixture.runtime.createExternalImageUploadCommand({
        source: fixture.source,
        target: fixture.target,
        size: { width: 2, height: 2 },
        ...descriptor,
    })
}

function expectDiagnostic(action, code, reason) {

    let caught
    try {
        action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include({ code, severity: 'error' })
    if (code.startsWith('SCRATCH_COMMAND_')) expect(caught.diagnostic.phase).to.equal('command')
    if (reason !== undefined) expect(caught.diagnostic.actual).to.include({ reason })
    return caught
}

async function expectAsyncDiagnostic(action, code) {

    let caught
    try {
        await action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include({ code, severity: 'error' })
    return caught
}

describe('scratch external image upload', () => {

    it('exports the command from both public entrypoints and normalizes native defaults', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture, { label: 'upload current canvas' })
        const buffer = await fixture.runtime.createBuffer({
            size: 4,
            usage: 0x8,
        })
        const bufferUpload = fixture.runtime.createUploadCommand({
            target: buffer,
            data: new Uint8Array(4),
        })
        const textureUpload = fixture.runtime.createTextureUploadCommand({
            target: fixture.target,
            data: new Uint8Array(16),
            size: { width: 2, height: 2 },
        })

        expect(command).to.be.instanceOf(ExternalImageUploadCommand)
        expect(command).to.be.instanceOf(CompatExternalImageUploadCommand)
        expect(command).to.include({
            label: 'upload current canvas',
            commandKind: 'upload',
            uploadKind: 'external-image',
            source: fixture.source,
            target: fixture.target,
            flipY: false,
            mipLevel: 0,
            colorSpace: 'srgb',
            premultipliedAlpha: false,
            isDisposed: false,
        })
        expect(command.sourceOrigin).to.deep.equal({ x: 0, y: 0 })
        expect(command.origin).to.deep.equal({ x: 0, y: 0, z: 0 })
        expect(command.size).to.deep.equal({ width: 2, height: 2, depthOrArrayLayers: 1 })
        expect(bufferUpload.uploadKind).to.equal('buffer')
        expect(textureUpload.uploadKind).to.equal('texture')
    })

    it('requires a descriptor at runtime with a structured diagnostic', async() => {

        const fixture = await createFixture()

        expectDiagnostic(
            () => new ExternalImageUploadCommand(fixture.runtime),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'descriptor'
        )
    })

    it('locks command fields while retaining mutable source contents by identity', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture)

        for (const [ key, value ] of [
            [ 'runtime', null ],
            [ 'id', 'replacement' ],
            [ 'commandKind', 'copy' ],
            [ 'uploadKind', 'texture' ],
            [ 'source', { width: 2, height: 2 } ],
            [ 'sourceOrigin', { x: 1, y: 1 } ],
            [ 'flipY', true ],
            [ 'target', null ],
            [ 'origin', { x: 1, y: 1, z: 0 } ],
            [ 'mipLevel', 1 ],
            [ 'colorSpace', 'display-p3' ],
            [ 'premultipliedAlpha', true ],
            [ 'size', { width: 1, height: 1, depthOrArrayLayers: 1 } ],
        ]) {
            expect(() => {
                command[key] = value
            }).to.throw(TypeError)
        }

        expect(() => {
            command.sourceOrigin.x = 1
        }).to.throw(TypeError)
        expect(() => {
            command.origin.x = 1
        }).to.throw(TypeError)
        expect(() => {
            command.size.width = 1
        }).to.throw(TypeError)

        fixture.source.revision++
        expect(command.source).to.equal(fixture.source)
        expect(command.source.revision).to.equal(1)
    })

    it('forwards every native field and advances one target epoch after direct execution', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture, {
            sourceOrigin: [ 1, 2 ],
            flipY: true,
            origin: { x: 2, y: 1, z: 1 },
            mipLevel: 1,
            colorSpace: 'display-p3',
            premultipliedAlpha: true,
            size: [ 2, 1 ],
        })
        const allocationVersion = fixture.target.allocationVersion

        command.execute(fixture.queue)

        expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        expect(fixture.calls.queueExternalImageCopies[0]).to.deep.equal({
            source: {
                source: fixture.source,
                origin: { x: 1, y: 2 },
                flipY: true,
            },
            destination: {
                texture: fixture.target.gpuTexture,
                mipLevel: 1,
                origin: { x: 2, y: 1, z: 1 },
                aspect: 'all',
                colorSpace: 'display-p3',
                premultipliedAlpha: true,
            },
            copySize: { width: 2, height: 1, depthOrArrayLayers: 1 },
        })
        expect(fixture.calls.queueTimeline.map(action => action.type)).to.deep.equal([ 'external-image-upload' ])
        expect(fixture.target.contentEpoch).to.equal(1)
        expect(fixture.target.state).to.equal('ready')
        expect(fixture.target.allocationVersion).to.equal(allocationVersion)
    })

    it('targets the replacement allocation when submitted after resize', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture)
        const previousTexture = fixture.target.gpuTexture
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(command)

        await fixture.target.resize([ 16, 8, 2 ])
        const replacementTexture = fixture.target.gpuTexture
        const submitted = builder.submit()

        expect(replacementTexture).to.not.equal(previousTexture)
        expect(previousTexture.destroyed).to.equal(true)
        expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        expect(fixture.calls.queueExternalImageCopies[0].destination.texture)
            .to.equal(replacementTexture)
        expect(fixture.target.allocationVersion).to.equal(2)
        expect(fixture.target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses[0]).to.include({
            resourceId: fixture.target.id,
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 2,
        })

        await submitted.done
    })

    it('revalidates a shrink-invalidated target range before any queue effect', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture, {
            origin: { x: 6, y: 0, z: 0 },
            size: { width: 2, height: 2 },
        })
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(command)

        await fixture.target.resize([ 7, 8, 2 ])

        expectDiagnostic(
            () => builder.submit(),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'target-range'
        )
        expect(fixture.target.contentEpoch).to.equal(0)
        expect(fixture.target.state).to.equal('empty')
        expect(fixture.calls.queueExternalImageCopies).to.have.length(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('allows deferred source readiness and revalidates live dimensions', async() => {

        const source = createFakeExternalImageSource('HTMLImageElement', { width: 0, height: 0 })
        const fixture = await createFixture({ source })
        const command = createCommand(fixture, {
            sourceOrigin: { x: 1, y: 1 },
            size: { width: 2, height: 2 },
        })

        source.naturalWidth = 4
        source.naturalHeight = 4
        command.execute(fixture.queue)
        expect(fixture.calls.queueExternalImageCopies).to.have.length(1)

        source.naturalWidth = 2
        const failed = createCommand(fixture, {
            sourceOrigin: { x: 1, y: 1 },
            size: { width: 2, height: 2 },
        })
        expectDiagnostic(
            () => failed.execute(fixture.queue),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'source-range'
        )
        expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
    })

    it('uses the canonical dimensions for every external source kind without realm-local instanceof checks', async() => {

        for (const source of [
            createFakeExternalImageSource('ImageBitmap', { width: 3, height: 2 }),
            createFakeExternalImageSource('ImageData', { width: 3, height: 2 }),
            createFakeExternalImageSource('HTMLImageElement', { width: 3, height: 2, widthAttribute: 99 }),
            createFakeExternalImageSource('HTMLVideoElement', { width: 3, height: 2, widthAttribute: 99 }),
            createFakeExternalImageSource('VideoFrame', { width: 3, height: 2, codedWidth: 99 }),
            createFakeExternalImageSource('HTMLCanvasElement', { width: 3, height: 2 }),
            createFakeExternalImageSource('OffscreenCanvas', { width: 3, height: 2 }),
        ]) {
            const fixture = await createFixture({ source })
            createCommand(fixture, {
                sourceOrigin: [ 1, 0 ],
                size: [ 2, 2 ],
            }).execute(fixture.queue)
            expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        }
    })

    it('uses platform prototype getters as cross-realm brand checks when the constructor is available', async() => {

        const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLImageElement')
        const slots = new WeakMap()
        function TestHTMLImageElement() {}
        Object.defineProperties(TestHTMLImageElement.prototype, {
            naturalWidth: {
                get() {
                    if (!slots.has(this)) throw new TypeError('Illegal invocation')
                    return slots.get(this).width
                },
            },
            naturalHeight: {
                get() {
                    if (!slots.has(this)) throw new TypeError('Illegal invocation')
                    return slots.get(this).height
                },
            },
        })
        Object.defineProperty(globalThis, 'HTMLImageElement', {
            configurable: true,
            value: TestHTMLImageElement,
        })

        try {
            const fixture = await createFixture({
                source: createFakeExternalImageSource('ImageBitmap', { width: 3, height: 2 }),
            })
            const spoofed = {
                [Symbol.toStringTag]: 'HTMLImageElement',
                naturalWidth: 3,
                naturalHeight: 2,
            }
            expectDiagnostic(
                () => createCommand(fixture, { source: spoofed }),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                'source'
            )

            const source = Object.create(TestHTMLImageElement.prototype)
            slots.set(source, { width: 3, height: 2 })
            const validFixture = await createFixture({ source })
            createCommand(validFixture, { size: [ 3, 2 ] }).execute(validFixture.queue)
            expect(validFixture.calls.queueExternalImageCopies).to.have.length(1)
        } finally {
            if (original === undefined) {
                delete globalThis.HTMLImageElement
            } else {
                Object.defineProperty(globalThis, 'HTMLImageElement', original)
            }
        }
    })

    it('rejects a toStringTag spoof when the platform constructor is unavailable', async() => {

        const original = Object.getOwnPropertyDescriptor(globalThis, 'HTMLImageElement')
        delete globalThis.HTMLImageElement

        try {
            const fixture = await createFixture()
            const spoofed = {
                [Symbol.toStringTag]: 'HTMLImageElement',
                naturalWidth: 3,
                naturalHeight: 2,
            }

            expectDiagnostic(
                () => createCommand(fixture, { source: spoofed }),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                'source'
            )
            expect(fixture.calls.queueTimeline).to.be.empty
        } finally {
            if (original !== undefined) {
                Object.defineProperty(globalThis, 'HTMLImageElement', original)
            }
        }
    })

    it('keeps zero-area copies as native queue actions without logical content effects', async() => {

        for (const size of [
            { width: 0, height: 2 },
            { width: 2, height: 0 },
        ]) {
            const fixture = await createFixture()
            const command = createCommand(fixture, {
                sourceOrigin: size.width === 0
                    ? { x: fixture.source.width, y: 0 }
                    : { x: 0, y: fixture.source.height },
                size,
            })
            const allocationVersion = fixture.target.allocationVersion

            command.execute(fixture.queue)

            expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
            expect(fixture.target.contentEpoch).to.equal(0)
            expect(fixture.target.state).to.equal('empty')
            expect(fixture.target.allocationVersion).to.equal(allocationVersion)
        }
    })

    it('rejects invalid descriptor values and live source ranges', async() => {

        const fixture = await createFixture()
        const invalidDescriptors = [
            [ { source: null }, 'source' ],
            [ { source: { width: 8, height: 6 } }, 'source' ],
            [ { sourceOrigin: [] }, 'source-origin' ],
            [ { sourceOrigin: [ 0, 0, 0 ] }, 'source-origin' ],
            [ { sourceOrigin: { x: -1, y: 0 } }, 'source-origin' ],
            [ { sourceOrigin: { x: 0.5, y: 0 } }, 'source-origin' ],
            [ { flipY: 'yes' }, 'flipY' ],
            [ { origin: [] }, 'target-origin' ],
            [ { origin: [ 0, 0, 0, 0 ] }, 'target-origin' ],
            [ { origin: { x: -1, y: 0, z: 0 } }, 'target-origin' ],
            [ { mipLevel: -1 }, 'mip-level' ],
            [ { mipLevel: 2 }, 'mip-level' ],
            [ { colorSpace: 'linear-srgb' }, 'color-space' ],
            [ { premultipliedAlpha: 1 }, 'premultiplied-alpha' ],
            [ { size: [ 1 ] }, 'size' ],
            [ { size: [ 1, 1, 1 ] }, 'size' ],
            [ { size: { width: -1, height: 1 } }, 'size' ],
            [ { size: { width: 1.5, height: 1 } }, 'size' ],
            [ { size: { width: 0x1_0000_0000, height: 1 } }, 'size' ],
        ]

        for (const [ override, reason ] of invalidDescriptors) {
            expectDiagnostic(
                () => createCommand(fixture, override),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                reason
            )
        }

        for (const descriptor of [
            { sourceOrigin: { x: 7, y: 0 }, size: { width: 2, height: 1 } },
            { sourceOrigin: { x: 0, y: 5 }, size: { width: 1, height: 2 } },
        ]) {
            const command = createCommand(fixture, descriptor)
            expectDiagnostic(
                () => command.execute(fixture.queue),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                'source-range'
            )
        }
    })

    it('rejects target usage, shape, sample count, mip, origin, layer, and format violations', async() => {

        for (const [ options, reason ] of [
            [ { usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT }, 'target-usage' ],
            [ { usage: GPU_TEXTURE_USAGE_COPY_DST }, 'target-usage' ],
            [ {
                sampleCount: 4,
                mipLevelCount: 1,
                targetSize: { width: 8, height: 8, depthOrArrayLayers: 1 },
            }, 'target-sample-count' ],
            [ { format: 'rgba8snorm' }, 'target-format' ],
            [ { format: 'rgba8uint' }, 'target-format' ],
            [ { format: 'depth24plus' }, 'target-format' ],
            [ { format: 'rgb9e5ufloat' }, 'target-format' ],
        ]) {
            const fixture = await createFixture(options)
            expectDiagnostic(
                () => createCommand(fixture),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                reason
            )
        }

        const dimensionFixture = await createFixture()
        await expectAsyncDiagnostic(async () => await dimensionFixture.runtime.createTexture({
            size: [ 8, 8 ],
            dimension: '3d',
            format: 'rgba8unorm',
            usage: externalUploadUsage(),
        }), 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID')

        const fixture = await createFixture()
        for (const [ descriptor, reason ] of [
            [ { origin: { x: 7, y: 0, z: 0 }, size: { width: 2, height: 1 } }, 'target-range' ],
            [ { origin: { x: 0, y: 7, z: 0 }, size: { width: 1, height: 2 } }, 'target-range' ],
            [ { origin: { x: 0, y: 0, z: 2 }, size: { width: 1, height: 1 } }, 'target-range' ],
            [ { mipLevel: 1, origin: { x: 3, y: 0, z: 0 }, size: { width: 2, height: 1 } }, 'target-range' ],
        ]) {
            expectDiagnostic(
                () => createCommand(fixture, descriptor),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                reason
            )
        }
    })

    it('accepts the complete current base and feature-gated destination format set', async() => {

        const baseFormats = [
            'r8unorm',
            'rg8unorm',
            'rgba8unorm',
            'rgba8unorm-srgb',
            'bgra8unorm',
            'r16float',
            'rg16float',
            'rgba16float',
            'r32float',
            'rg32float',
            'rgba32float',
            'rgb10a2unorm',
        ]
        for (const format of baseFormats) {
            const fixture = await createFixture({ format })
            createCommand(fixture).execute(fixture.queue)
            expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        }

        for (const [ format, features ] of [
            [ 'bgra8unorm-srgb', [ 'core-features-and-limits' ] ],
            [ 'rg11b10ufloat', [ 'rg11b10ufloat-renderable' ] ],
            [ 'r16unorm', [ 'texture-formats-tier1' ] ],
            [ 'rg16unorm', [ 'texture-formats-tier1' ] ],
            [ 'rgba16unorm', [ 'texture-formats-tier1' ] ],
            [ 'rgba16unorm', [ 'texture-formats-tier2' ] ],
        ]) {
            const fixture = await createFixture({ format, features })
            createCommand(fixture).execute(fixture.queue)
            expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        }

        for (const format of [
            'bgra8unorm-srgb',
            'rg11b10ufloat',
            'r16unorm',
            'rg16unorm',
            'rgba16unorm',
        ]) {
            const fixture = await createFixture({ format })
            expectDiagnostic(
                () => createCommand(fixture),
                'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
                'target-format-feature'
            )
        }
    })

    it('revalidates target ownership and lifecycle before queue execution', async() => {

        const fixtureA = await createFixture()
        const fixtureB = await createFixture()

        expectDiagnostic(
            () => fixtureA.runtime.createExternalImageUploadCommand({
                source: fixtureA.source,
                target: fixtureB.target,
                size: [ 1, 1 ],
            }),
            'SCRATCH_RESOURCE_WRONG_RUNTIME'
        )

        const command = createCommand(fixtureA)
        fixtureA.target.dispose()
        expectDiagnostic(() => command.execute(fixtureA.queue), 'SCRATCH_RESOURCE_DISPOSED')
        expect(fixtureA.calls.queueExternalImageCopies).to.have.length(0)
    })

    it('rejects a missing native queue method before logical effects', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture)
        fixture.queue.copyExternalImageToTexture = undefined

        expectDiagnostic(
            () => command.execute(fixture.queue),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'queue-method'
        )
        expect(fixture.target.contentEpoch).to.equal(0)
    })

    it('rejects direct execution on a queue that is not owned by the command runtime', async() => {

        const fixtureA = await createFixture()
        const fixtureB = await createFixture()
        const command = createCommand(fixtureA)

        expectDiagnostic(
            () => command.execute(fixtureB.queue),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'queue-owner'
        )
        expect(fixtureA.target.contentEpoch).to.equal(0)
        expect(fixtureB.calls.queueExternalImageCopies).to.have.length(0)
    })

    it('defers context-specific canvas dimensions to the native content-timeline validation', async() => {

        const source = createFakeExternalImageSource('HTMLCanvasElement', { width: 1, height: 1 })
        const fixture = await createFixture({ source })
        const command = createCommand(fixture, { size: { width: 2, height: 2 } })

        command.execute(fixture.queue)

        expect(fixture.calls.queueExternalImageCopies).to.have.length(1)
        expect(fixture.target.contentEpoch).to.equal(1)
    })

    it('classifies native canvas source-range OperationError as deterministic invalid input', async() => {

        const source = createFakeExternalImageSource('HTMLCanvasElement', { width: 8, height: 6 })
        const fixture = await createFixture({ source })
        const command = createCommand(fixture)
        const cause = new DOMException('source range exceeds the context output bitmap', 'OperationError')
        fixture.queue.copyExternalImageToTexture = () => {
            throw cause
        }

        const error = expectDiagnostic(
            () => command.execute(fixture.queue),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID',
            'source-range-native'
        )
        expect(error.cause).to.equal(cause)
        expect(error.diagnostic.actual.nativeError).to.deep.include({ name: 'OperationError' })
        expect(fixture.target.contentEpoch).to.equal(0)
    })

    it('wraps native synchronous failures with serializable facts and the original cause', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture)
        const cause = new DOMException('source is not origin-clean', 'SecurityError')
        fixture.queue.copyExternalImageToTexture = () => {
            throw cause
        }

        const error = expectDiagnostic(
            () => command.execute(fixture.queue),
            'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED',
            'native-call'
        )
        expect(error.cause).to.equal(cause)
        expect(error.diagnostic.actual.nativeError).to.deep.equal({
            name: 'SecurityError',
            message: 'source is not origin-clean',
            code: 18,
        })
        expect(() => JSON.stringify(error.diagnostic)).not.to.throw()
        expect(fixture.target.contentEpoch).to.equal(0)
        expect(fixture.target.state).to.equal('empty')
    })

    it('keeps direct execution lifecycle coherent', async() => {

        const fixture = await createFixture()
        const command = createCommand(fixture)

        command.dispose()
        expect(command.isDisposed).to.equal(true)
        expectDiagnostic(() => command.execute(fixture.queue), 'SCRATCH_COMMAND_DISPOSED')
        expect(fixture.calls.queueExternalImageCopies).to.have.length(0)
    })
})
