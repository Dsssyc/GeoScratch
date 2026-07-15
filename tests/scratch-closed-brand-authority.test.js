import fs from 'node:fs'
import { expect } from 'chai'
import {
    SamplerResource,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1

describe('scratch closed brand authority', () => {

    it('rejects a forged sampler after constructor Symbol.hasInstance replacement', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const nativeOwner = await runtime.createSampler()
        const layout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'sampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            } ],
        })
        const forged = {
            id: 'forged-sampler',
            descriptor: nativeOwner.descriptor,
            subject: { kind: 'Resource', id: 'forged-sampler', resourceKind: 'SamplerResource' },
            allocationVersion: 1,
            isDisposed: false,
            gpuSampler: nativeOwner.gpuSampler,
            assertRuntime(candidate) {
                if (candidate !== runtime) throw new Error('wrong runtime')
            },
        }
        const original = Object.getOwnPropertyDescriptor(SamplerResource, Symbol.hasInstance)
        const nativeHasInstance = Function.prototype[Symbol.hasInstance]
        let caught
        let prototypeCaught

        try {
            Object.defineProperty(SamplerResource, Symbol.hasInstance, {
                configurable: true,
                value: candidate => candidate === forged || nativeHasInstance.call(SamplerResource, candidate),
            })
            expect(forged).to.be.instanceOf(SamplerResource)
            try {
                await runtime.createBindSet(layout, { sampler: forged })
            } catch (error) {
                caught = error
            }
            const prototypeForged = Object.create(SamplerResource.prototype)
            expect(prototypeForged).to.be.instanceOf(SamplerResource)
            try {
                await runtime.createBindSet(layout, { sampler: prototypeForged })
            } catch (error) {
                prototypeCaught = error
            }
        } finally {
            restoreHasInstance(SamplerResource, original)
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_BIND_RESOURCE_TYPE_MISMATCH')
        expect(prototypeCaught).to.be.instanceOf(ScratchDiagnosticError)
        expect(prototypeCaught.diagnostic.code).to.equal('SCRATCH_BIND_RESOURCE_TYPE_MISMATCH')
        expect(fake.calls.bindGroups).to.have.length(0)
    })

    it('rejects a forged texture before native copy encoding after constructor replacement', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const nativeOwner = await runtime.createTexture({
            size: [ 1, 1 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC,
        })
        const target = await runtime.createBuffer({
            size: 256,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const forged = {
            id: 'forged-texture',
            subject: { kind: 'Resource', id: 'forged-texture', resourceKind: 'TextureResource' },
            descriptor: nativeOwner.descriptor,
            allocationVersion: 1,
            contentEpoch: 0,
            state: 'ready',
            isReady: true,
            isDisposed: false,
            usage: nativeOwner.usage,
            format: nativeOwner.format,
            dimension: nativeOwner.dimension,
            mipLevelCount: nativeOwner.mipLevelCount,
            sampleCount: nativeOwner.sampleCount,
            size: nativeOwner.size,
            width: nativeOwner.width,
            height: nativeOwner.height,
            depthOrArrayLayers: nativeOwner.depthOrArrayLayers,
            gpuTexture: nativeOwner.gpuTexture,
            assertRuntime(candidate) {
                if (candidate !== runtime) throw new Error('wrong runtime')
            },
            assertUsable() {},
        }
        const original = Object.getOwnPropertyDescriptor(TextureResource, Symbol.hasInstance)
        const nativeHasInstance = Function.prototype[Symbol.hasInstance]
        let caught

        try {
            Object.defineProperty(TextureResource, Symbol.hasInstance, {
                configurable: true,
                value: candidate => candidate === forged || nativeHasInstance.call(TextureResource, candidate),
            })
            expect(forged).to.be.instanceOf(TextureResource)
            try {
                const command = runtime.createCopyCommand({
                    source: { resource: forged, contentEpoch: 0 },
                    target: target.region(),
                    targetLayout: { bytesPerRow: 256, rowsPerImage: 1 },
                    size: { width: 1, height: 1 },
                    whenMissing: 'throw',
                })
                command.encode(runtime.device.createCommandEncoder())
            } catch (error) {
                caught = error
            }
        } finally {
            restoreHasInstance(TextureResource, original)
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_COMMAND_COPY_SOURCE_INVALID')
        expect(fake.calls.textureBufferCopies).to.have.length(0)
    })

    it('does not use open instanceof checks as Scratch-owned internal brands', () => {

        const scratchRoot = new URL('../packages/geoscratch/src/scratch/', import.meta.url)
        const ownedAuthorities = new Set([
            'BufferResource',
            'DispatchCommand',
            'DrawCommand',
            'LayoutCodec',
            'Program',
            'QuerySetResource',
            'SamplerResource',
            'ScratchDiagnosticError',
            'TextureResource',
        ])
        const sites = []

        for (const entry of fs.readdirSync(scratchRoot, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
            const source = fs.readFileSync(new URL(entry.name, scratchRoot), 'utf8')
            for (const match of source.matchAll(/\binstanceof\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
                if (!ownedAuthorities.has(match[1])) continue
                const line = source.slice(0, match.index).split('\n').length
                sites.push(`packages/geoscratch/src/scratch/${entry.name}:${line}:${match[1]}`)
            }
        }

        expect(sites).to.deep.equal([])
    })
})

function restoreHasInstance(Constructor, descriptor) {

    if (descriptor === undefined) delete Constructor[Symbol.hasInstance]
    else Object.defineProperty(Constructor, Symbol.hasInstance, descriptor)
}
