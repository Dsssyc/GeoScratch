import { createTestProgram } from './scratch-test-utils.js'
import fs from 'node:fs'
import { expect } from 'chai'
import {
    BindLayout,
    BindSet,
    ComputePassSpec,
    ComputePipeline,
    DispatchCommand,
    Program,
    SamplerResource,
    ScratchDiagnosticError,
    ScratchRuntime,
    TextureResource,
    inspectShader,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

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

    it('rejects prototype-derived BindLayout identities before native binding creation', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const owner = await runtime.createBindLayout({ group: 0, entries: [] })
        const lookalike = prototypeLookalike(BindLayout, {
            runtime,
            id: 'lookalike-bind-layout',
            group: 0,
            entries: Object.freeze([]),
            gpuBindGroupLayout: owner.gpuBindGroupLayout,
            isDisposed: false,
            subject: { kind: 'BindLayout', id: 'lookalike-bind-layout' },
            assertRuntime() {},
            assertUsable() {},
            entrySubject() { return { kind: 'BindLayoutEntry', group: 0, binding: 0 } },
        })
        let creationError
        let inspectionError

        try {
            await runtime.createBindSet(lookalike, {})
        } catch (error) {
            creationError = error
        }
        try {
            inspectShader('').compareBindLayouts([ lookalike ])
        } catch (error) {
            inspectionError = error
        }

        expect(creationError).to.be.instanceOf(ScratchDiagnosticError)
        expect(creationError.diagnostic.code).to.equal('SCRATCH_BIND_REQUIRED_ENTRY_MISSING')
        expect(inspectionError).to.be.instanceOf(ScratchDiagnosticError)
        expect(inspectionError.diagnostic.code).to.equal('SCRATCH_BIND_LAYOUT_DESCRIPTOR_INVALID')
        expect(fake.calls.bindGroups).to.have.length(0)
    })

    it('rejects prototype-derived Program identities before native pipeline creation', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const lookalike = prototypeLookalike(Program, {
            runtime,
            id: 'lookalike-program',
            compute: Object.freeze({
                module: Object.freeze({ id: 'lookalike-shader-module' }),
                entryPoint: 'csMain',
            }),
            requiredFeatures: Object.freeze([]),
            requiredLimits: Object.freeze({}),
            requiredLanguageFeatures: Object.freeze([]),
            layoutRequirements: Object.freeze([]),
            sourcePartDependencies: Object.freeze([]),
            isDisposed: false,
            subject: { kind: 'Program', id: 'lookalike-program' },
            assertRuntime() {},
            assertUsable() {},
        })
        let pipelineError
        let inspectionError

        try {
            await runtime.createComputePipeline({ program: lookalike })
        } catch (error) {
            pipelineError = error
        }
        try {
            inspectShader('', { program: lookalike })
        } catch (error) {
            inspectionError = error
        }

        expect(pipelineError).to.be.instanceOf(ScratchDiagnosticError)
        expect(pipelineError.diagnostic.code).to.equal('SCRATCH_PIPELINE_PROGRAM_INVALID')
        expect(inspectionError).to.be.instanceOf(ScratchDiagnosticError)
        expect(inspectionError.diagnostic.code).to.equal(
            'SCRATCH_SHADER_INSPECTION_INPUT_INVALID'
        )
        expect(fake.calls.shaderModules).to.have.length(0)
        expect(fake.calls.pipelineLayouts).to.have.length(0)
        expect(fake.calls.computePipelines).to.have.length(0)
    })

    it('keeps Program identity and runtime ownership authoritative after public mutation attempts', async() => {

        const fakeA = createFakeGpu()
        const fakeB = createFakeGpu()
        const runtimeA = await ScratchRuntime.create({ gpu: fakeA.gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: fakeB.gpu })
        const program = await createTestProgram(runtimeA, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        const originalId = program.id
        const idMutationAccepted = Reflect.set(program, 'id', 'changed-program-id')
        const mutationAccepted = Reflect.set(program, 'runtime', runtimeB)
        let caught

        try {
            await runtimeB.createComputePipeline({ program })
        } catch (error) {
            caught = error
        }

        expect(fakeB.calls.shaderModules).to.have.length(0)
        expect(fakeB.calls.pipelineLayouts).to.have.length(0)
        expect(fakeB.calls.computePipelines).to.have.length(0)
        expect(idMutationAccepted).to.equal(false)
        expect(program.id).to.equal(originalId)
        expect(mutationAccepted).to.equal(false)
        expect(program.runtime).to.equal(runtimeA)
        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_PROGRAM_WRONG_RUNTIME')
    })

    it('keeps Program disposal authoritative after public mutation attempts', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const program = await createTestProgram(runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        program.dispose()
        const mutationAccepted = Reflect.set(program, 'isDisposed', false)
        let caught

        try {
            await runtime.createComputePipeline({ program })
        } catch (error) {
            caught = error
        }

        expect(fake.calls.shaderModules).to.have.length(1)
        expect(fake.calls.pipelineLayouts).to.have.length(0)
        expect(fake.calls.computePipelines).to.have.length(0)
        expect(mutationAccepted).to.equal(false)
        expect(program.isDisposed).to.equal(true)
        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_PROGRAM_DISPOSED')
    })

    it('freezes Program required features before future native pipeline work', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const program = await createTestProgram(runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        expect(() => {
            program.requiredFeatures.push('texture-compression-astc')
        }).to.throw(TypeError)
        expect(Reflect.set(program, 'requiredFeatures', [ 'texture-compression-astc' ]))
            .to.equal(false)

        await runtime.createComputePipeline({ program })
        expect(fake.calls.shaderModules).to.have.length(1)
        expect(fake.calls.pipelineLayouts).to.have.length(1)
        expect(fake.calls.computePipelines).to.have.length(1)
    })

    it('keeps render Program facts immutable before native work', async() => {

        await expectProgramFactImmutability('render')
    })

    it('keeps compute Program facts immutable before native work', async() => {

        await expectProgramFactImmutability('compute')
    })

    it('rejects render Program disposal during pipeline descriptor snapshot before native work', async() => {

        await expectProgramDescriptorSnapshotDisposal('render')
    })

    it('rejects compute Program disposal during pipeline descriptor snapshot before native work', async() => {

        await expectProgramDescriptorSnapshotDisposal('compute')
    })

    it('keeps render Pipeline Program lifecycle authoritative', async() => {

        await expectExistingPipelineProgramAuthority('render')
    })

    it('keeps compute Pipeline Program lifecycle authoritative', async() => {

        await expectExistingPipelineProgramAuthority('compute')
    })

    it('rejects prototype-derived Pipeline and BindSet identities before command creation', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const layout = await runtime.createBindLayout({ group: 0, entries: [] })
        const program = await createTestProgram(runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn csMain() {}' ],
            compute: 'csMain',
        })
        const pipeline = await runtime.createComputePipeline({ program, layout: { mode: 'explicit', bindLayouts: [ layout ] } })
        const pipelineLookalike = prototypeLookalike(ComputePipeline, {
            runtime,
            id: 'lookalike-compute-pipeline',
            pipelineKind: 'compute',
            program,
            bindLayouts: Object.freeze([ layout ]),
            bindLayoutsByGroup: new Map([ [ 0, layout ] ]),
            subject: { kind: 'Pipeline', id: 'lookalike-compute-pipeline', pipelineKind: 'compute' },
            assertRuntime() {},
            assertUsable() {},
        })
        const bindSetLookalike = prototypeLookalike(BindSet, {
            runtime,
            id: 'lookalike-bind-set',
            layout,
            bindings: new Map(),
            preparationState: 'prepared',
            isDisposed: false,
            subject: { kind: 'BindSet', id: 'lookalike-bind-set' },
            assertRuntime() {},
            assertUsable() {},
        })
        let pipelineError
        let bindSetError

        try {
            runtime.createDispatchCommand({
                pipeline: pipelineLookalike,
                count: { workgroups: [ 1 ] },
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            })
        } catch (error) {
            pipelineError = error
        }
        try {
            runtime.createDispatchCommand({
                pipeline,
                bindSets: [ { set: bindSetLookalike } ],
                count: { workgroups: [ 1 ] },
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            })
        } catch (error) {
            bindSetError = error
        }

        expect(pipelineError).to.be.instanceOf(ScratchDiagnosticError)
        expect(pipelineError.diagnostic.code).to.equal('SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE')
        expect(bindSetError).to.be.instanceOf(ScratchDiagnosticError)
        expect(bindSetError.diagnostic.code).to.equal('SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE')
    })

    it('rejects prototype-derived pass and command identities before native submission effects', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const lookalike = prototypeLookalike(ComputePassSpec, {
            runtime,
            id: 'lookalike-compute-pass',
            passKind: 'compute',
            isDisposed: false,
            subject: { kind: 'PassSpec', id: 'lookalike-compute-pass', passKind: 'compute' },
            assertRuntime() {},
            assertUsable() {},
            hasEncoderSideEffects() { return true },
            createComputePassDescriptor() { return {} },
            advanceTimestampWriteEpochs() {},
        })
        const pass = runtime.createComputePass()
        const commandLookalike = prototypeLookalike(DispatchCommand, {
            runtime,
            id: 'lookalike-dispatch-command',
            commandKind: 'dispatch',
            subject: { kind: 'Command', id: 'lookalike-dispatch-command', commandKind: 'dispatch' },
            assertRuntime() {},
            validateForPass() {},
        })
        let passCaught
        let commandCaught

        try {
            runtime.createSubmission().compute(lookalike).submit()
        } catch (error) {
            passCaught = error
        }
        try {
            runtime.createSubmission().compute(pass, [ commandLookalike ]).submit()
        } catch (error) {
            commandCaught = error
        }

        expect(passCaught).to.be.instanceOf(ScratchDiagnosticError)
        expect(passCaught.diagnostic.code).to.equal('SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE')
        expect(commandCaught).to.be.instanceOf(ScratchDiagnosticError)
        expect(commandCaught.diagnostic.code).to.equal('SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE')
        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.computePasses).to.have.length(0)
    })

    it('does not use open instanceof checks as Scratch-owned internal brands', () => {

        const scratchRoot = new URL('../packages/geoscratch/src/scratch/', import.meta.url)
        const ownedAuthorities = new Set([
            'BeginOcclusionQueryCommand',
            'BindLayout',
            'BindSet',
            'BufferRegion',
            'BufferResource',
            'ComputePassSpec',
            'ComputePipeline',
            'CopyCommand',
            'DispatchCommand',
            'DrawCommand',
            'EndOcclusionQueryCommand',
            'ExternalImageUploadCommand',
            'LayoutCodec',
            'Program',
            'QuerySetResource',
            'ReadbackCommand',
            'RenderPassSpec',
            'RenderPipeline',
            'ResolveQuerySetCommand',
            'SamplerResource',
            'ScratchDiagnosticError',
            'TextureUploadCommand',
            'TextureResource',
            'TextureViewSpec',
            'UploadCommand',
        ])
        const sites = []
        const duckTypedAuthoritySites = []

        for (const entry of fs.readdirSync(scratchRoot, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
            const source = fs.readFileSync(new URL(entry.name, scratchRoot), 'utf8')
            for (const match of source.matchAll(/\binstanceof\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
                if (!ownedAuthorities.has(match[1])) continue
                const line = source.slice(0, match.index).split('\n').length
                sites.push(`packages/geoscratch/src/scratch/${entry.name}:${line}:${match[1]}`)
            }
            for (const match of source.matchAll(/typeof\s+[A-Za-z_$][A-Za-z0-9_$.]*\.assertRuntime\s*!==?\s*['"]function['"]/g)) {
                const line = source.slice(0, match.index).split('\n').length
                duckTypedAuthoritySites.push(`packages/geoscratch/src/scratch/${entry.name}:${line}`)
            }
        }

        expect(sites).to.deep.equal([])
        expect(duckTypedAuthoritySites).to.deep.equal([])
    })
})

function prototypeLookalike(Constructor, properties) {

    const value = Object.create(Constructor.prototype)
    Object.defineProperties(value, Object.fromEntries(Object.entries(properties).map(([ key, propertyValue ]) => [
        key,
        {
            value: propertyValue,
            enumerable: true,
            configurable: true,
            writable: true,
        },
    ])))
    return value
}

function restoreHasInstance(Constructor, descriptor) {

    if (descriptor === undefined) delete Constructor[Symbol.hasInstance]
    else Object.defineProperty(Constructor, Symbol.hasInstance, descriptor)
}

async function expectProgramFactImmutability(pipelineKind) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = await createPipelineProgram(runtime)
    const facts = [
        'vertex',
        'fragment',
        'compute',
        'requiredFeatures',
        'requiredLimits',
        'requiredLanguageFeatures',
        'layoutRequirements',
        'sourcePartDependencies',
    ]

    expect(Object.isExtensible(program)).to.equal(false)
    for (const fact of facts) {
        expect(Object.getOwnPropertyDescriptor(program, fact)?.configurable, fact)
            .to.equal(false)
        expect(() => {
            Object.defineProperty(program, fact, {
                configurable: true,
                get() {
                    program.dispose()
                    return undefined
                },
            })
        }, fact).to.throw(TypeError)
    }

    await createPipeline(pipelineKind, runtime, program)
    expect(fake.calls.shaderModules).to.have.length(1)
    expect(fake.calls.renderPipelines).to.have.length(pipelineKind === 'render' ? 1 : 0)
    expect(fake.calls.computePipelines).to.have.length(pipelineKind === 'compute' ? 1 : 0)
}

async function expectProgramDescriptorSnapshotDisposal(pipelineKind) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = await createPipelineProgram(runtime)
    const descriptor = { program }
    const fact = pipelineKind === 'render' ? 'targets' : 'immediateSize'
    Object.defineProperty(descriptor, fact, {
        configurable: true,
        enumerable: true,
        get() {
            program.dispose()
            return pipelineKind === 'render'
                ? [ { format: 'bgra8unorm' } ]
                : 0
        },
    })
    let caught

    try {
        if (pipelineKind === 'render') {
            await runtime.createRenderPipeline(descriptor)
        } else {
            await runtime.createComputePipeline(descriptor)
        }
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic.code).to.equal('SCRATCH_PROGRAM_DISPOSED')
    expect(fake.calls.shaderModules).to.have.length(1)
    expect(fake.calls.pipelineLayouts).to.have.length(0)
    expect(fake.calls.renderPipelines).to.have.length(0)
    expect(fake.calls.computePipelines).to.have.length(0)
}

async function expectExistingPipelineProgramAuthority(pipelineKind) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = await createPipelineProgram(runtime)
    const pipeline = await createPipeline(pipelineKind, runtime, program)
    program.dispose()
    let caught

    try {
        pipeline.assertUsable()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic.code).to.equal('SCRATCH_PROGRAM_DISPOSED')
    expect(fake.calls.renderPipelines).to.have.length(pipelineKind === 'render' ? 1 : 0)
    expect(fake.calls.computePipelines).to.have.length(pipelineKind === 'compute' ? 1 : 0)
}

async function createPipelineProgram(runtime) {

    return await createTestProgram(runtime, {
        sourceParts: [ triangleWgsl ],
        vertex: 'vsMain',
        fragment: 'fsMain',
        compute: 'csMain',
    })
}

async function createPipeline(pipelineKind, runtime, program) {

    if (pipelineKind === 'render') {
        return await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
    }
    return await runtime.createComputePipeline({ program })
}
