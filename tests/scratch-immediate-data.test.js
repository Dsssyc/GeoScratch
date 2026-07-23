import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const computeWgsl = `
@compute @workgroup_size(1)
fn csMain() {
}
`

function configureImmediateSupport(fixture, {
    languageFeatures = [ 'immediate_address_space' ],
    maxImmediateSize = 64,
} = {}) {

    fixture.gpu.wgslLanguageFeatures = new Set(languageFeatures)
    fixture.device.limits.maxImmediateSize = maxImmediateSize
    fixture.adapter.limits.maxImmediateSize = maxImmediateSize
    return fixture
}

async function createImmediateRuntime(options = {}) {

    const fixture = configureImmediateSupport(createFakeGpu(), options)
    const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })
    return { ...fixture, runtime }
}

function createRenderProgram(runtime, requiredLanguageFeatures = [ 'immediate_address_space' ]) {

    return runtime.createProgram({
        label: 'immediate render program',
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
        requiredLanguageFeatures,
    })
}

function createComputeProgram(runtime, requiredLanguageFeatures = [ 'immediate_address_space' ]) {

    return runtime.createProgram({
        label: 'immediate compute program',
        modules: [ computeWgsl ],
        entryPoints: { compute: 'csMain' },
        requiredLanguageFeatures,
    })
}

