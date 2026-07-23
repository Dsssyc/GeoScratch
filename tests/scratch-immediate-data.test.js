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

const GPU_BUFFER_USAGE_COPY_DST = 0x08
const GPU_BUFFER_USAGE_INDIRECT = 0x100
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

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

async function createImmediateRenderFixture(immediateSize = 16) {

    const fixture = await createImmediateRuntime()
    const target = await fixture.runtime.createTexture({
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pipeline = await fixture.runtime.createRenderPipeline({
        label: 'immediate render pipeline',
        program: createRenderProgram(fixture.runtime),
        targets: [ { format: 'rgba8unorm' } ],
        immediateSize,
    })
    const pass = fixture.runtime.createRenderPass({
        label: 'immediate render pass',
        color: [ {
            target: target.view(),
            load: 'clear',
            store: 'store',
        } ],
    })
    return { ...fixture, target, pipeline, pass }
}

async function createImmediateComputeFixture(immediateSize = 16) {

    const fixture = await createImmediateRuntime()
    const pipeline = await fixture.runtime.createComputePipeline({
        label: 'immediate compute pipeline',
        program: createComputeProgram(fixture.runtime),
        immediateSize,
    })
    const pass = fixture.runtime.createComputePass({
        label: 'immediate compute pass',
    })
    return { ...fixture, pipeline, pass }
}

function createDraw(runtime, pipeline, immediateData, options = {}) {

    return runtime.createDrawCommand({
        pipeline,
        immediateData,
        count: { vertexCount: 3 },
        resources: options.resources ?? { read: [], write: [] },
        whenMissing: options.whenMissing ?? 'throw',
        ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
    })
}

function createDispatch(runtime, pipeline, immediateData, options = {}) {

    return runtime.createDispatchCommand({
        pipeline,
        immediateData,
        count: options.count ?? { workgroups: [ 1 ] },
        resources: options.resources ?? { read: [], write: [] },
        whenMissing: options.whenMissing ?? 'throw',
        ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
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

describe('scratch immediate data command and submission contract', () => {

    it('accepts exact ArrayBuffer and explicit ArrayBufferView byte ranges', async() => {

        const fixture = await createImmediateRenderFixture()
        const whole = new ArrayBuffer(16)
        new Uint8Array(whole).set([ 1, 2, 3, 4 ])
        const storage = new ArrayBuffer(32)
        const typed = new Uint8Array(storage, 8, 16)
        typed.set([ 5, 6, 7, 8 ])
        const dataView = new DataView(storage, 4, 16)
        new Uint8Array(storage, 4, 16).set([ 9, 10, 11, 12 ])
        const commands = [
            createDraw(fixture.runtime, fixture.pipeline, whole),
            createDraw(fixture.runtime, fixture.pipeline, typed),
            createDraw(fixture.runtime, fixture.pipeline, dataView),
        ]

        expect(commands.map(command => command.immediateData))
            .to.deep.equal([ whole, typed, dataView ])
        expect(() => {
            commands[0].immediateData = typed
        }).to.throw(TypeError)
        fixture.runtime.submission().render(fixture.pass, commands).submit()

        expect(fixture.calls.immediateWrites).to.have.length(3)
        expect(fixture.calls.immediateWrites.map(write => ({
            passKind: write.passKind,
            offset: write.offset,
            bytes: [ ...write.bytes.slice(0, 4) ],
            byteLength: write.bytes.byteLength,
        }))).to.deep.equal([
            { passKind: 'render', offset: 0, bytes: [ 1, 2, 3, 4 ], byteLength: 16 },
            { passKind: 'render', offset: 0, bytes: [ 5, 6, 7, 8 ], byteLength: 16 },
            { passKind: 'render', offset: 0, bytes: [ 9, 10, 11, 12 ], byteLength: 16 },
        ])
    })

    it('requires exact command data presence and length for the pipeline contract', async() => {

        const fixture = await createImmediateRenderFixture()
        const zeroPipeline = await fixture.runtime.createRenderPipeline({
            program: createRenderProgram(fixture.runtime),
            targets: [ { format: 'rgba8unorm' } ],
        })
        const cases = [
            {
                pipeline: fixture.pipeline,
                immediateData: undefined,
            },
            {
                pipeline: fixture.pipeline,
                immediateData: new Uint8Array(12),
            },
            {
                pipeline: fixture.pipeline,
                immediateData: new Uint8Array(20),
            },
            {
                pipeline: fixture.pipeline,
                immediateData: null,
            },
            {
                pipeline: zeroPipeline,
                immediateData: new Uint8Array(0),
            },
        ]

        for (const scenario of cases) {
            await expectDiagnostic(
                () => Promise.resolve(createDraw(
                    fixture.runtime,
                    scenario.pipeline,
                    scenario.immediateData
                )),
                'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
                'command'
            )
        }

        const zeroCommand = createDraw(fixture.runtime, zeroPipeline, undefined)
        expect(zeroCommand.immediateData).to.equal(undefined)
        fixture.runtime.submission().render(fixture.pass, [ zeroCommand ]).submit()
        expect(fixture.calls.immediateWrites).to.have.length(0)
    })

    it('copies current source bytes independently for every submission', async() => {

        const fixture = await createImmediateRenderFixture()
        const source = new Uint8Array(16)
        source.set([ 1, 2, 3, 4 ])
        const command = createDraw(fixture.runtime, fixture.pipeline, source)

        const first = fixture.runtime.submission()
            .render(fixture.pass, [ command, command ])
            .submit()
        source.set([ 9, 8, 7, 6 ])
        const second = fixture.runtime.submission()
            .render(fixture.pass, [ command ])
            .submit()

        expect(command.immediateData).to.equal(source)
        expect(first.executionOutcomes.filter(outcome =>
            outcome.outcomeKind === 'command'
        )).to.have.length(2)
        expect(second.executionOutcomes.filter(outcome =>
            outcome.outcomeKind === 'command'
        )).to.have.length(1)
        expect(fixture.calls.immediateWrites.map(write => [ ...write.bytes.slice(0, 4) ]))
            .to.deep.equal([
                [ 1, 2, 3, 4 ],
                [ 1, 2, 3, 4 ],
                [ 9, 8, 7, 6 ],
            ])
    })

    it('sets complete render and compute immediate state exactly once per command', async() => {

        const render = await createImmediateRenderFixture()
        const renderFirst = createDraw(
            render.runtime,
            render.pipeline,
            new Uint8Array(16).fill(17)
        )
        const renderSecond = createDraw(
            render.runtime,
            render.pipeline,
            new Uint8Array(16).fill(34)
        )
        render.runtime.submission()
            .render(render.pass, [ renderFirst, renderSecond ])
            .submit()

        const renderActions = render.calls.renderPasses[0].actions
        expect(renderActions.filter(action => action.type === 'setImmediates'))
            .to.have.length(2)
        for (let index = 0; index < renderActions.length; index++) {
            if (renderActions[index].type !== 'setPipeline') continue
            expect(renderActions[index + 1].type).to.equal('setImmediates')
        }

        const compute = await createImmediateComputeFixture()
        const dispatch = createDispatch(
            compute.runtime,
            compute.pipeline,
            new Uint8Array(16).fill(51)
        )
        compute.runtime.submission().compute(compute.pass, [ dispatch ]).submit()

        expect(compute.calls.computePasses[0].actions.map(action => action.type))
            .to.deep.equal([
                'setPipeline',
                'setImmediates',
                'dispatchWorkgroups',
                'end',
            ])
        expect(compute.calls.immediateWrites[0].bytes).to.deep.equal(
            new Uint8Array(16).fill(51)
        )
    })

    it('uses immediate data for direct and indirect draw and dispatch paths', async() => {

        const render = await createImmediateRenderFixture()
        const renderIndirect = await render.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const renderUpload = render.runtime.createUploadCommand({
            target: renderIndirect.region(),
            data: new Uint32Array([ 3, 1, 0, 0 ]),
        })
        const indirectDraw = render.runtime.createDrawCommand({
            pipeline: render.pipeline,
            immediateData: new Uint8Array(16).fill(68),
            count: { indirect: renderIndirect.region() },
            resources: {
                read: [ {
                    resource: renderIndirect,
                    contentEpoch: 'current-at-step',
                } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        render.runtime.submission()
            .upload(renderUpload)
            .render(render.pass, [ indirectDraw ])
            .submit()

        expect(render.calls.renderPasses[0].actions.map(action => action.type))
            .to.include.members([ 'setImmediates', 'drawIndirect' ])

        const compute = await createImmediateComputeFixture()
        const computeIndirect = await compute.runtime.createBuffer({
            size: 12,
            usage: GPU_BUFFER_USAGE_INDIRECT | GPU_BUFFER_USAGE_COPY_DST,
        })
        const computeUpload = compute.runtime.createUploadCommand({
            target: computeIndirect.region(),
            data: new Uint32Array([ 1, 1, 1 ]),
        })
        const indirectDispatch = createDispatch(
            compute.runtime,
            compute.pipeline,
            new Uint8Array(16).fill(85),
            {
                count: { indirect: computeIndirect.region() },
                resources: {
                    read: [ {
                        resource: computeIndirect,
                        contentEpoch: 'current-at-step',
                    } ],
                    write: [],
                },
            }
        )
        compute.runtime.submission()
            .upload(computeUpload)
            .compute(compute.pass, [ indirectDispatch ])
            .submit()

        expect(compute.calls.computePasses[0].actions.map(action => action.type))
            .to.include.members([ 'setImmediates', 'dispatchWorkgroupsIndirect' ])
    })

    it('does not snapshot skipped commands or unselected fallback sources', async() => {

        const fixture = await createImmediateComputeFixture()
        const missing = await fixture.runtime.createBuffer({
            size: 4,
            usage: 1,
        })
        const missingRead = {
            read: [ { resource: missing, contentEpoch: 1 } ],
            write: [],
        }
        const skippedSource = new ArrayBuffer(16)
        const skipped = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            skippedSource,
            {
                resources: missingRead,
                whenMissing: 'skip-command',
            }
        )
        structuredClone(skippedSource, { transfer: [ skippedSource ] })
        const skippedWork = fixture.runtime.submission()
            .compute(fixture.pass, [ skipped ])
            .submit()

        expect(skippedWork.executionOutcomes.find(outcome =>
            outcome.outcomeKind === 'command'
        ).status).to.equal('skipped-command')
        expect(fixture.calls.immediateWrites).to.have.length(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)

        const fallbackSource = new Uint8Array(16).fill(102)
        const fallback = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            fallbackSource
        )
        const primarySource = new ArrayBuffer(16)
        const primary = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            primarySource,
            {
                resources: missingRead,
                whenMissing: 'use-fallback',
                fallback,
            }
        )
        structuredClone(primarySource, { transfer: [ primarySource ] })
        const fallbackWork = fixture.runtime.submission()
            .compute(fixture.pass, [ primary ])
            .submit()

        expect(fallbackWork.executionOutcomes.find(outcome =>
            outcome.outcomeKind === 'command'
        )).to.deep.include({
            status: 'fallback-executed',
            executedCommandId: fallback.id,
        })
        expect(fixture.calls.immediateWrites).to.have.length(1)
        expect(fixture.calls.immediateWrites[0].bytes).to.deep.equal(fallbackSource)
    })

    it('does not snapshot a pass that resolves to skip-pass', async() => {

        const fixture = await createImmediateComputeFixture()
        const missing = await fixture.runtime.createBuffer({
            size: 4,
            usage: 1,
        })
        const detached = new ArrayBuffer(16)
        const first = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            detached
        )
        const trigger = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            new Uint8Array(16),
            {
                resources: {
                    read: [ { resource: missing, contentEpoch: 1 } ],
                    write: [],
                },
                whenMissing: 'skip-pass',
            }
        )
        structuredClone(detached, { transfer: [ detached ] })

        const submitted = fixture.runtime.submission()
            .compute(fixture.pass, [ first, trigger ])
            .submit()
        const passOutcome = submitted.executionOutcomes.find(outcome =>
            outcome.outcomeKind === 'pass'
        )

        expect(passOutcome).to.deep.include({
            status: 'skipped-pass',
            triggerCommandId: trigger.id,
        })
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.immediateWrites).to.have.length(0)
    })

    it('rejects an invalid immediate source on the selected fallback only', async() => {

        const fixture = await createImmediateComputeFixture()
        const missing = await fixture.runtime.createBuffer({
            size: 4,
            usage: 1,
        })
        const fallbackSource = new ArrayBuffer(16)
        const fallback = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            fallbackSource
        )
        const primary = createDispatch(
            fixture.runtime,
            fixture.pipeline,
            new Uint8Array(16),
            {
                resources: {
                    read: [ { resource: missing, contentEpoch: 1 } ],
                    write: [],
                },
                whenMissing: 'use-fallback',
                fallback,
            }
        )
        structuredClone(fallbackSource, { transfer: [ fallbackSource ] })

        await expectDiagnostic(
            () => Promise.resolve(
                fixture.runtime.submission()
                    .compute(fixture.pass, [ primary ])
                    .submit()
            ),
            'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
            'command'
        )
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.immediateWrites).to.have.length(0)
    })

    it('snapshots every selected command before the first native effect', async() => {

        const fixture = await createImmediateRenderFixture()
        const first = createDraw(
            fixture.runtime,
            fixture.pipeline,
            new Uint8Array(16).fill(119)
        )
        const detached = new ArrayBuffer(16)
        const second = createDraw(fixture.runtime, fixture.pipeline, detached)
        structuredClone(detached, { transfer: [ detached ] })

        await expectDiagnostic(
            () => Promise.resolve(
                fixture.runtime.submission()
                    .render(fixture.pass, [ first, second ])
                    .submit()
            ),
            'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
            'command'
        )

        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.renderPasses).to.have.length(0)
        expect(fixture.calls.immediateWrites).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('rejects detached and resized selected sources in every validation mode', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const fixture = await createImmediateComputeFixture()
            const detached = new ArrayBuffer(16)
            const command = createDispatch(fixture.runtime, fixture.pipeline, detached)
            structuredClone(detached, { transfer: [ detached ] })

            await expectDiagnostic(
                () => Promise.resolve(
                    fixture.runtime.submission({ validation })
                        .compute(fixture.pass, [ command ])
                        .submit()
                ),
                'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
                'command'
            )
            expect(fixture.calls.commandEncoders).to.have.length(0)
        }

        const resizedFixture = await createImmediateComputeFixture()
        const resized = new ArrayBuffer(16, { maxByteLength: 32 })
        const resizedCommand = createDispatch(
            resizedFixture.runtime,
            resizedFixture.pipeline,
            resized
        )
        resized.resize(20)
        await expectDiagnostic(
            () => Promise.resolve(
                resizedFixture.runtime.submission()
                    .compute(resizedFixture.pass, [ resizedCommand ])
                    .submit()
            ),
            'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
            'command'
        )

        const viewFixture = await createImmediateComputeFixture()
        const viewStorage = new ArrayBuffer(16, { maxByteLength: 32 })
        const fixedView = new Uint8Array(viewStorage, 0, 16)
        const viewCommand = createDispatch(
            viewFixture.runtime,
            viewFixture.pipeline,
            fixedView
        )
        viewStorage.resize(8)
        await expectDiagnostic(
            () => Promise.resolve(
                viewFixture.runtime.submission()
                    .compute(viewFixture.pass, [ viewCommand ])
                    .submit()
            ),
            'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID',
            'command'
        )
    })

    it('attributes native setImmediates validation to command encoding without payload evidence', async() => {

        const fixture = await createImmediateComputeFixture()
        const payload = new Uint8Array(16).fill(137)
        const command = createDispatch(fixture.runtime, fixture.pipeline, payload)
        const capture = fixture.runtime.diagnostics.capture({
            nativeSubmissionDetail: 'step',
            includeDescriptors: true,
        })
        fixture.errors.failNext(
            'computeSetImmediates',
            'validation',
            new Error('fake immediate validation')
        )
        const submitted = fixture.runtime.submission()
            .compute(fixture.pass, [ command ])
            .submit()
        const nativeOutcome = await submitted.nativeOutcome
        const commandFailure = nativeOutcome.outcomes.find(outcome =>
            outcome.stage === 'command-encode'
        )

        expect(commandFailure).to.deep.include({
            nativeErrorCategory: 'validation',
            location: {
                kind: 'pass-command',
                submissionId: submitted.id,
                stepIndex: 0,
                commandIndex: 0,
                passId: fixture.pass.id,
                passKind: 'compute',
                commandId: command.id,
                commandKind: 'dispatch',
            },
        })
        expect(submitted.resourceAccesses).to.deep.equal([])
        const evidence = JSON.stringify({
            capture: capture.stop(),
            exported: fixture.runtime.diagnostics.exportEvidence(),
        })
        expect(evidence).not.to.include('[137,137,137,137')
        expect(evidence).not.to.match(/"[^"]*immediate[^"]*hash[^"]*"/i)
    })

    it('keeps synchronous setImmediates failure and device loss in native ownership', async() => {

        const synchronous = await createImmediateRenderFixture()
        const synchronousCommand = createDraw(
            synchronous.runtime,
            synchronous.pipeline,
            new Uint8Array(16)
        )
        const expected = new Error('synchronous immediate failure')
        synchronous.errors.throwNext('renderSetImmediates', expected)

        expect(() => synchronous.runtime.submission()
            .render(synchronous.pass, [ synchronousCommand ])
            .submit()
        ).to.throw(expected)
        expect(synchronous.errors.scopeDepth).to.equal(0)
        expect(synchronous.calls.queueSubmissions).to.have.length(0)

        const lost = await createImmediateComputeFixture()
        const lostCommand = createDispatch(
            lost.runtime,
            lost.pipeline,
            new Uint8Array(16)
        )
        const capture = lost.runtime.diagnostics.capture({
            nativeSubmissionDetail: 'step',
        })
        lost.errors.failNext(
            'computeSetImmediates',
            'validation',
            new Error('immediate validation before loss')
        )
        const submitted = lost.runtime.submission()
            .compute(lost.pass, [ lostCommand ])
            .submit()
        lost.errors.loseDevice({
            reason: 'unknown',
            message: 'device lost during immediate observation',
        })
        const nativeOutcome = await submitted.nativeOutcome

        expect(nativeOutcome.outcomes.some(outcome =>
            outcome.stage === 'command-encode' &&
            outcome.nativeErrorCategory === 'validation'
        )).to.equal(true)
        expect(nativeOutcome.outcomes.some(outcome =>
            outcome.stage === 'lifecycle-recheck' &&
            outcome.nativeErrorCategory === 'device-lost'
        )).to.equal(true)
        capture.stop()
    })
})
