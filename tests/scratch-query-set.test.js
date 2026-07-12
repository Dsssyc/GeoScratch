import { expect } from 'chai'
import {
    BindSet,
    ComputePassSpec,
    QuerySetResource,
    ReadbackOperation,
    ResolveQuerySetCommand,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_BUFFER_USAGE_UNIFORM = 0x40

function querySlots(indices, contentEpoch) {

    return indices.map(index => ({ index, contentEpoch }))
}

async function createQueryFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const querySet = runtime.createQuerySet({
        label: 'timing queries',
        type: 'timestamp',
        count: 4,
    })
    const destination = await runtime.createBuffer({
        label: 'query resolve destination',
        size: 512,
        usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_UNIFORM,
    })
    const resolve = runtime.createResolveQuerySetCommand({
        label: 'resolve timing queries',
        source: {
            querySet,
            slots: querySlots([ 1, 2 ], 1),
        },
        destination,
        destinationOffset: 256,
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({
        label: 'produce timing query slots',
        timestampWrites: {
            querySet,
            begin: 1,
            end: 2,
        },
    })
    const bindLayout = runtime.createBindLayout({
        label: 'query destination bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'timingUniforms',
                type: 'uniform',
                visibility: [ 'vertex' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        timingUniforms: destination,
    }, {
        label: 'query destination bind set',
    })

    return { ...fake, runtime, querySet, destination, resolve, pass, bindLayout, bindSet }
}

async function createRenderTimestampFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const querySet = runtime.createQuerySet({
        label: 'render timestamps',
        type: 'timestamp',
        count: 2,
    })
    const target = await runtime.createTexture({
        label: 'render target',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: 0x10,
    })
    const pass = runtime.createRenderPass({
        label: 'render timestamp pass',
        color: [ {
            target,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
        timestampWrites: {
            querySet,
            begin: 0,
            end: 1,
        },
    })

    return { ...fake, runtime, querySet, target, pass }
}

async function createRenderCommandFixture(runtime, pass) {

    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        bindLayouts: [],
        targets: [ { format: pass.color[0].format } ],
    })

    return runtime.createDrawCommand({
        pipeline,
        bindSets: [],
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
}

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

describe('scratch QuerySetResource and ResolveQuerySetCommand', () => {

    it('creates indexed query resources and exposes the public API', async() => {

        const fixture = await createQueryFixture()

        expect(fixture.querySet).to.be.instanceOf(QuerySetResource)
        expect(fixture.querySet.resourceKind).to.equal('QuerySetResource')
        expect(fixture.querySet.type).to.equal('timestamp')
        expect(fixture.querySet.count).to.equal(4)
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 0, 0 ])
        expect(fixture.querySet.slotStates).to.deep.equal([ 'empty', 'empty', 'empty', 'empty' ])
        expect(fixture.querySet.gpuQuerySet.descriptor).to.deep.equal({
            label: 'timing queries',
            type: 'timestamp',
            count: 4,
        })
        expect(fixture.runtime.querySet({
            type: 'occlusion',
            count: 1,
        })).to.be.instanceOf(QuerySetResource)
    })

    it('lowers compute pass timestampWrites and records empty timestamp passes', async() => {

        const fixture = await createQueryFixture()
        const pass = fixture.runtime.createComputePass({
            label: 'timestamp compute pass',
            timestampWrites: {
                querySet: fixture.querySet,
                begin: 0,
                end: 1,
            },
        })

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(pass, [])
            .submit()

        expect(pass).to.be.instanceOf(ComputePassSpec)
        expect(fixture.calls.computePasses).to.have.length(1)
        expect(fixture.calls.computePasses[0].descriptor).to.deep.equal({
            label: 'timestamp compute pass',
            timestampWrites: {
                querySet: fixture.querySet.gpuQuerySet,
                beginningOfPassWriteIndex: 0,
                endOfPassWriteIndex: 1,
            },
        })
        expect(fixture.calls.computePasses[0].actions).to.deep.equal([
            { type: 'end' },
        ])
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 1, 1, 0, 0 ])
        expect(fixture.querySet.slotStates).to.deep.equal([ 'ready', 'ready', 'empty', 'empty' ])

        await submitted.done
    })

    it('lowers render pass timestampWrites', async() => {

        const fixture = await createRenderTimestampFixture()
        const descriptor = fixture.pass.createRenderPassDescriptor()

        expect(descriptor.timestampWrites).to.deep.equal({
            querySet: fixture.querySet.gpuQuerySet,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
        })

        const draw = await createRenderCommandFixture(fixture.runtime, fixture.pass)
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(fixture.pass, [ draw ])
            .submit()

        expect(fixture.calls.renderPasses[0].descriptor.timestampWrites).to.deep.equal({
            querySet: fixture.querySet.gpuQuerySet,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
        })
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 1, 1 ])
        expect(fixture.querySet.slotStates).to.deep.equal([ 'ready', 'ready' ])

        await submitted.done
    })

    it('resolves query sets through an explicit submission resolve step', async() => {

        const fixture = await createQueryFixture()
        fixture.querySet.gpuQuerySet.values[1] = 11n
        fixture.querySet.gpuQuerySet.values[2] = 22n

        const queryAllocationVersion = fixture.querySet.allocationVersion
        const destinationAllocationVersion = fixture.destination.allocationVersion

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [])
            .resolve(fixture.resolve)
            .submit()

        expect(fixture.resolve).to.be.instanceOf(ResolveQuerySetCommand)
        expect(fixture.resolve.commandKind).to.equal('resolve-query-set')
        expect(fixture.resolve.source).to.deep.equal({
            querySet: fixture.querySet,
            slots: [
                { index: 1, contentEpoch: 1 },
                { index: 2, contentEpoch: 1 },
            ],
        })
        expect(fixture.resolve.querySet).to.equal(fixture.querySet)
        expect(fixture.resolve.destination).to.equal(fixture.destination)
        expect(fixture.resolve.firstQuery).to.equal(1)
        expect(fixture.resolve.queryCount).to.equal(2)
        expect(fixture.resolve.destinationOffset).to.equal(256)
        expect(fixture.calls.resolveQueries).to.deep.equal([
            {
                querySet: fixture.querySet.gpuQuerySet,
                firstQuery: 1,
                queryCount: 2,
                destination: fixture.destination.gpuBuffer,
                destinationOffset: 256,
            },
        ])
        expect(new DataView(fixture.destination.gpuBuffer.data.buffer).getBigUint64(256, true)).to.equal(11n)
        expect(new DataView(fixture.destination.gpuBuffer.data.buffer).getBigUint64(264, true)).to.equal(22n)
        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 1, 1, 0 ])
        expect(fixture.querySet.slotStates).to.deep.equal([ 'empty', 'ready', 'ready', 'empty' ])
        expect(fixture.destination.contentEpoch).to.equal(1)
        expect(fixture.querySet.allocationVersion).to.equal(queryAllocationVersion)
        expect(fixture.destination.allocationVersion).to.equal(destinationAllocationVersion)

        await submitted.done
    })

    it('reads resolved query bytes through the existing ReadbackOperation', async() => {

        const fixture = await createQueryFixture()
        fixture.querySet.gpuQuerySet.values[1] = 33n
        fixture.querySet.gpuQuerySet.values[2] = 44n

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [])
            .resolve(fixture.resolve)
            .submit()
        const readback = fixture.runtime.createReadback({
            label: 'read resolved timing',
            source: fixture.destination,
            after: submitted,
            range: { offset: 256, byteLength: 16 },
        })
        const bytes = await readback.toBytes()
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

        expect(readback).to.be.instanceOf(ReadbackOperation)
        expect(readback.source).to.equal(fixture.destination)
        expect(readback.contentEpoch).to.equal(1)
        expect(view.getBigUint64(0, true)).to.equal(33n)
        expect(view.getBigUint64(8, true)).to.equal(44n)
        expect(readback.state).to.equal('consumed')
    })

    it('does not rebuild BindSet only because a resolved buffer contentEpoch changes', async() => {

        const fixture = await createQueryFixture()
        const firstBindGroup = fixture.bindSet.getBindGroup()

        expect(fixture.bindSet).to.be.instanceOf(BindSet)
        expect(fixture.calls.bindGroups).to.have.length(1)

        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(fixture.pass, [])
            .resolve(fixture.resolve)
            .submit()

        expect(fixture.destination.contentEpoch).to.equal(1)

        const secondBindGroup = fixture.bindSet.getBindGroup()

        expect(secondBindGroup).to.equal(firstBindGroup)
        expect(fixture.calls.bindGroups).to.have.length(1)

        await submitted.done
    })

    it('rejects resolving unwritten query slots before creating a command encoder in every validation mode', async() => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const fixture = await createQueryFixture()
            fixture.querySet.gpuQuerySet.values[1] = 11n
            fixture.querySet.gpuQuerySet.values[2] = 22n
            const builder = fixture.runtime.createSubmission({ validation })
                .resolve(fixture.resolve)

            const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                code: 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE',
                severity: 'error',
                phase: 'query',
            })

            expect(diagnostic.subject).to.deep.equal(fixture.resolve.subject)
            expect(diagnostic.related).to.deep.include(fixture.querySet.subject)
            expect(diagnostic.related).to.deep.include(builder.subject)
            expect(diagnostic.expected).to.deep.equal({ slotState: 'ready' })
            expect(diagnostic.actual).to.deep.include({
                submissionId: builder.id,
                stepIndex: 0,
                commandId: fixture.resolve.id,
                querySetId: fixture.querySet.id,
                queryType: 'timestamp',
                slotIndex: 1,
                firstQuery: 1,
                queryCount: 2,
                requiredContentEpoch: 1,
                simulatedContentEpoch: 0,
                currentContentEpoch: 0,
                simulatedSlotState: 'empty',
                whenMissing: 'throw',
            })
            expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 0, 0 ])
            expect(fixture.querySet.slotStates).to.deep.equal([ 'empty', 'empty', 'empty', 'empty' ])
            expect(fixture.destination.contentEpoch).to.equal(0)
            expect(fixture.calls.commandEncoders).to.have.length(0)
            expect(fixture.calls.resolveQueries).to.have.length(0)
            expect(fixture.calls.queueSubmissions).to.have.length(0)
        }
    })

    it('rejects resolve before the same-submission timestamp producer', async() => {

        const fixture = await createQueryFixture()
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .resolve(fixture.resolve)
            .compute(fixture.pass, [])

        await expectScratchDiagnostic(() => builder.submit(), {
            code: 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE',
            severity: 'error',
            phase: 'query',
        })

        expect(fixture.querySet.slotContentEpochs).to.deep.equal([ 0, 0, 0, 0 ])
        expect(fixture.destination.contentEpoch).to.equal(0)
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.computePasses).to.have.length(0)
        expect(fixture.calls.resolveQueries).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
    })

    it('applies validation mode to resolve query slot epoch diagnostics', async() => {

        for (const [ scenario, requiredContentEpoch, expectedCode ] of [
            [ 'future', 2, 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE' ],
            [ 'stale', 0, 'SCRATCH_SUBMISSION_STALE_READ' ],
        ]) {
            for (const validation of [ 'throw', 'warn', 'off' ]) {
                const fake = createFakeGpu()
                const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
                const querySet = runtime.createQuerySet({
                    label: `${scenario} timing queries ${validation}`,
                    type: 'timestamp',
                    count: 1,
                })
                const destination = await runtime.createBuffer({
                    label: `${scenario} timing destination ${validation}`,
                    size: 512,
                    usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
                })
                querySet._advanceSlotContentEpoch(0)
                const resolve = runtime.createResolveQuerySetCommand({
                    label: `${scenario} resolve ${validation}`,
                    source: {
                        querySet,
                        slots: [ { index: 0, contentEpoch: requiredContentEpoch } ],
                    },
                    destination,
                    whenMissing: 'throw',
                })
                const builder = runtime.createSubmission({ validation })
                    .resolve(resolve)

                if (validation === 'throw') {
                    const diagnostic = await expectScratchDiagnostic(() => builder.submit(), {
                        code: expectedCode,
                        severity: 'error',
                        phase: 'submission',
                    })

                    expect(diagnostic.subject).to.deep.equal(resolve.subject)
                    expect(diagnostic.related).to.deep.include(querySet.subject)
                    expect(diagnostic.related).to.deep.include(builder.subject)
                    expect(diagnostic.expected).to.deep.equal({ contentEpoch: requiredContentEpoch })
                    expect(diagnostic.actual).to.deep.include({
                        submissionId: builder.id,
                        stepIndex: 0,
                        commandId: resolve.id,
                        commandKind: 'resolve-query-set',
                        access: 'read',
                        role: 'source',
                        querySetId: querySet.id,
                        queryType: 'timestamp',
                        slotIndex: 0,
                        firstQuery: 0,
                        queryCount: 1,
                        requiredContentEpoch,
                        simulatedContentEpoch: 1,
                        currentContentEpoch: 1,
                        simulatedSlotState: 'ready',
                        whenMissing: 'throw',
                    })
                    expect(querySet.slotContentEpochs).to.deep.equal([ 1 ])
                    expect(destination.contentEpoch).to.equal(0)
                    expect(fake.calls.commandEncoders).to.have.length(0)
                    expect(fake.calls.resolveQueries).to.have.length(0)
                    expect(fake.calls.queueSubmissions).to.have.length(0)
                    continue
                }

                const submitted = builder.submit()

                if (validation === 'warn') {
                    expect(submitted.diagnostics).to.have.length(1)
                    expect(submitted.diagnostics[0]).to.include({
                        code: expectedCode,
                        severity: 'error',
                        phase: 'submission',
                    })
                    expect(submitted.diagnostics[0].expected).to.deep.equal({ contentEpoch: requiredContentEpoch })
                } else {
                    expect(submitted.diagnostics).to.deep.equal([])
                }
                expect(querySet.slotContentEpochs).to.deep.equal([ 1 ])
                expect(destination.contentEpoch).to.equal(1)
                expect(fake.calls.commandEncoders).to.have.length(1)
                expect(fake.calls.resolveQueries).to.have.length(1)
                expect(fake.calls.queueSubmissions).to.have.length(1)

                await submitted.done
            }
        }
    })

    it('rejects invalid query set descriptors with structured diagnostics', async() => {

        const fixture = await createQueryFixture()

        for (const descriptor of [
            {},
            { type: 'duration', count: 1 },
            { type: 'timestamp', count: 0 },
            { type: 'timestamp', count: 1.5 },
        ]) {
            await expectScratchDiagnostic(() => fixture.runtime.createQuerySet(descriptor), {
                code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'resource',
            })
        }

        const missingFeature = createFakeGpu()
        missingFeature.device.features.delete('timestamp-query')
        const runtimeWithoutTimestamp = await ScratchRuntime.create({ gpu: missingFeature.gpu })

        await expectScratchDiagnostic(() => runtimeWithoutTimestamp.createQuerySet({
            type: 'timestamp',
            count: 1,
        }), {
            code: 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
        })

        const missingCreateQuerySet = createFakeGpu()
        delete missingCreateQuerySet.device.createQuerySet
        const runtimeWithoutQuerySet = await ScratchRuntime.create({ gpu: missingCreateQuerySet.gpu })

        await expectScratchDiagnostic(() => runtimeWithoutQuerySet.createQuerySet({
            type: 'occlusion',
            count: 1,
        }), {
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
        })
    })

    it('rejects invalid timestampWrites with structured diagnostics', async() => {

        const fixtureA = await createQueryFixture()
        const fixtureB = await createQueryFixture()
        const occlusionQueries = fixtureA.runtime.createQuerySet({
            type: 'occlusion',
            count: 2,
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createComputePass({
            timestampWrites: {
                querySet: fixtureB.querySet,
                begin: 0,
            },
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        fixtureB.querySet.dispose()

        await expectScratchDiagnostic(() => fixtureB.runtime.createComputePass({
            timestampWrites: {
                querySet: fixtureB.querySet,
                begin: 0,
            },
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createComputePass({
            timestampWrites: {
                querySet: occlusionQueries,
                begin: 0,
            },
        }), {
            code: 'SCRATCH_PASS_TIMESTAMP_WRITES_INVALID',
            severity: 'error',
            phase: 'submission',
        })

        for (const timestampWrites of [
            { querySet: fixtureA.querySet },
            { querySet: fixtureA.querySet, begin: -1 },
            { querySet: fixtureA.querySet, begin: 1.5 },
            { querySet: fixtureA.querySet, begin: 4 },
            { querySet: fixtureA.querySet, end: -1 },
            { querySet: fixtureA.querySet, end: 1.5 },
            { querySet: fixtureA.querySet, end: 4 },
        ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createComputePass({
                timestampWrites,
            }), {
                code: 'SCRATCH_PASS_TIMESTAMP_WRITES_INVALID',
                severity: 'error',
                phase: 'submission',
            })
        }
    })

    it('rejects invalid resolve command descriptors with structured diagnostics', async() => {

        const fixtureA = await createQueryFixture()
        const fixtureB = await createQueryFixture()
        const nonResolveDestination = await fixtureA.runtime.createBuffer({
            size: 512,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })

        const legacyDiagnostic = await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            querySet: {},
            queryCount: 1,
            destination: fixtureA.destination,
        }), {
            code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(legacyDiagnostic.actual).to.deep.include({
            reason: 'legacyDescriptor',
        })
        expect(legacyDiagnostic.actual.legacyInputs).to.deep.equal([ 'querySet', 'queryCount' ])

        const mixedLegacyDiagnostic = await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureA.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            firstQuery: 0,
            destination: fixtureA.destination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(mixedLegacyDiagnostic.actual).to.deep.include({
            reason: 'legacyDescriptor',
        })
        expect(mixedLegacyDiagnostic.actual.legacyInputs).to.deep.equal([ 'firstQuery' ])

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureA.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: {},
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureB.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: fixtureA.destination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureA.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: fixtureB.destination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureA.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: nonResolveDestination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'resource',
        })

        for (const descriptor of [
            { source: { querySet: {}, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: -1, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 1.5, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 4, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: -1 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0.5 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: Number.NaN } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 1, contentEpoch: 0 }, { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 }, { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 }, { index: 2, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, whenMissing: 'skip-command' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, destinationOffset: -256, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, destinationOffset: 1, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 }, { index: 1, contentEpoch: 0 } ] }, destination: fixtureA.destination, destinationOffset: 504, whenMissing: 'throw' },
            { source: { querySet: fixtureA.querySet, slots: [ { index: 0, contentEpoch: 0 } ] }, destination: fixtureA.destination, destinationOffset: 512, whenMissing: 'throw' },
        ]) {
            await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand(descriptor), {
                code: 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        fixtureA.querySet.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: fixtureA.querySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: fixtureA.destination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })

        const freshQuerySet = fixtureA.runtime.createQuerySet({
            type: 'timestamp',
            count: 1,
        })
        fixtureA.destination.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createResolveQuerySetCommand({
            source: {
                querySet: freshQuerySet,
                slots: [ { index: 0, contentEpoch: 0 } ],
            },
            destination: fixtureA.destination,
            whenMissing: 'throw',
        }), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })
    })

    it('rejects invalid resolve submission steps with structured diagnostics', async() => {

        const fixtureA = await createQueryFixture()
        const fixtureB = await createQueryFixture()
        const upload = fixtureA.runtime.createUploadCommand({
            target: fixtureA.destination,
            data: new Uint8Array(8),
            offset: 0,
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .resolve(upload)
            .submit(), {
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
        })

        fixtureA.resolve.dispose()

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .resolve(fixtureA.resolve)
            .submit(), {
            code: 'SCRATCH_COMMAND_DISPOSED',
            severity: 'error',
            phase: 'command',
        })

        await expectScratchDiagnostic(() => fixtureA.runtime.createSubmission({ validation: 'throw' })
            .resolve(fixtureB.resolve)
            .submit(), {
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
        })

        const fixtureC = await createQueryFixture()
        const createCommandEncoder = fixtureC.device.createCommandEncoder.bind(fixtureC.device)
        fixtureC.device.createCommandEncoder = (descriptor) => {
            const encoder = createCommandEncoder(descriptor)
            delete encoder.resolveQuerySet
            return encoder
        }

        await expectScratchDiagnostic(() => fixtureC.runtime.createSubmission({ validation: 'throw' })
            .compute(fixtureC.pass, [])
            .resolve(fixtureC.resolve)
            .submit(), {
            code: 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
        })
    })
})
