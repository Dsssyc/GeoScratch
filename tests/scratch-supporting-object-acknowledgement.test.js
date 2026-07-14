import { expect } from 'chai'
import {
    BindLayout,
    QuerySetResource,
    SamplerResource,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

describe('Scratch acknowledged supporting objects', () => {

    describe('SamplerResource', () => {

        it('is Promise-only, pops every native scope before awaiting, and registers only after acknowledgement', async() => {

            const fixture = await createFixture({ deferErrorScopePops: true })
            const creation = fixture.runtime.createSampler({
                label: 'linear sampler',
                addressModeU: 'repeat',
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
                maxAnisotropy: 4,
            })
            let settled = false
            creation.finally(() => {
                settled = true
            })

            expect(creation).to.be.an.instanceOf(Promise)
            expect(fixture.runtime._resources.size).to.equal(0)
            expect(fixture.calls.samplers).to.have.length(1)
            expect(fixture.calls.nativeTimeline).to.deep.equal(expectedIssueTimeline('createSampler'))
            expect(fixture.errors.scopeDepth).to.equal(0)
            expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.deep.include({
                id: `${fixture.runtime.id}/gpu-operation-1`,
                sequence: 1,
                kind: 'sampler-allocation',
                target: {
                    kind: 'resource',
                    resourceId: pendingResourceId(fixture.runtime),
                    resourceKind: 'SamplerResource',
                    allocationVersion: 1,
                },
                descriptorHash: fixture.runtime.diagnostics.snapshot().pendingOperations[0].descriptorHash,
                startedAtMs: fixture.runtime.diagnostics.snapshot().pendingOperations[0].startedAtMs,
            })

            fixture.errors.settlePop(2)
            fixture.errors.settlePop(0)
            await settleMicrotasks()
            expect(settled).to.equal(false)
            expect(fixture.runtime._resources.size).to.equal(0)
            fixture.errors.settlePop(1)

            const sampler = await creation
            expect(sampler).to.be.an.instanceOf(SamplerResource)
            expect(fixture.runtime._resources).to.deep.equal(new Set([ sampler ]))
            expect(fixture.calls.samplers[0].descriptor).to.deep.equal({
                label: `linear sampler [scratch:${sampler.id}]`,
                addressModeU: 'repeat',
                addressModeV: 'clamp-to-edge',
                addressModeW: 'clamp-to-edge',
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
                lodMinClamp: 0,
                lodMaxClamp: 32,
                maxAnisotropy: 4,
            })
            expect(sampler).not.to.have.property('state')
            expect(sampler).not.to.have.property('contentEpoch')
            expect(sampler).not.to.have.property('isReady')
            expect(fixture.runtime.diagnostics.operations({ resourceId: sampler.id })).to.deep.include({
                version: 5,
                sequence: 1,
                id: `${fixture.runtime.id}/gpu-operation-1`,
                kind: 'sampler-allocation',
                status: 'succeeded',
                runtimeId: fixture.runtime.id,
                target: {
                    kind: 'resource',
                    resourceId: sampler.id,
                    resourceKind: 'SamplerResource',
                    allocationVersion: 1,
                },
                descriptor: fixture.runtime.diagnostics.operations()[0].descriptor,
                nativeLabel: `linear sampler [scratch:${sampler.id}]`,
                startedAtMs: fixture.runtime.diagnostics.operations()[0].startedAtMs,
                settledAtMs: fixture.runtime.diagnostics.operations()[0].settledAtMs,
            })
        })

        it('normalizes every native field and rejects deterministic sampler violations before native issue', async() => {

            const fixture = await createFixture()
            const sampler = await fixture.runtime.sampler({
                compare: 'less-equal',
                lodMinClamp: 2,
                lodMaxClamp: 7,
            })

            expect(sampler.descriptor).to.deep.equal({
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
                addressModeW: 'clamp-to-edge',
                magFilter: 'nearest',
                minFilter: 'nearest',
                mipmapFilter: 'nearest',
                lodMinClamp: 2,
                lodMaxClamp: 7,
                compare: 'less-equal',
                maxAnisotropy: 1,
            })
            const differentLodSampler = await fixture.runtime.createSampler({
                compare: 'less-equal',
                lodMinClamp: 3,
                lodMaxClamp: 7,
            })
            const facts = new Map(fixture.runtime.diagnostics.snapshot().resources.map(fact => [
                fact.id,
                fact,
            ]))
            expect(facts.get(sampler.id).descriptorHash)
                .not.to.equal(facts.get(differentLodSampler.id).descriptorHash)

            for (const [ input, expected, linear ] of [
                [ 0.6, 1, false ],
                [ 1.1, 1, false ],
                [ 1.5, 2, true ],
                [ 2.5, 2, true ],
                [ 3.5, 4, true ],
                [ 100_000, 65_535, true ],
                [ Number.POSITIVE_INFINITY, 65_535, true ],
            ]) {
                const normalizedSampler = await fixture.runtime.createSampler({
                    maxAnisotropy: input,
                    ...(linear ? {
                        magFilter: 'linear',
                        minFilter: 'linear',
                        mipmapFilter: 'linear',
                    } : {}),
                })
                expect(normalizedSampler.descriptor.maxAnisotropy, String(input)).to.equal(expected)
                expect(fixture.calls.samplers.at(-1).descriptor.maxAnisotropy, String(input))
                    .to.equal(expected)
            }

            for (const descriptor of [
                { addressModeV: 'invalid' },
                { magFilter: 'cubic' },
                { lodMinClamp: -1 },
                { lodMinClamp: Number.NaN },
                { lodMinClamp: 4, lodMaxClamp: 3 },
                { compare: 'approximately' },
                { maxAnisotropy: 0 },
                { maxAnisotropy: 0.5 },
                { maxAnisotropy: Number.NaN },
                { maxAnisotropy: Number.NEGATIVE_INFINITY },
                { maxAnisotropy: 1.5 },
                { maxAnisotropy: 2, magFilter: 'nearest', minFilter: 'linear', mipmapFilter: 'linear' },
            ]) {
                const before = fixture.calls.samplers.length
                const error = await rejectedDiagnostic(fixture.runtime.createSampler(descriptor))
                expect(error.diagnostic.code).to.equal('SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
                expect(fixture.calls.samplers).to.have.length(before)
            }
        })
    })

    describe('QuerySetResource', () => {

        it('acknowledges one native candidate and publishes only private indexed slot facts', async() => {

            const fixture = await createFixture({ deferErrorScopePops: true })
            const creation = fixture.runtime.createQuerySet({
                label: 'timestamps',
                type: 'timestamp',
                count: 2,
            })

            expect(creation).to.be.an.instanceOf(Promise)
            expect(fixture.runtime._resources.size).to.equal(0)
            expect(fixture.calls.querySets).to.have.length(1)
            expect(fixture.calls.nativeTimeline).to.deep.equal(expectedIssueTimeline('createQuerySet'))
            settleAllPops(fixture)

            const querySet = await creation
            expect(querySet).to.be.an.instanceOf(QuerySetResource)
            expect(querySet.slots()).to.deep.equal([
                { index: 0, state: 'empty', contentEpoch: 0 },
                { index: 1, state: 'empty', contentEpoch: 0 },
            ])
            expect(Object.isFrozen(querySet.slots())).to.equal(true)
            expect(querySet).not.to.have.property('state')
            expect(querySet).not.to.have.property('contentEpoch')
            expect(fixture.runtime.diagnostics.operations({ resourceKind: 'QuerySetResource' })[0].target)
                .to.deep.equal({
                    kind: 'resource',
                    resourceId: querySet.id,
                    resourceKind: 'QuerySetResource',
                    allocationVersion: 1,
                    queryType: 'timestamp',
                    count: 2,
                    slots: [
                        { index: 0, state: 'empty', contentEpoch: 0 },
                        { index: 1, state: 'empty', contentEpoch: 0 },
                    ],
                })
        })

        it('enforces the native 4096-slot bound and requires timestamp-query only for timestamp sets', async() => {

            const fixture = await createFixture()
            fixture.device.features.delete('timestamp-query')

            const occlusion = await fixture.runtime.createQuerySet({ type: 'occlusion', count: 4096 })
            expect(occlusion.type).to.equal('occlusion')
            expect(fixture.calls.querySets).to.have.length(1)

            const missingFeature = await rejectedDiagnostic(
                fixture.runtime.createQuerySet({ type: 'timestamp', count: 1 })
            )
            expect(missingFeature.diagnostic.code).to.equal('SCRATCH_RUNTIME_FEATURE_UNAVAILABLE')

            const aboveNativeLimit = await rejectedDiagnostic(
                fixture.runtime.createQuerySet({ type: 'occlusion', count: 4097 })
            )
            expect(aboveNativeLimit.diagnostic.code).to.equal('SCRATCH_RESOURCE_DESCRIPTOR_INVALID')
            expect(fixture.calls.querySets).to.have.length(1)
        })

        it('destroys a failed query-set candidate and never registers it', async() => {

            const fixture = await createFixture()
            const validationError = gpuError('GPUValidationError', 'query set invalid')
            fixture.errors.failNext('createQuerySet', 'validation', validationError)

            const error = await rejectedDiagnostic(
                fixture.runtime.createQuerySet({ type: 'occlusion', count: 2 })
            )

            expect(error.diagnostic.code).to.equal('SCRATCH_QUERY_SET_ALLOCATION_VALIDATION_FAILED')
            expect(fixture.calls.querySets).to.have.length(1)
            expect(fixture.calls.querySets[0].destroyed).to.equal(true)
            expect(fixture.calls.querySetDestroys).to.have.length(1)
            expect(fixture.runtime._resources.size).to.equal(0)
            expect(fixture.runtime.diagnostics.operations({ kind: 'query-set-allocation' })[0].status)
                .to.equal('failed')
        })
    })

    describe('BindLayout', () => {

        it('acknowledges one complete immutable native ABI layout', async() => {

            const fixture = await createFixture({ deferErrorScopePops: true })
            fixture.device.features.add('bgra8unorm-storage')
            const creation = fixture.runtime.createBindLayout({
                label: 'complete ABI',
                group: 1,
                entries: [
                    {
                        binding: 0,
                        name: 'uniforms',
                        type: 'uniform',
                        visibility: [ 'fragment', 'vertex' ],
                        hasDynamicOffset: false,
                        minBindingSize: 0,
                    },
                    {
                        binding: 1,
                        name: 'sampled',
                        type: 'texture',
                        visibility: [ 'fragment' ],
                    },
                    {
                        binding: 2,
                        name: 'storageImage',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'write-only',
                        format: 'bgra8unorm',
                        viewDimension: '2d-array',
                    },
                    {
                        binding: 3,
                        name: 'comparisonSampler',
                        type: 'sampler',
                        visibility: [ 'fragment' ],
                        samplerType: 'comparison',
                    },
                ],
            })

            expect(creation).to.be.an.instanceOf(Promise)
            expect(fixture.calls.bindGroupLayouts).to.have.length(1)
            expect(fixture.calls.nativeTimeline).to.deep.equal(expectedIssueTimeline('createBindGroupLayout'))
            expect(fixture.runtime.diagnostics.snapshot().bindLayouts).to.deep.equal([])
            settleAllPops(fixture)

            const layout = await creation
            expect(layout).to.be.an.instanceOf(BindLayout)
            expect(Object.isExtensible(layout)).to.equal(false)
            expect(Object.isFrozen(layout.entries)).to.equal(true)
            for (const entry of layout.entries) {
                expect(Object.isFrozen(entry)).to.equal(true)
                expect(Object.isFrozen(entry.visibility)).to.equal(true)
            }
            for (const [ key, replacement ] of [
                [ 'runtime', {} ],
                [ 'id', 'replacement-id' ],
                [ 'label', 'replacement-label' ],
                [ 'group', 0 ],
                [ 'entries', [] ],
                [ 'gpuBindGroupLayout', {} ],
            ]) {
                expect(() => {
                    layout[key] = replacement
                }).to.throw(TypeError)
            }
            expect(layout.entries).to.deep.equal([
                {
                    binding: 0,
                    name: 'uniforms',
                    type: 'uniform',
                    visibility: [ 'vertex', 'fragment' ],
                    hasDynamicOffset: false,
                    minBindingSize: 0,
                },
                {
                    binding: 1,
                    name: 'sampled',
                    type: 'texture',
                    visibility: [ 'fragment' ],
                    sampleType: 'float',
                    viewDimension: '2d',
                    multisampled: false,
                },
                {
                    binding: 2,
                    name: 'storageImage',
                    type: 'storage-texture',
                    visibility: [ 'compute' ],
                    access: 'write-only',
                    format: 'bgra8unorm',
                    viewDimension: '2d-array',
                },
                {
                    binding: 3,
                    name: 'comparisonSampler',
                    type: 'sampler',
                    visibility: [ 'fragment' ],
                    samplerType: 'comparison',
                },
            ])
            expect(fixture.calls.bindGroupLayouts[0].descriptor).to.deep.equal({
                label: `complete ABI [scratch:${layout.id}]`,
                entries: [
                    {
                        binding: 0,
                        visibility: 3,
                        buffer: {
                            type: 'uniform',
                            hasDynamicOffset: false,
                            minBindingSize: 0,
                        },
                    },
                    {
                        binding: 1,
                        visibility: 2,
                        texture: {
                            sampleType: 'float',
                            viewDimension: '2d',
                            multisampled: false,
                        },
                    },
                    {
                        binding: 2,
                        visibility: 4,
                        storageTexture: {
                            access: 'write-only',
                            format: 'bgra8unorm',
                            viewDimension: '2d-array',
                        },
                    },
                    {
                        binding: 3,
                        visibility: 2,
                        sampler: { type: 'comparison' },
                    },
                ],
            })
            expect(fixture.runtime.diagnostics.snapshot().bindLayouts).to.deep.equal([ {
                id: layout.id,
                label: 'complete ABI',
                group: 1,
                entries: layout.entries,
                acknowledgementState: 'acknowledged',
                lastAllocationOperationId: `${fixture.runtime.id}/gpu-operation-1`,
            } ])
        })

        it('preflights group, binding, stage, feature, and slot limits without a native call', async() => {

            const fixture = await createFixture()
            fixture.device.limits.maxBindGroups = 2
            fixture.device.limits.maxBindingsPerBindGroup = 4
            fixture.device.limits.maxSamplersPerShaderStage = 1
            fixture.device.limits.maxStorageBuffersInVertexStage = 0

            const cases = [
                { group: 2, entries: [] },
                {
                    group: 0,
                    entries: [ bindEntry({ binding: 4 }) ],
                },
                {
                    group: 0,
                    entries: [
                        bindEntry({ binding: 0, name: 'a', type: 'sampler' }),
                        bindEntry({ binding: 1, name: 'b', type: 'sampler' }),
                    ],
                },
                {
                    group: 0,
                    entries: [ bindEntry({ type: 'storage', visibility: [ 'vertex' ] }) ],
                },
                {
                    group: 0,
                    entries: [ bindEntry({
                        type: 'storage-texture',
                        access: 'write-only',
                        format: 'rgba8unorm',
                        visibility: [ 'vertex' ],
                    }) ],
                },
                {
                    group: 0,
                    entries: [ bindEntry({
                        type: 'storage-texture',
                        format: 'bgra8unorm',
                        visibility: [ 'compute' ],
                    }) ],
                },
            ]

            for (const descriptor of cases) {
                const error = await rejectedDiagnostic(fixture.runtime.createBindLayout(descriptor))
                expect(error.diagnostic.phase).to.equal('binding')
            }
            expect(fixture.calls.bindGroupLayouts).to.have.length(0)
        })

        it('keeps minBindingSize zero explicit and permits an empty native layout', async() => {

            const fixture = await createFixture()
            fixture.device.limits.maxUniformBufferBindingSize = 64
            const empty = await fixture.runtime.bindLayout({ group: 0, entries: [] })
            const withZero = await fixture.runtime.createBindLayout({
                group: 0,
                entries: [ bindEntry({ minBindingSize: 0 }) ],
            })
            const aboveBindingRangeLimit = await fixture.runtime.createBindLayout({
                group: 0,
                entries: [ bindEntry({ minBindingSize: 128 }) ],
            })

            expect(empty.entries).to.deep.equal([])
            expect(withZero.entries[0].minBindingSize).to.equal(0)
            expect(fixture.calls.bindGroupLayouts[1].descriptor.entries[0].buffer.minBindingSize)
                .to.equal(0)
            expect(aboveBindingRangeLimit.entries[0].minBindingSize).to.equal(128)
            expect(fixture.calls.bindGroupLayouts).to.have.length(3)
        })
    })

    it('closes every public constructor/static bypass and keeps aliases as ordinary Promise factories', async() => {

        const fixture = await createFixture()

        expect(SamplerResource).not.to.have.property('create')
        expect(QuerySetResource).not.to.have.property('create')
        expect(BindLayout).not.to.have.property('create')
        expect(() => new SamplerResource(fixture.runtime)).to.throw(TypeError)
        expect(() => new QuerySetResource(fixture.runtime, { type: 'occlusion', count: 1 })).to.throw(TypeError)
        expect(() => new BindLayout(fixture.runtime, { group: 0, entries: [] })).to.throw(TypeError)
        expect(fixture.runtime.sampler()).to.be.an.instanceOf(Promise)
        expect(fixture.runtime.querySet({ type: 'occlusion', count: 1 })).to.be.an.instanceOf(Promise)
        expect(fixture.runtime.bindLayout({ group: 0, entries: [] })).to.be.an.instanceOf(Promise)
    })

    for (const testCase of [
        {
            name: 'sampler',
            method: 'createSampler',
            create: runtime => runtime.createSampler(),
            codes: {
                validation: 'SCRATCH_SAMPLER_ALLOCATION_VALIDATION_FAILED',
                internal: 'SCRATCH_SAMPLER_ALLOCATION_INTERNAL_FAILED',
                'out-of-memory': 'SCRATCH_SAMPLER_ALLOCATION_OUT_OF_MEMORY',
                throw: 'SCRATCH_SAMPLER_ALLOCATION_NATIVE_FAILED',
            },
        },
        {
            name: 'query set',
            method: 'createQuerySet',
            create: runtime => runtime.createQuerySet({ type: 'occlusion', count: 1 }),
            codes: {
                validation: 'SCRATCH_QUERY_SET_ALLOCATION_VALIDATION_FAILED',
                internal: 'SCRATCH_QUERY_SET_ALLOCATION_INTERNAL_FAILED',
                'out-of-memory': 'SCRATCH_QUERY_SET_ALLOCATION_OUT_OF_MEMORY',
                throw: 'SCRATCH_QUERY_SET_ALLOCATION_NATIVE_FAILED',
            },
        },
        {
            name: 'bind layout',
            method: 'createBindGroupLayout',
            create: runtime => runtime.createBindLayout({ group: 0, entries: [] }),
            codes: {
                validation: 'SCRATCH_BIND_LAYOUT_ALLOCATION_VALIDATION_FAILED',
                internal: 'SCRATCH_BIND_LAYOUT_ALLOCATION_INTERNAL_FAILED',
                'out-of-memory': 'SCRATCH_BIND_LAYOUT_ALLOCATION_OUT_OF_MEMORY',
                throw: 'SCRATCH_BIND_LAYOUT_ALLOCATION_NATIVE_FAILED',
            },
        },
    ]) {
        it(`classifies ${testCase.name} validation, internal, OOM, sync, and scope failures independently`, async() => {

            for (const filter of [ 'validation', 'internal', 'out-of-memory' ]) {
                const fixture = await createFixture()
                fixture.errors.failNext(
                    testCase.method,
                    filter,
                    gpuError(gpuErrorName(filter), `${testCase.name} ${filter}`)
                )
                const error = await rejectedDiagnostic(testCase.create(fixture.runtime))
                expect(error.diagnostic.code).to.equal(testCase.codes[filter])
                expect(error.incident.nativeErrorCategory).to.equal(filter)
                expect(error.incident.failureStage).to.equal('scope-settlement')
                expect(error.incident.outcomes).to.have.length(1)
                expect(error.incident.outcomes[0]).to.include({
                    stage: 'scope-settlement',
                    diagnosticCode: testCase.codes[filter],
                    nativeErrorCategory: filter,
                })
                expect(fixture.runtime._resources.size).to.equal(0)
            }

            const thrownFixture = await createFixture()
            const nativeCause = new TypeError(`${testCase.name} synchronous failure`)
            thrownFixture.errors.throwNext(testCase.method, nativeCause)
            const thrown = await rejectedDiagnostic(testCase.create(thrownFixture.runtime))
            expect(thrown.diagnostic.code).to.equal(testCase.codes.throw)
            expect(thrown.cause).to.equal(nativeCause)
            expect(thrown.incident.failureStage).to.equal('native-issue')
            expect(thrown.incident.outcomes[0]).to.include({
                stage: 'native-issue',
                diagnosticCode: testCase.codes.throw,
                nativeErrorCategory: 'native-exception',
            })

            const scopeFixture = await createFixture({ deferErrorScopePops: true })
            const scopeFailure = testCase.create(scopeFixture.runtime)
            scopeFixture.errors.rejectPop(0, new Error('validation pop rejected'))
            scopeFixture.errors.settlePop(1)
            scopeFixture.errors.settlePop(2)
            const scopeError = await rejectedDiagnostic(scopeFailure)
            expect(scopeError.diagnostic.code).to.equal('SCRATCH_GPU_ERROR_SCOPE_FAILED')
            expect(scopeError.incident.nativeErrorCategory).to.equal('scope-failure')
            expect(scopeFixture.errors.scopeDepth).to.equal(0)
        })
    }

    it('settles scopes and preserves causal failures across lifecycle changes', async() => {

        const disposedFixture = await createFixture({ deferErrorScopePops: true })
        const disposedCreation = disposedFixture.runtime.createQuerySet({ type: 'occlusion', count: 2 })
        disposedFixture.runtime.dispose()
        settleAllPops(disposedFixture)
        const disposedError = await rejectedDiagnostic(disposedCreation)
        expect(disposedError.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(disposedFixture.calls.querySets[0].destroyed).to.equal(true)
        expect(disposedFixture.runtime._resources.size).to.equal(0)

        const lostFixture = await createFixture({ deferErrorScopePops: true })
        const lostCreation = lostFixture.runtime.createSampler()
        lostFixture.errors.loseDevice({ reason: 'unknown', message: 'device vanished' })
        settleAllPops(lostFixture)
        const lostError = await rejectedDiagnostic(lostCreation)
        expect(lostError.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION')
        expect(lostFixture.runtime._resources.size).to.equal(0)

        const nativeFixture = await createFixture({ deferErrorScopePops: true })
        const nativeCause = new TypeError('sampler issue preceded disposal')
        nativeFixture.errors.throwNext('createSampler', nativeCause)
        const nativeCreation = nativeFixture.runtime.createSampler()
        nativeFixture.runtime.dispose()
        settleAllPops(nativeFixture)
        const nativeError = await rejectedDiagnostic(nativeCreation)
        expect(nativeError.diagnostic.code).to.equal('SCRATCH_SAMPLER_ALLOCATION_NATIVE_FAILED')
        expect(nativeError.cause).to.equal(nativeCause)
        expect(nativeError.incident.failureStage).to.equal('native-issue')
        expect(nativeError.incident.outcomes).to.deep.include.members([
            {
                stage: 'native-issue',
                diagnosticCode: 'SCRATCH_SAMPLER_ALLOCATION_NATIVE_FAILED',
                nativeErrorCategory: 'native-exception',
                subject: nativeError.incident.outcomes[0].subject,
                nativeError: nativeError.incident.outcomes[0].nativeError,
            },
            {
                stage: 'lifecycle-recheck',
                diagnosticCode: 'SCRATCH_RUNTIME_DISPOSED',
                nativeErrorCategory: 'none',
                subject: nativeError.incident.outcomes[0].subject,
            },
        ])
        expect(nativeFixture.runtime._resources.size).to.equal(0)
    })
})

async function createFixture(options = {}) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    return { ...fake, runtime }
}

function expectedIssueTimeline(method) {

    return [
        { type: 'push-error-scope', filter: 'out-of-memory' },
        { type: 'push-error-scope', filter: 'internal' },
        { type: 'push-error-scope', filter: 'validation' },
        { type: 'native-method', method },
        { type: 'pop-error-scope', filter: 'validation' },
        { type: 'pop-error-scope', filter: 'internal' },
        { type: 'pop-error-scope', filter: 'out-of-memory' },
    ]
}

function settleAllPops(fixture) {

    for (let index = 0; index < fixture.errors.pendingPops.length; index++) {
        if (!fixture.errors.pendingPops[index].settled) fixture.errors.settlePop(index)
    }
}

function pendingResourceId(runtime) {

    return runtime.diagnostics.snapshot().pendingOperations[0].target.resourceId
}

function bindEntry(overrides = {}) {

    return {
        binding: 0,
        name: 'entry',
        type: 'uniform',
        visibility: [ 'fragment' ],
        ...overrides,
    }
}

function gpuError(name, message) {

    return Object.assign(new Error(message), { name })
}

function gpuErrorName(filter) {

    if (filter === 'validation') return 'GPUValidationError'
    if (filter === 'internal') return 'GPUInternalError'
    return 'GPUOutOfMemoryError'
}

async function settleMicrotasks() {

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

async function rejectedDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.an.instanceOf(ScratchDiagnosticError)
        return error
    }
    throw new Error('Expected a ScratchDiagnosticError rejection.')
}
