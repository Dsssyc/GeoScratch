import { expect } from 'chai'
import {
    BindSet,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    replaceResourceAllocationForTest,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_UNIFORM = 0x40
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_STORAGE_BINDING = 0x8

describe('Scratch BindSet preparation', () => {

    it('is Promise-only and exposes only an acknowledged prepared BindSet', async() => {

        const fixture = await createUniformFixture()
        const creation = fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region(),
        }, { label: 'uniform set' })

        expect(creation).to.be.an.instanceOf(Promise)
        const bindSet = await creation

        expect(bindSet).to.be.an.instanceOf(BindSet)
        expect(bindSet.preparationState).to.equal('prepared')
        expect(bindSet.prepareGeneration).to.equal(1)
        expect(bindSet.preparedSnapshotHash).to.match(/^bind-set-snapshot-/)
        expect(bindSet.inFlightOperationId).to.equal(undefined)
        expect(bindSet.lastPreparationOperationId).to.equal(
            fixture.runtime.diagnostics.operations({ kind: 'bind-set-preparation' })[0].id
        )
        expect(bindSet.lastIncidentId).to.equal(undefined)
        expect(bindSet).not.to.have.property('getBindGroup')
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.bindGroups[0].descriptor.label)
            .to.equal(`uniform set [scratch:${bindSet.id}]`)
        expect(fixture.runtime.diagnostics.snapshot().bindSets).to.deep.equal([ {
            id: bindSet.id,
            label: 'uniform set',
            bindLayoutId: fixture.layout.id,
            preparationState: 'prepared',
            prepareGeneration: 1,
            preparedSnapshotHash: bindSet.preparedSnapshotHash,
            lastPreparationOperationId: bindSet.lastPreparationOperationId,
        } ])
        const operation = fixture.runtime.diagnostics.operations({
            kind: 'bind-set-preparation',
        })[0]
        expect(operation.target).to.deep.equal({
            kind: 'bind-set',
            bindSetId: bindSet.id,
            bindLayoutId: fixture.layout.id,
            preparationState: 'prepared',
            generation: 1,
            snapshotHash: bindSet.preparedSnapshotHash,
            preparationStage: 'commit',
        })
    })

    it('closes direct construction and keeps public facts immutable', async() => {

        const fixture = await createUniformFixture()
        const bindSet = await fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region(),
        })

        expect(() => new BindSet(fixture.runtime, fixture.layout, {
            uniforms: fixture.buffer.region(),
        })).to.throw(TypeError)
        expect(Object.isExtensible(bindSet)).to.equal(false)
        for (const [ key, value ] of [
            [ 'runtime', {} ],
            [ 'id', 'replacement' ],
            [ 'layout', {} ],
            [ 'bindings', new Map() ],
        ]) {
            expect(() => {
                bindSet[key] = value
            }).to.throw(TypeError)
        }
    })

    it('returns one exact cached Promise for unchanged and same-snapshot preparation', async() => {

        const fixture = await createUniformFixture({ deferErrorScopePops: true })
        const bindSet = await createPreparedUniformBindSet(fixture)
        fixture.errors.resetHistory()

        const cachedA = bindSet.prepare()
        const cachedB = bindSet.prepare()
        expect(cachedA).to.equal(cachedB)
        await cachedA
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.errorScopes).to.deep.equal([])

        replaceResourceAllocationForTest(fixture.buffer)
        expect(bindSet.preparationState).to.equal('stale')
        const pendingA = bindSet.prepare()
        const pendingB = bindSet.prepare()

        expect(pendingA).to.equal(pendingB)
        expect(bindSet.preparationState).to.equal('preparing')
        expect(bindSet.inFlightOperationId).to.be.a('string')
        expect(fixture.calls.bindGroups).to.have.length(2)
        settleAllPops(fixture)
        await pendingA
        expect(bindSet.preparationState).to.equal('prepared')
        expect(bindSet.prepareGeneration).to.equal(2)
    })

    it('keeps unchanged preparation checks free of snapshot reconstruction', async() => {

        const fixture = await createTextureFixture()
        const view = fixture.texture.view()
        const bindSet = await fixture.runtime.createBindSet(fixture.layout, {
            firstTexture: view,
            secondTexture: view,
        })
        const cachedPreparation = bindSet.prepare()
        const originalStringify = JSON.stringify
        const originalSort = Array.prototype.sort
        let snapshotSerializations = 0
        let bindingSorts = 0

        JSON.stringify = function(value, ...parameters) {
            if (
                value?.bindLayoutId === fixture.layout.id &&
                Array.isArray(value.bindings)
            ) snapshotSerializations++
            return originalStringify.call(JSON, value, ...parameters)
        }
        Array.prototype.sort = function(...parameters) {
            if (
                this.length > 0 &&
                this.every(value => Number.isInteger(value?.entry?.binding))
            ) bindingSorts++
            return originalSort.apply(this, parameters)
        }

        try {
            for (let index = 0; index < 32; index++) {
                expect(bindSet.preparationState).to.equal('prepared')
                bindSet.assertUsable()
                expect(bindSet.prepare()).to.equal(cachedPreparation)
            }
        } finally {
            JSON.stringify = originalStringify
            Array.prototype.sort = originalSort
        }

        expect(snapshotSerializations).to.equal(0)
        expect(bindingSorts).to.equal(0)
    })

    it('rejects a different snapshot during preparation without queueing or restarting', async() => {

        const fixture = await createUniformFixture({ deferErrorScopePops: true })
        const bindSet = await createPreparedUniformBindSet(fixture)
        fixture.errors.resetHistory()
        replaceResourceAllocationForTest(fixture.buffer)

        const pending = bindSet.prepare()
        replaceResourceAllocationForTest(fixture.buffer)
        const conflict = bindSet.prepare()

        expect(conflict).to.be.an.instanceOf(Promise)
        const error = await rejectedDiagnostic(conflict)
        expect(error.diagnostic.code).to.equal('SCRATCH_BIND_SET_PREPARATION_CONFLICT')
        expect(fixture.calls.bindGroups).to.have.length(2)
        settleAllPops(fixture)
        const drift = await rejectedDiagnostic(pending)
        expect(drift.diagnostic.code).to.equal('SCRATCH_BIND_SET_PREPARATION_SNAPSHOT_DRIFT')
        expect(bindSet.preparationState).to.equal('stale')
        expect(bindSet.prepareGeneration).to.equal(1)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('does not rebuild after content changes and explicitly repairs allocation staleness', async() => {

        const fixture = await createUniformFixture()
        const bindSet = await fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region(),
        })
        const firstHash = bindSet.preparedSnapshotHash
        const firstOperation = bindSet.lastPreparationOperationId

        advanceResourceContentEpochForTest(fixture.buffer)
        await bindSet.prepare()
        expect(bindSet.preparationState).to.equal('prepared')
        expect(bindSet.preparedSnapshotHash).to.equal(firstHash)
        expect(bindSet.lastPreparationOperationId).to.equal(firstOperation)
        expect(fixture.calls.bindGroups).to.have.length(1)

        replaceResourceAllocationForTest(fixture.buffer)
        expect(bindSet.preparationState).to.equal('stale')
        await bindSet.prepare()
        expect(bindSet.preparationState).to.equal('prepared')
        expect(bindSet.prepareGeneration).to.equal(2)
        expect(bindSet.preparedSnapshotHash).not.to.equal(firstHash)
        expect(fixture.calls.bindGroups).to.have.length(2)
    })

    it('deduplicates logical texture views only inside one preparation candidate', async() => {

        const fixture = await createTextureFixture()
        const view = fixture.texture.view()
        fixture.calls.textureViews.length = 0
        fixture.calls.bindGroups.length = 0
        fixture.calls.nativeTimeline.length = 0
        fixture.calls.errorScopes.length = 0

        const first = await fixture.runtime.createBindSet(fixture.layout, {
            firstTexture: view,
            secondTexture: view,
        }, { label: 'first texture set' })

        expect(first.preparationState).to.equal('prepared')
        expect(fixture.calls.textureViews).to.have.length(1)
        expect(fixture.calls.bindGroups).to.have.length(1)
        expect(fixture.calls.bindGroups[0].descriptor.entries[0].resource)
            .to.equal(fixture.calls.bindGroups[0].descriptor.entries[1].resource)
        expect(fixture.calls.nativeTimeline).to.deep.equal([
            ...expectedIssueTimeline('createTextureView'),
            ...expectedIssueTimeline('createBindGroup'),
        ])

        await fixture.runtime.createBindSet(fixture.layout, {
            firstTexture: view,
            secondTexture: view,
        }, { label: 'second texture set' })
        expect(fixture.calls.textureViews).to.have.length(2)
        expect(fixture.calls.bindGroups).to.have.length(2)
        expect(fixture.calls.bindGroups[0].descriptor.entries[0].resource)
            .not.to.equal(fixture.calls.bindGroups[1].descriptor.entries[0].resource)
    })

    it('deduplicates a texture-view issue even when its native call throws synchronously', async() => {

        const fixture = await createTextureFixture()
        const view = fixture.texture.view()
        fixture.calls.textureViews.length = 0
        fixture.calls.bindGroups.length = 0
        fixture.calls.nativeTimeline.length = 0
        fixture.calls.errorScopes.length = 0
        fixture.errors.throwNext('createTextureView', new Error('synchronous texture-view failure'))

        const error = await rejectedDiagnostic(fixture.runtime.createBindSet(fixture.layout, {
            firstTexture: view,
            secondTexture: view,
        }))

        expect(fixture.calls.nativeTimeline.filter(event => (
            event.type === 'native-method' && event.method === 'createTextureView'
        ))).to.have.length(1)
        expect(fixture.calls.bindGroups).to.have.length(0)
        expect(error.incident.outcomes).to.have.length(1)
        expect(error.incident.outcomes[0].subject).to.deep.equal({
            kind: 'BindSetTextureViewCandidate',
            bindSetId: error.incident.target.bindSetId,
            bindLayoutId: fixture.layout.id,
            group: fixture.layout.group,
            resourceId: fixture.texture.id,
            allocationVersion: fixture.texture.allocationVersion,
            viewSpecHash: view.hash,
            bindings: [
                { group: 0, binding: 0, name: 'firstTexture' },
                { group: 0, binding: 1, name: 'secondTexture' },
            ],
            omittedBindingCount: 0,
        })
    })

    it('validates the narrowed texture-view usage before issuing native candidates', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_STORAGE_BINDING,
        })
        const cases = [
            {
                entry: { type: 'texture', sampleType: 'float', viewDimension: '2d' },
                viewUsage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
            },
            {
                entry: {
                    type: 'storage-texture',
                    access: 'write-only',
                    format: 'rgba8unorm',
                    viewDimension: '2d',
                },
                viewUsage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            },
        ]

        for (const testCase of cases) {
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'value',
                    visibility: [ 'compute' ],
                    ...testCase.entry,
                } ],
            })
            const beforeViews = fake.calls.textureViews.length
            const beforeGroups = fake.calls.bindGroups.length

            const error = await rejectedDiagnostic(runtime.createBindSet(layout, {
                value: texture.view({ usage: testCase.viewUsage }),
            }))

            expect(error.diagnostic.code).to.equal('SCRATCH_BIND_RESOURCE_USAGE_MISSING')
            expect(error.diagnostic.actual).to.deep.equal({
                usage: testCase.viewUsage,
                textureUsage: texture.usage,
            })
            expect(fake.calls.textureViews).to.have.length(beforeViews)
            expect(fake.calls.bindGroups).to.have.length(beforeGroups)
        }
    })

    it('prepares the complete core buffer, sampler, sampled-texture, and storage-texture families', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('float32-filterable')
        fake.device.features.add('texture-formats-tier2')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const uniform = await runtime.createBuffer({ size: 256, usage: GPU_BUFFER_USAGE_UNIFORM })
        const storage = await runtime.createBuffer({ size: 512, usage: GPU_BUFFER_USAGE_STORAGE })
        const filtering = await runtime.createSampler({ minFilter: 'linear' })
        const nonFiltering = await runtime.createSampler()
        const comparison = await runtime.createSampler({ compare: 'less' })
        const sampledDescriptors = [
            [ 'floatTexture', 'rgba8unorm', 'float' ],
            [ 'unfilterableTexture', 'r32float', 'unfilterable-float' ],
            [ 'depthTexture', 'depth32float', 'depth' ],
            [ 'signedTexture', 'rgba8sint', 'sint' ],
            [ 'unsignedTexture', 'rgba8uint', 'uint' ],
        ]
        const sampledTextures = new Map()
        for (const [ name, format ] of sampledDescriptors) {
            sampledTextures.set(name, await runtime.createTexture({
                size: [ 4, 4 ],
                format,
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            }))
        }
        const storageTexture = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
        })
        const entries = [
            { binding: 0, name: 'uniform', type: 'uniform', visibility: [ 'compute' ], minBindingSize: 16 },
            { binding: 1, name: 'readStorage', type: 'read-storage', visibility: [ 'compute' ] },
            { binding: 2, name: 'writeStorage', type: 'storage', visibility: [ 'compute' ] },
            { binding: 3, name: 'filteringSampler', type: 'sampler', samplerType: 'filtering', visibility: [ 'compute' ] },
            { binding: 4, name: 'nonFilteringSampler', type: 'sampler', samplerType: 'non-filtering', visibility: [ 'compute' ] },
            { binding: 5, name: 'comparisonSampler', type: 'sampler', samplerType: 'comparison', visibility: [ 'compute' ] },
            ...sampledDescriptors.map(([ name, , sampleType ], index) => ({
                binding: 6 + index,
                name,
                type: 'texture',
                sampleType,
                viewDimension: '2d',
                visibility: [ 'compute' ],
            })),
            {
                binding: 11,
                name: 'storageTexture',
                type: 'storage-texture',
                access: 'write-only',
                format: 'rgba8unorm',
                viewDimension: '2d',
                visibility: [ 'compute' ],
            },
        ]
        const layout = await runtime.createBindLayout({ group: 0, entries })
        const bindings = {
            uniform: uniform.region({ size: 256 }),
            readStorage: storage.region({ size: 256 }),
            writeStorage: storage.region({ offset: 256, size: 256 }),
            filteringSampler: filtering,
            nonFilteringSampler: nonFiltering,
            comparisonSampler: comparison,
            storageTexture: storageTexture.view(),
        }
        for (const [ name, texture ] of sampledTextures) {
            bindings[name] = texture.view(
                name === 'depthTexture' ? { aspect: 'depth-only' } : {}
            )
        }

        const bindSet = await runtime.createBindSet(layout, bindings)

        expect(bindSet.preparationState).to.equal('prepared')
        expect(fake.calls.bindGroups.at(-1).descriptor.entries).to.have.length(12)
        expect(fake.calls.textureViews).to.have.length(6)
    })

    it('supports storage textures across every native-valid view dimension', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('core-features-and-limits')
        fake.device.features.add('texture-formats-tier2')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const descriptors = [
            [ 'oneD', '1d', [ 4, 1, 1 ], 'write-only' ],
            [ 'twoD', '2d', [ 4, 4, 1 ], 'read-only' ],
            [ 'twoDArray', '2d', [ 4, 4, 2 ], 'read-write', '2d-array' ],
            [ 'threeD', '3d', [ 4, 4, 4 ], 'write-only' ],
        ]
        const entries = []
        const bindings = {}
        for (let index = 0; index < descriptors.length; index++) {
            const [ name, dimension, size, access, viewDimension = dimension ] = descriptors[index]
            const texture = await runtime.createTexture({
                dimension,
                size,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
            })
            entries.push({
                binding: index,
                name,
                type: 'storage-texture',
                visibility: [ 'compute' ],
                access,
                format: 'rgba8unorm',
                viewDimension,
            })
            bindings[name] = texture.view({ dimension: viewDimension })
        }
        const layout = await runtime.createBindLayout({ group: 0, entries })

        const bindSet = await runtime.createBindSet(layout, bindings)

        expect(bindSet.preparationState).to.equal('prepared')
        expect(fake.calls.textureViews.slice(-4).map(view => view.descriptor.dimension))
            .to.deep.equal([ '1d', '2d', '2d-array', '3d' ])
    })

    it('rejects deterministic buffer range violations before native issue', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const uniform = await runtime.createBuffer({ size: 1024, usage: GPU_BUFFER_USAGE_UNIFORM })
        const storage = await runtime.createBuffer({ size: 1024, usage: GPU_BUFFER_USAGE_STORAGE })
        const cases = [
            [ 'uniform', 16, uniform.region({ size: 0 }), 'SCRATCH_BIND_RESOURCE_RANGE_INVALID' ],
            [ 'uniform', 16, uniform.region({ offset: 1, size: 16 }), 'SCRATCH_BIND_RESOURCE_OFFSET_UNALIGNED' ],
            [ 'uniform', 300, uniform.region({ size: 256 }), 'SCRATCH_BIND_MIN_BINDING_SIZE_UNSATISFIED' ],
            [ 'storage', 0, storage.region({ size: 6 }), 'SCRATCH_BIND_RESOURCE_RANGE_INVALID' ],
        ]
        for (const [ type, minBindingSize, region, code ] of cases) {
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'data',
                    type,
                    visibility: [ 'compute' ],
                    minBindingSize,
                } ],
            })
            const before = fake.calls.bindGroups.length
            const error = await rejectedDiagnostic(runtime.createBindSet(layout, { data: region }))
            expect(error.diagnostic.code).to.equal(code)
            expect(fake.calls.bindGroups).to.have.length(before)
        }

        const originalLimit = fake.device.limits.maxUniformBufferBindingSize
        fake.device.limits.maxUniformBufferBindingSize = 64
        const limitedLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'data',
                type: 'uniform',
                visibility: [ 'compute' ],
            } ],
        })
        const limitError = await rejectedDiagnostic(runtime.createBindSet(limitedLayout, {
            data: uniform.region({ size: 256 }),
        }))
        expect(limitError.diagnostic.code).to.equal('SCRATCH_BIND_RESOURCE_SIZE_LIMIT_EXCEEDED')
        fake.device.limits.maxUniformBufferBindingSize = originalLimit
    })

    it('keeps failed replacement preparation stale and allows an explicit acknowledged retry', async() => {

        const fixture = await createUniformFixture()
        const bindSet = await fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region({ size: 256 }),
        })
        replaceResourceAllocationForTest(fixture.buffer)
        fixture.errors.failNext(
            'createBindGroup',
            'out-of-memory',
            gpuError('GPUOutOfMemoryError', 'fake bind-group OOM')
        )

        const failure = await rejectedDiagnostic(bindSet.prepare())

        expect(failure.diagnostic.code).to.equal('SCRATCH_BIND_SET_PREPARATION_OUT_OF_MEMORY')
        expect(bindSet.preparationState).to.equal('stale')
        expect(bindSet.prepareGeneration).to.equal(1)
        expect(bindSet.preparedSnapshotHash).to.equal(undefined)
        expect(bindSet.lastIncidentId).to.equal(failure.incident.id)
        expect(failure.incident.pressure.currentScratchLogicalFootprintBytes).to.equal(512)

        await bindSet.prepare()
        expect(bindSet.preparationState).to.equal('prepared')
        expect(bindSet.prepareGeneration).to.equal(2)
        expect(fixture.calls.bindGroups).to.have.length(3)
    })

    it('supports every sampled view dimension and the native multisample contract', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('core-features-and-limits')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const descriptors = [
            [ 'oneD', '1d', [ 4, 1, 1 ], '1d' ],
            [ 'twoD', '2d', [ 4, 4, 1 ], '2d' ],
            [ 'twoDArray', '2d', [ 4, 4, 2 ], '2d-array' ],
            [ 'cube', '2d', [ 4, 4, 6 ], 'cube' ],
            [ 'cubeArray', '2d', [ 4, 4, 12 ], 'cube-array' ],
            [ 'threeD', '3d', [ 4, 4, 4 ], '3d' ],
        ]
        const entries = []
        const bindings = {}
        for (let index = 0; index < descriptors.length; index++) {
            const [ name, dimension, size, viewDimension ] = descriptors[index]
            const texture = await runtime.createTexture({
                dimension,
                size,
                format: 'rgba8unorm',
                usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
            })
            entries.push({
                binding: index,
                name,
                type: 'texture',
                visibility: [ 'fragment' ],
                sampleType: 'float',
                viewDimension,
            })
            bindings[name] = texture.view({ dimension: viewDimension })
        }
        const multisampled = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'rgba8unorm',
            sampleCount: 4,
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | 0x10,
        })
        entries.push({
            binding: entries.length,
            name: 'multisampled',
            type: 'texture',
            visibility: [ 'fragment' ],
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
            multisampled: true,
        })
        bindings.multisampled = multisampled.view()
        const layout = await runtime.createBindLayout({ group: 0, entries })

        const bindSet = await runtime.createBindSet(layout, bindings)

        expect(bindSet.preparationState).to.equal('prepared')
        expect(fake.calls.textureViews.slice(-7).map(view => view.descriptor.dimension))
            .to.deep.equal([ '1d', '2d', '2d-array', 'cube', 'cube-array', '3d', '2d' ])
    })

    it('rejects incompatible sampler, sampled texture, and storage texture shapes before native issue', async() => {

        const fake = createFakeGpu()
        fake.device.features.add('texture-component-swizzle')
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const nearest = await runtime.createSampler()
        const linear = await runtime.createSampler({ minFilter: 'linear' })
        const comparison = await runtime.createSampler({ compare: 'less' })
        const integerTexture = await runtime.createTexture({
            size: [ 4, 4 ],
            format: 'rgba8uint',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        const storageTexture = await runtime.createTexture({
            size: [ 4, 4 ],
            mipLevelCount: 2,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_STORAGE_BINDING,
        })
        const cases = [
            [
                { type: 'sampler', samplerType: 'comparison' },
                nearest,
                'SCRATCH_BIND_SAMPLER_TYPE_MISMATCH',
            ],
            [
                { type: 'sampler', samplerType: 'non-filtering' },
                linear,
                'SCRATCH_BIND_SAMPLER_TYPE_MISMATCH',
            ],
            [
                { type: 'sampler', samplerType: 'filtering' },
                comparison,
                'SCRATCH_BIND_SAMPLER_TYPE_MISMATCH',
            ],
            [
                { type: 'texture', sampleType: 'float', viewDimension: '2d' },
                integerTexture.view(),
                'SCRATCH_BIND_TEXTURE_SAMPLE_TYPE_MISMATCH',
            ],
            [
                {
                    type: 'storage-texture',
                    access: 'write-only',
                    format: 'rgba8unorm',
                    viewDimension: '2d',
                },
                storageTexture.view(),
                'SCRATCH_BIND_STORAGE_TEXTURE_VIEW_MISMATCH',
            ],
            [
                {
                    type: 'storage-texture',
                    access: 'write-only',
                    format: 'rgba8unorm',
                    viewDimension: '2d',
                },
                storageTexture.view({ mipLevelCount: 1, swizzle: 'bgra' }),
                'SCRATCH_BIND_STORAGE_TEXTURE_VIEW_MISMATCH',
            ],
        ]
        for (const [ entry, resource, code ] of cases) {
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'value',
                    visibility: [ 'compute' ],
                    ...entry,
                } ],
            })
            const beforeViews = fake.calls.textureViews.length
            const beforeGroups = fake.calls.bindGroups.length
            const error = await rejectedDiagnostic(runtime.createBindSet(layout, { value: resource }))
            expect(error.diagnostic.code).to.equal(code)
            expect(fake.calls.textureViews).to.have.length(beforeViews)
            expect(fake.calls.bindGroups).to.have.length(beforeGroups)
        }
    })

    it('issues every native candidate before awaiting and selects failures by stable causal order', async() => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const textureCreation = runtime.createTexture({
            size: [ 4, 4 ],
            mipLevelCount: 2,
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
        settleAllPops(fake)
        const texture = await textureCreation
        const layoutCreation = runtime.createBindLayout({
            group: 0,
            entries: [
                { binding: 0, name: 'first', type: 'texture', visibility: [ 'fragment' ] },
                { binding: 1, name: 'second', type: 'texture', visibility: [ 'fragment' ] },
            ],
        })
        settleAllPops(fake)
        const layout = await layoutCreation
        fake.errors.resetHistory()
        fake.calls.textureViews.length = 0
        fake.calls.bindGroups.length = 0
        fake.errors.failNext('createTextureView', 'internal', gpuError('GPUInternalError', 'first view'))
        fake.errors.failNext('createTextureView', 'validation', gpuError('GPUValidationError', 'second view'))
        fake.errors.failNext('createBindGroup', 'out-of-memory', gpuError('GPUOutOfMemoryError', 'bind group'))

        const creation = runtime.createBindSet(layout, {
            first: texture.view({ baseMipLevel: 0, mipLevelCount: 1 }),
            second: texture.view({ baseMipLevel: 1, mipLevelCount: 1 }),
        })

        expect(fake.calls.textureViews).to.have.length(2)
        expect(fake.calls.bindGroups).to.have.length(1)
        expect(fake.calls.nativeTimeline).to.deep.equal([
            ...expectedIssueTimeline('createTextureView'),
            ...expectedIssueTimeline('createTextureView'),
            ...expectedIssueTimeline('createBindGroup'),
        ])
        expect(fake.errors.scopeDepth).to.equal(0)
        settleAllPops(fake)

        const error = await rejectedDiagnostic(creation)
        expect(error.diagnostic.code).to.equal('SCRATCH_BIND_SET_PREPARATION_INTERNAL_FAILED')
        expect(error.incident.failureStage).to.equal('texture-view-acknowledgement')
        expect(error.incident.outcomes.map(outcome => outcome.diagnosticCode)).to.deep.equal([
            'SCRATCH_BIND_SET_PREPARATION_INTERNAL_FAILED',
            'SCRATCH_BIND_SET_PREPARATION_VALIDATION_FAILED',
            'SCRATCH_BIND_SET_PREPARATION_OUT_OF_MEMORY',
        ])
        expect(runtime.diagnostics.snapshot().bindSets).to.deep.equal([])
    })

    it('retains lifecycle recheck as secondary evidence beside a native preparation failure', async() => {

        const fixture = await createUniformFixture({ deferErrorScopePops: true })
        fixture.errors.resetHistory()
        fixture.calls.bindGroups.length = 0
        fixture.errors.failNext(
            'createBindGroup',
            'validation',
            gpuError('GPUValidationError', 'bind group validation failure')
        )

        const creation = fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region({ size: 256 }),
        })
        fixture.runtime.dispose()
        settleAllPops(fixture)

        const error = await rejectedDiagnostic(creation)
        expect(error.diagnostic.code).to.equal('SCRATCH_BIND_SET_PREPARATION_VALIDATION_FAILED')
        expect(error.incident.failureStage).to.equal('bind-group-acknowledgement')
        expect(error.incident.outcomes.map(outcome => ({
            stage: outcome.stage,
            code: outcome.diagnosticCode,
        }))).to.deep.equal([
            {
                stage: 'bind-group-acknowledgement',
                code: 'SCRATCH_BIND_SET_PREPARATION_VALIDATION_FAILED',
            },
            {
                stage: 'lifecycle-recheck',
                code: 'SCRATCH_RUNTIME_DISPOSED',
            },
        ])
    })

    it('cancels an initial candidate when a dependency is disposed during acknowledgement', async() => {

        const fixture = await createUniformFixture({ deferErrorScopePops: true })
        fixture.errors.resetHistory()
        fixture.calls.bindGroups.length = 0

        const creation = fixture.runtime.createBindSet(fixture.layout, {
            uniforms: fixture.buffer.region({ size: 256 }),
        })
        fixture.layout.dispose()
        settleAllPops(fixture)

        const error = await rejectedDiagnostic(creation)
        expect(error.diagnostic.code).to.equal('SCRATCH_BIND_DISPOSED')
        expect(error.incident.failureStage).to.equal('lifecycle-recheck')
        expect(fixture.runtime.diagnostics.snapshot().bindSets).to.deep.equal([])
        expect(fixture.calls.bindGroups).to.have.length(1)
    })
})