async function expectDiagnostic(action, code, phase) {

    try {
        await action()
        throw new Error(`expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include({
            code,
            severity: 'error',
            phase,
        })
        return error.diagnostic
    }
}

describe('scratch immediate data runtime and pipeline contract', () => {

    it('snapshots, sorts, deduplicates, and freezes WGSL language features', async() => {

        const fixture = createFakeGpu()
        fixture.gpu.wgslLanguageFeatures = [
            'subgroups',
            'immediate_address_space',
            'subgroups',
        ]
        const runtime = await ScratchRuntime.create({ gpu: fixture.gpu })

        expect(runtime.wgslLanguageFeatures).to.deep.equal([
            'immediate_address_space',
            'subgroups',
        ])
        expect(Object.isFrozen(runtime.wgslLanguageFeatures)).to.equal(true)

        fixture.gpu.wgslLanguageFeatures.push('readonly_and_readwrite_storage_textures')
        expect(runtime.wgslLanguageFeatures).to.deep.equal([
            'immediate_address_space',
            'subgroups',
        ])
        expect(() => runtime.wgslLanguageFeatures.push('packed_4x8_integer_dot_product'))
            .to.throw(TypeError)
    })

    it('uses an empty frozen language feature snapshot when the GPU property is absent', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        expect(runtime.wgslLanguageFeatures).to.deep.equal([])
        expect(Object.isFrozen(runtime.wgslLanguageFeatures)).to.equal(true)
    })

    it('normalizes Program language feature requirements and validates availability', async() => {

        const { runtime } = await createImmediateRuntime({
            languageFeatures: [ 'subgroups', 'immediate_address_space' ],
        })
        const program = createRenderProgram(runtime, new Set([
            'immediate_address_space',
            'subgroups',
        ]))

        expect(program.requiredLanguageFeatures).to.deep.equal([
            'immediate_address_space',
            'subgroups',
        ])

        const diagnostic = await expectDiagnostic(
            () => Promise.resolve(createRenderProgram(runtime, [ 'f16' ])),
            'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE',
            'program'
        )
        expect(diagnostic.expected).to.deep.equal({ languageFeature: 'f16' })
        expect(diagnostic.actual).to.deep.equal({
            wgslLanguageFeatures: [ 'immediate_address_space', 'subgroups' ],
        })
    })

    it('rejects malformed Program language feature descriptors structurally', async() => {

        const { runtime } = await createImmediateRuntime()
        const cases = [
            42,
            null,
            [ 'immediate_address_space', '' ],
            [ 'immediate_address_space', 7 ],
            {
                [Symbol.iterator]() {
                    throw new Error('unstable iterable')
                },
            },
            Object.defineProperty({}, Symbol.iterator, {
                get() {
                    throw new Error('unstable iterable descriptor')
                },
            }),
        ]

        for (const requiredLanguageFeatures of cases) {
            await expectDiagnostic(
                () => Promise.resolve(runtime.createProgram({
                    modules: [ triangleWgsl ],
                    requiredLanguageFeatures,
                })),
                'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE',
                'program'
            )
        }
    })

    it('revalidates mutable Program language requirements for each future pipeline', async() => {

        const { runtime, calls } = await createImmediateRuntime()
        const program = createRenderProgram(runtime)
        const first = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
            immediateSize: 16,
        })

        expect(first.immediateSize).to.equal(16)
        program.requiredLanguageFeatures = []

        await expectDiagnostic(
            async() => await runtime.createRenderPipeline({
                program,
                targets: [ { format: 'bgra8unorm' } ],
                immediateSize: 16,
            }),
            'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID',
            'pipeline'
        )
        expect(calls.pipelineLayouts).to.have.length(1)
        expect(calls.renderPipelines).to.have.length(1)
    })

    it('keeps an in-flight pipeline immune to later Program mutation', async() => {

        const { runtime, calls } = await createImmediateRuntime()
        const program = createRenderProgram(runtime)
        queueMicrotask(() => {
            program.requiredLanguageFeatures.length = 0
        })
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'bgra8unorm' } ],
            immediateSize: 16,
        })

        expect(pipeline.immediateSize).to.equal(16)
        expect(calls.pipelineLayouts[0].descriptor.immediateSize).to.equal(16)
    })

    it('lowers render and compute immediate sizes into immutable pipeline layouts', async() => {

        const { runtime, calls } = await createImmediateRuntime()
        const renderProgram = createRenderProgram(runtime)
        const computeProgram = createComputeProgram(runtime)
        const capture = runtime.diagnostics.capture({
            maxOperations: 4,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 16_384,
            includeDescriptors: true,
        })
        const renderPipeline = await runtime.createRenderPipeline({
            label: 'immediate render pipeline',
            program: renderProgram,
            targets: [ { format: 'bgra8unorm' } ],
            immediateSize: 16,
        })
        const computePipeline = await runtime.createComputePipeline({
            label: 'immediate compute pipeline',
            program: computeProgram,
            immediateSize: 32,
        })

        expect(renderPipeline.immediateSize).to.equal(16)
        expect(computePipeline.immediateSize).to.equal(32)
        expect(calls.pipelineLayouts.map(layout => layout.descriptor.immediateSize))
            .to.deep.equal([ 16, 32 ])
        expect(() => {
            renderPipeline.immediateSize = 32
        }).to.throw(TypeError)

        const operations = runtime.diagnostics.operations()
        const renderOperation = operations.find(operation =>
            operation.kind === 'render-pipeline-creation'
        )
        const computeOperation = operations.find(operation =>
            operation.kind === 'compute-pipeline-creation'
        )
        expect(renderOperation.descriptor.summary.immediateSize).to.equal(16)
        expect(computeOperation.descriptor.summary.immediateSize).to.equal(32)

        const captured = capture.stop().operations
        const capturedRender = captured.find(operation =>
            operation.kind === 'render-pipeline-creation'
        )
        const capturedCompute = captured.find(operation =>
            operation.kind === 'compute-pipeline-creation'
        )
        expect(capturedRender.descriptor.full.immediateSize).to.equal(16)
        expect(capturedCompute.descriptor.full.immediateSize).to.equal(32)
    })

    it('normalizes omitted immediateSize to zero and lowers that exact value', async() => {

        const { runtime, calls } = await createImmediateRuntime()
        const pipeline = await runtime.createRenderPipeline({
            program: createRenderProgram(runtime),
            targets: [ { format: 'bgra8unorm' } ],
        })

        expect(pipeline.immediateSize).to.equal(0)
        expect(calls.pipelineLayouts[0].descriptor.immediateSize).to.equal(0)
    })

    it('rejects invalid immediate sizes before creating native objects', async() => {

        const cases = [
            { immediateSize: -4, maxImmediateSize: 64 },
            { immediateSize: 2, maxImmediateSize: 64 },
            { immediateSize: 4.5, maxImmediateSize: 64 },
            { immediateSize: Number.NaN, maxImmediateSize: 64 },
            { immediateSize: Number.POSITIVE_INFINITY, maxImmediateSize: 64 },
            { immediateSize: 0x1_0000_0000, maxImmediateSize: 0x1_0000_0000 },
            { immediateSize: 68, maxImmediateSize: 64 },
        ]

        for (const scenario of cases) {
            const { runtime, calls } = await createImmediateRuntime({
                maxImmediateSize: scenario.maxImmediateSize,
            })
            await expectDiagnostic(
                async() => await runtime.createRenderPipeline({
                    program: createRenderProgram(runtime),
                    targets: [ { format: 'bgra8unorm' } ],
                    immediateSize: scenario.immediateSize,
                }),
                'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID',
                'pipeline'
            )
            expect(calls.shaderModules).to.have.length(0)
            expect(calls.pipelineLayouts).to.have.length(0)
            expect(calls.renderPipelines).to.have.length(0)
        }
    })

    it('requires an explicit Program immediate language feature for nonzero sizes', async() => {

        const { runtime, calls } = await createImmediateRuntime()
        const program = createComputeProgram(runtime, [])

        const diagnostic = await expectDiagnostic(
            async() => await runtime.createComputePipeline({
                program,
                immediateSize: 4,
            }),
            'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID',
            'pipeline'
        )

        expect(diagnostic.expected).to.deep.equal({
            requiredLanguageFeature: 'immediate_address_space',
        })
        expect(diagnostic.actual).to.deep.equal({
            immediateSize: 4,
            requiredLanguageFeatures: [],
        })
        expect(calls.shaderModules).to.have.length(0)
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.computePipelines).to.have.length(0)
    })
})
