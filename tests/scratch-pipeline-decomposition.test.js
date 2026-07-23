import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

describe('scratch ShaderModule and pipeline decomposition', () => {

    it('reuses acknowledged distinct stage modules without recreating them', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const vertexModule = await runtime.createShaderModule({
            label: 'vertex module',
            sourceParts: [ { code: triangleWgsl } ],
        })
        const fragmentModule = await runtime.createShaderModule({
            label: 'fragment module',
            sourceParts: [ { code: triangleWgsl } ],
        })
        const program = runtime.createProgram({
            vertex: {
                module: vertexModule,
                entryPoint: 'vsMain',
                constants: { vertexScale: 2 },
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fsMain',
                constants: { fragmentAlpha: 0.5 },
            },
        })
        const shaderModuleCount = calls.shaderModules.length

        const first = await runtime.createRenderPipeline({
            label: 'first split pipeline',
            program,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const second = await runtime.createRenderPipeline({
            label: 'second split pipeline',
            program,
            layout: { mode: 'explicit', bindLayouts: [] },
            targets: [ { format: 'rgba8unorm' } ],
        })

        expect(calls.shaderModules).to.have.length(shaderModuleCount)
        expect(calls.asyncPipelineRequests[0].descriptor.vertex.module)
            .to.equal(vertexModule.gpuShaderModule)
        expect(calls.asyncPipelineRequests[0].descriptor.fragment.module)
            .to.equal(fragmentModule.gpuShaderModule)
        expect(calls.asyncPipelineRequests[0].descriptor.vertex.constants)
            .to.deep.equal({ vertexScale: 2 })
        expect(calls.asyncPipelineRequests[0].descriptor.fragment.constants)
            .to.deep.equal({ fragmentAlpha: 0.5 })
        expect(first.vertex.module).to.equal(vertexModule)
        expect(first.fragment.module).to.equal(fragmentModule)
        expect(first).not.to.have.property('shaderModule')
        expect(first.creationReport.stages).to.deep.equal([
            {
                stage: 'vertex',
                shaderModuleId: vertexModule.id,
                sourceHash: vertexModule.compilationReport.sourceHash,
                entryPoint: 'vsMain',
                constantKeys: [ 'vertexScale' ],
            },
            {
                stage: 'fragment',
                shaderModuleId: fragmentModule.id,
                sourceHash: fragmentModule.compilationReport.sourceHash,
                entryPoint: 'fsMain',
                constantKeys: [ 'fragmentAlpha' ],
            },
        ])
        expect(second.vertex.module).to.equal(vertexModule)
        expect(second.fragment.module).to.equal(fragmentModule)
    })

    it('omits native fragment and color targets for a fragmentless depth pipeline', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const vertexModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const program = runtime.createProgram({
            vertex: {
                module: vertexModule,
                entryPoint: 'vsMain',
            },
        })

        const pipeline = await runtime.createRenderPipeline({
            program,
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        })

        const native = calls.asyncPipelineRequests[0].descriptor
        expect(native).not.to.have.property('fragment')
        expect(pipeline.fragment).to.equal(undefined)
        expect(pipeline.targets).to.deep.equal([])
        expect(pipeline.targetFormats).to.deep.equal([])

        const error = await rejectedDiagnostic((async() =>
            await runtime.createRenderPipeline({
                program,
                targets: [ { format: 'bgra8unorm' } ],
            })
        )())
        expect(error.diagnostic).to.deep.include({
            code: 'SCRATCH_PIPELINE_FRAGMENT_FIELDS_FORBIDDEN',
            phase: 'pipeline',
        })
    })

    it('wraps native auto layouts as cached native-authoritative BindLayouts', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const computeModule = await runtime.createShaderModule({
            sourceParts: [ {
                code: '@compute @workgroup_size(1) fn main() {}',
            } ],
        })
        const program = runtime.createProgram({
            compute: {
                module: computeModule,
                entryPoint: 'main',
            },
        })
        const pipeline = await runtime.createComputePipeline({
            program,
            layout: { mode: 'auto' },
        })

        expect(calls.asyncPipelineRequests[0].descriptor.layout).to.equal('auto')
        expect(pipeline.layoutMode).to.equal('auto')
        expect(pipeline.pipelineLayout).to.equal(undefined)
        const descriptor = {
            label: 'auto group zero',
            group: 0,
            entries: [ {
                binding: 0,
                name: 'values',
                type: 'read-storage',
                visibility: [ 'compute' ],
            } ],
        }
        const derived = await pipeline.getBindLayout(descriptor)
        const cached = await pipeline.getBindLayout(descriptor)

        expect(cached).to.equal(derived)
        expect(derived.origin).to.equal('native-derived')
        expect(derived.validationConfidence).to.equal('native-authoritative')
        expect(derived.sourcePipelineId).to.equal(pipeline.id)
        expect(derived.group).to.equal(0)
        expect(derived.entries[0]).to.deep.include({
            binding: 0,
            name: 'values',
            type: 'read-storage',
        })
        expect(derived.gpuBindGroupLayout)
            .to.equal(calls.autoDerivedBindGroupLayouts[0].layout)
        expect(calls.autoDerivedBindGroupLayouts).to.have.length(1)

        const mismatch = await rejectedDiagnostic(pipeline.getBindLayout({
            label: 'different schema',
            group: 0,
            entries: [],
        }))
        expect(mismatch.diagnostic.code).to.equal(
            'SCRATCH_PIPELINE_LAYOUT_DERIVATION_DESCRIPTOR_MISMATCH'
        )
        expect(calls.autoDerivedBindGroupLayouts).to.have.length(1)

        const explicitPipeline = await runtime.createComputePipeline({
            program,
        })
        const error = await rejectedDiagnostic(
            explicitPipeline.getBindLayout({ group: 0, entries: [] })
        )
        expect(error.diagnostic.code).to.equal(
            'SCRATCH_PIPELINE_LAYOUT_DERIVATION_FORBIDDEN'
        )
    })

    it('disposes a native-derived layout when its pipeline is disposed in flight', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const computeModule = await runtime.createShaderModule({
            sourceParts: [ {
                code: '@compute @workgroup_size(1) fn main() {}',
            } ],
        })
        const pipeline = await runtime.createComputePipeline({
            program: runtime.createProgram({
                compute: { module: computeModule },
            }),
            layout: { mode: 'auto' },
        })
        const pending = pipeline.getBindLayout({
            group: 0,
            entries: [],
        })

        pipeline.dispose()
        const error = await rejectedDiagnostic(pending)

        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_DISPOSED')
        expect(runtime.diagnostics.snapshot().bindLayouts).to.deep.equal([])
    })
})

async function rejectedDiagnostic(promise) {

    try {
        await promise
        throw new Error('expected Promise rejection')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        return error
    }
}