async function createUniformFixture(options = {}) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const bufferCreation = runtime.createBuffer({
        label: 'uniform buffer',
        size: 512,
        usage: GPU_BUFFER_USAGE_UNIFORM,
    })
    if (options.deferErrorScopePops) settleAllPops(fake)
    const buffer = await bufferCreation
    const layoutCreation = runtime.createBindLayout({
        label: 'uniform layout',
        group: 0,
        entries: [ {
            binding: 0,
            name: 'uniforms',
            type: 'uniform',
            visibility: [ 'vertex' ],
            minBindingSize: 16,
        } ],
    })
    if (options.deferErrorScopePops) settleAllPops(fake)
    const layout = await layoutCreation

    return { ...fake, runtime, buffer, layout }
}

async function createPreparedUniformBindSet(fixture) {

    const creation = fixture.runtime.createBindSet(fixture.layout, {
        uniforms: fixture.buffer.region({ size: 256 }),
    })
    settleAllPops(fixture)
    return creation
}

async function createTextureFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const texture = await runtime.createTexture({
        label: 'sampled texture',
        size: [ 4, 4 ],
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    const layout = await runtime.createBindLayout({
        label: 'texture layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'firstTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'secondTexture',
                type: 'texture',
                visibility: [ 'fragment' ],
            },
        ],
    })
    return { ...fake, runtime, texture, layout }
}

function settleAllPops(fixture) {

    for (let index = 0; index < fixture.errors.pendingPops.length; index++) {
        const pending = fixture.errors.pendingPops[index]
        if (!pending.settled) fixture.errors.settlePop(index)
    }
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

async function rejectedDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.an.instanceOf(ScratchDiagnosticError)
        return error
    }
    throw new Error('Expected Promise to reject with ScratchDiagnosticError.')
}

function gpuError(name, message) {

    const error = new Error(message)
    error.name = name
    return error
}
