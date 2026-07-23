import { expect } from 'chai'
import {
    BeginOcclusionQueryCommand,
    ClearBufferCommand,
    CopyCommand,
    DispatchCommand,
    DrawCommand,
    EndOcclusionQueryCommand,
    ExternalImageUploadCommand,
    ReadbackCommand,
    ResolveQuerySetCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureUploadCommand,
    UploadCommand,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_DST = 0x2

describe('scratch executable command lifecycle', () => {

    it('keeps construction facts and disposal immutable for every command family', async() => {

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
            runtime.createClearBufferCommand({
                target: target.region({ offset: 0, size: 4 }),
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

    it('shadows absent normalized facts against inherited command mutation', async() => {

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
        const upload = runtime.createUploadCommand({
            target: source.region(),
            data: new Uint8Array(8),
        })
        const copy = runtime.createCopyCommand({
            source: { region: source.region(), contentEpoch: 0 },
            target: target.region(),
            whenMissing: 'throw',
        })

        for (const [ command, properties ] of [
            [ upload, [ 'label', 'layout' ] ],
            [ copy, [
                'label', 'sourceLayout', 'targetLayout', 'sourceOrigin', 'targetOrigin',
                'sourceMipLevel', 'targetMipLevel', 'sourceAspect', 'targetAspect', 'size',
            ] ],
        ]) {
            const prototype = Object.getPrototypeOf(command)
            for (const property of properties) {
                expect(Object.hasOwn(command, property), `${command.commandKind}.${property}`).to.equal(true)
                const ownDescriptor = Object.getOwnPropertyDescriptor(command, property)
                expect(ownDescriptor, `${command.commandKind}.${property}`).to.include({
                    configurable: false,
                    writable: false,
                    value: undefined,
                })

                const inheritedDescriptor = Object.getOwnPropertyDescriptor(prototype, property)
                let replaced = false
                try {
                    try {
                        Object.defineProperty(prototype, property, {
                            configurable: true,
                            value: { injected: property },
                        })
                        replaced = true
                    } catch (error) {
                        expect(error).to.be.instanceOf(TypeError)
                    }
                    expect(replaced, `${command.commandKind}.${property}`).to.equal(false)
                    expect(command[property], `${command.commandKind}.${property}`).to.equal(undefined)
                } finally {
                    if (replaced) {
                        if (inheritedDescriptor === undefined) delete prototype[property]
                        else Object.defineProperty(prototype, property, inheritedDescriptor)
                    }
                }
            }
        }
    })

    it('locks Draw and Dispatch label facts as immutable own properties', async() => {

        const commands = await createDrawDispatchCommands()

        for (const [ command, expected ] of [
            [ commands.labeledDraw, 'labeled draw' ],
            [ commands.unlabeledDraw, undefined ],
            [ commands.labeledDispatch, 'labeled dispatch' ],
            [ commands.unlabeledDispatch, undefined ],
        ]) {
            expect(Object.hasOwn(command, 'label'), command.commandKind).to.equal(true)
            expect(Object.getOwnPropertyDescriptor(command, 'label'), command.commandKind).to.include({
                value: expected,
                writable: false,
                configurable: false,
                enumerable: expected !== undefined,
            })
            expect(() => { command.label = 'replacement' }).to.throw(TypeError)
            expect(command.label).to.equal(expected)
        }
    })

    it('freezes every executable command prototype authority', () => {

        for (const Command of [
            DrawCommand,
            DispatchCommand,
            UploadCommand,
            ClearBufferCommand,
            CopyCommand,
            BeginOcclusionQueryCommand,
            EndOcclusionQueryCommand,
            ResolveQuerySetCommand,
            TextureUploadCommand,
            ExternalImageUploadCommand,
            ReadbackCommand,
        ]) {
            expect(Object.isFrozen(Command.prototype), Command.name).to.equal(true)
        }
    })
})

async function createDrawDispatchCommands() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const renderProgram = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
    const renderPipeline = await runtime.createRenderPipeline({
        program: renderProgram,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const computeProgram = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    const computePipeline = await runtime.createComputePipeline({
        program: computeProgram,
        compute: 'csMain',
    })
    const draw = label => runtime.createDrawCommand({
        ...(label !== undefined ? { label } : {}),
        pipeline: renderPipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })
    const dispatch = label => runtime.createDispatchCommand({
        ...(label !== undefined ? { label } : {}),
        pipeline: computePipeline,
        count: { workgroups: [ 1, 1, 1 ] },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })

    return {
        labeledDraw: draw('labeled draw'),
        unlabeledDraw: draw(),
        labeledDispatch: dispatch('labeled dispatch'),
        unlabeledDispatch: dispatch(),
    }
}
