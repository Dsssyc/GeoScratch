import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_DST = 0x2

describe('scratch executable command lifecycle', () => {

    it('keeps construction facts and disposal immutable for every legacy command family', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const target = await runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const querySet = await runtime.createQuerySet({
            type: 'occlusion',
            count: 1,
        })
        const resolveTarget = await runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_QUERY_RESOLVE,
        })
        const texture = await runtime.createTexture({
            size: { width: 1, height: 1 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const textureUpload = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array(4),
            layout: { bytesPerRow: 4, rowsPerImage: 1 },
            size: { width: 1, height: 1 },
        })
        const commands = [
            runtime.createUploadCommand({
                target: source.region(),
                data: new Uint8Array(8),
            }),
            runtime.createCopyCommand({
                source: { region: source.region(), contentEpoch: 0 },
                target: target.region(),
                whenMissing: 'throw',
            }),
            runtime.createBeginOcclusionQueryCommand({ querySet, index: 0 }),
            runtime.createEndOcclusionQueryCommand(),
            runtime.createResolveQuerySetCommand({
                source: { querySet, slots: [ { index: 0, contentEpoch: 0 } ] },
                destination: resolveTarget.region(),
                whenMissing: 'throw',
            }),
            textureUpload,
        ]

        for (const command of commands) {
            for (const key of Object.keys(command)) {
                expect(() => {
                    command[key] = command[key]
                }, `${command.commandKind}.${key}`).to.throw(TypeError)
            }

            command.dispose()
            expect(command.isDisposed).to.equal(true)
            expect(() => { command.isDisposed = false }).to.throw(TypeError)
            expect(() => Object.defineProperty(command, 'isDisposed', { value: false })).to.throw(TypeError)
            expect(command.isDisposed).to.equal(true)

            try {
                command.assertUsable()
                throw new Error('expected disposed command to remain unusable')
            } catch (error) {
                expect(error).to.be.instanceOf(ScratchDiagnosticError)
                expect(error.diagnostic).to.include({
                    code: 'SCRATCH_COMMAND_DISPOSED',
                    severity: 'error',
                    phase: 'command',
                })
            }
        }

        expect(Object.isFrozen(textureUpload.layout)).to.equal(true)
        expect(Object.isFrozen(textureUpload.origin)).to.equal(true)
        expect(Object.isFrozen(textureUpload.size)).to.equal(true)
    })
})
