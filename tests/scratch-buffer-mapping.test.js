import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const MAP_READ = 0x1
const MAP_WRITE = 0x2
const COPY_SRC = 0x4
const COPY_DST = 0x8

async function settleMicrotasks(count = 16) {

    for (let index = 0; index < count; index++) await Promise.resolve()
}

async function rejectedDiagnostic(promise, code) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        if (code !== undefined) expect(error.diagnostic.code).to.equal(code)
        return error
    }
    throw new Error(`Expected ${code ?? 'ScratchDiagnosticError'} rejection.`)
}

function thrownDiagnostic(action, code) {

    try {
        action()
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(error.diagnostic.code).to.equal(code)
        return error
    }
    throw new Error(`Expected ${code} to be thrown.`)
}

async function createMappedFixture(mode, fakeOptions = {}) {

    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const usage = mode === 'read' ? MAP_READ | COPY_DST : MAP_WRITE | COPY_SRC
    const creation = runtime.createBuffer({ label: `${mode} mapping`, size: 32, usage })
    if (fakeOptions.deferErrorScopePops) {
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
    }
    const buffer = await creation
    return { fake, runtime, buffer }
}

describe('Scratch buffer host mapping', () => {

    it('creates mapped-at-creation buffers for arbitrary usage under an explicit WRITE lease', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const { buffer, lease } = await runtime.createMappedBuffer({
            label: 'initial uniforms',
            size: 16,
            usage: 0x40,
        })
        const view = lease.view
        new Uint8Array(view).set([ 4, 3, 2, 1 ])

        expect(buffer.usage).to.equal(0x40)
        expect(buffer.gpuBuffer.descriptor.mappedAtCreation).to.equal(true)
        expect(fake.calls.maps).to.have.length(0)
        expect(lease.mode).to.equal('write')
        expect(lease.region.buffer).to.equal(buffer)
        expect(lease.region).to.include({ offset: 0, size: 16 })
        expect(runtime.diagnostics.snapshot().bufferMappings.find(
            fact => fact.id === lease.id
        )).to.deep.include({
            resourceId: buffer.id,
            state: 'mapped',
            mode: 'write',
        })

        lease.dispose()

        expect(view.byteLength).to.equal(0)
        expect(buffer.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('ready')
        expect([ ...buffer.gpuBuffer.data.slice(0, 4) ]).to.deep.equal([ 4, 3, 2, 1 ])
        expect(fake.calls.unmaps).to.have.length(1)
    })

    it('validates dedicated mapped creation before native allocation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })

        await rejectedDiagnostic(runtime.createMappedBuffer({
            size: 6,
            usage: 0x40,
        }), 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID')
        await rejectedDiagnostic(runtime.createMappedBuffer({
            size: 16,
            usage: 0x40,
            mappedAtCreation: false,
        }), 'SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY')

        expect(fake.calls.buffers).to.have.length(0)
    })

    it('keeps BufferRegion and BindSet preparation legal while mapped', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const { buffer, lease } = await runtime.createMappedBuffer({
            size: 256,
            usage: 0x40,
        })
        const interpretedLater = buffer.region({ offset: 0, size: 64 })
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [ {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex' ],
            } ],
        })
        const bindSet = await runtime.createBindSet(bindLayout, {
            uniforms: interpretedLater,
        })

        expect(bindSet.preparationState).to.equal('prepared')
        expect(fake.calls.bindGroups).to.have.length(1)
        lease.dispose()
    })

    it('blocks direct queue writes and direct readback before native side effects', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const uploadTarget = await runtime.createBuffer({
            size: 16,
            usage: MAP_READ | COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: uploadTarget.region(),
            data: new Uint8Array(16),
        })
        const uploadLease = await runtime.mapBuffer({
            region: uploadTarget.region(),
            mode: 'read',
        })
        thrownDiagnostic(
            () => upload.execute(runtime.queue),
            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
        )
        expect(fake.calls.queueWrites).to.have.length(0)
        uploadLease.dispose()

        const readbackSource = await runtime.createBuffer({
            size: 16,
            usage: MAP_WRITE | COPY_SRC,
        })
        const readback = runtime.createReadback({ source: readbackSource.region() })
        const readbackLease = await runtime.mapBuffer({
            region: readbackSource.region(),
            mode: 'write',
        })
        const beforeBuffers = fake.calls.buffers.length
        await rejectedDiagnostic(
            readback.toBytes(),
            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
        )
        expect(fake.calls.buffers).to.have.length(beforeBuffers)
        expect(fake.calls.commandEncoders).to.have.length(0)
        readbackLease.dispose()
    })

    it('preflights resolved submissions before command encoder creation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({
            size: 16,
            usage: MAP_WRITE | COPY_SRC,
        })
        const target = await runtime.createBuffer({ size: 16, usage: COPY_DST })
        const initial = await runtime.mapBuffer({
            region: source.region(),
            mode: 'write',
        })
        initial.dispose()
        const copy = runtime.createCopyCommand({
            source: { region: source.region(), contentEpoch: 1 },
            target: target.region(),
            whenMissing: 'throw',
        })
        const lease = await runtime.mapBuffer({
            region: source.region(),
            mode: 'write',
        })

        thrownDiagnostic(
            () => runtime.submission().copy(copy).submit(),
            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
        )

        expect(fake.calls.commandEncoders).to.have.length(0)
        expect(fake.calls.queueSubmissions).to.have.length(0)
        lease.dispose()
    })

    it('blocks GPU use of arbitrary-usage mapped-at-creation buffers', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const { buffer, lease } = await runtime.createMappedBuffer({
            size: 16,
            usage: COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({ target: buffer.region() })

        thrownDiagnostic(
            () => runtime.submission().clear(clear).submit(),
            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
        )

        expect(fake.calls.commandEncoders).to.have.length(0)
        lease.dispose()
    })

    it('publishes a closed READ lease, bounded active facts, and no content production', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        buffer.gpuBuffer.data.set([ 1, 2, 3, 4 ], 8)
        const startingEpoch = buffer.contentEpoch
        const region = buffer.region({ offset: 8, size: 8 })
        const lease = await runtime.mapBuffer({ region, mode: 'read' })
        const view = lease.view

        expect(lease).to.be.instanceOf(scr.MappedBufferLease)
        expect(lease).to.include({
            buffer,
            region,
            mode: 'read',
            state: 'mapped',
            allocationVersion: buffer.allocationVersion,
            contentEpoch: startingEpoch,
        })
        expect([ ...new Uint8Array(view).slice(0, 4) ]).to.deep.equal([ 1, 2, 3, 4 ])
        expect(runtime.diagnostics.snapshot().bufferMappings.find(fact => fact.id === lease.id)).to.deep.include({
            id: lease.id,
            resourceId: buffer.id,
            offset: 8,
            size: 8,
            mode: 'read',
            state: 'mapped',
            allocationVersion: buffer.allocationVersion,
            contentEpoch: startingEpoch,
        })
        expect(runtime.diagnostics.snapshot().bufferMapping).to.deep.include({
            currentMappings: 1,
            currentSelectedBytes: 8,
        })
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)

        lease.dispose()
        lease.dispose()

        expect(lease.state).to.equal('released')
        expect(buffer.contentEpoch).to.equal(startingEpoch)
        expect(view.byteLength).to.equal(0)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(runtime.diagnostics.snapshot().bufferMapping.currentMappings).to.equal(0)
        expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
        expect(runtime.diagnostics.operations({ resourceId: buffer.id }).at(-1)).to.deep.include({
            kind: 'buffer-mapping',
            status: 'succeeded',
        })
    })

    it('commits WRITE bytes and advances contentEpoch exactly once on release', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({
            region: buffer.region({ offset: 8, size: 8 }),
            mode: 'write',
        })
        new Uint8Array(lease.view).set([ 9, 8, 7, 6 ])

        lease.dispose()
        lease.dispose()

        expect([ ...fake.calls.buffers.at(-1).data.slice(8, 12) ]).to.deep.equal([ 9, 8, 7, 6 ])
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
        expect(buffer.state).to.equal('ready')
        expect(buffer.allocationVersion).to.equal(1)
        expect(fake.calls.unmaps).to.have.length(1)
    })

    it('claims one O(1) authority before mapAsync and releases it after AbortSignal cancellation', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read', { deferMaps: true })
        const controller = new AbortController()
        const region = buffer.region({ size: 16 })
        const first = runtime.mapBuffer({ region, mode: 'read', signal: controller.signal })
        await settleMicrotasks()
        expect(fake.calls.maps).to.have.length(1)

        await rejectedDiagnostic(
            runtime.mapBuffer({ region, mode: 'read' }),
            'SCRATCH_BUFFER_MAPPING_CONFLICT'
        )
        expect(fake.calls.maps).to.have.length(1)

        controller.abort()
        const cancellation = await rejectedDiagnostic(
            first,
            'SCRATCH_BUFFER_MAPPING_ABORTED'
        )
        expect(cancellation.incident).to.deep.include({
            kind: 'buffer-mapping-failure',
            diagnosticCode: 'SCRATCH_BUFFER_MAPPING_ABORTED',
            failureStage: 'lifecycle-recheck',
        })
        expect(cancellation.incident.related).to.deep.include.members([
            buffer.subject,
            region.subject,
        ])
        const lifecycleOutcome = cancellation.incident.outcomes.find(
            outcome => outcome.diagnosticCode === 'SCRATCH_BUFFER_MAPPING_ABORTED'
        )
        expect(lifecycleOutcome).to.not.have.property('nativeError')
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])

        const second = runtime.mapBuffer({ region, mode: 'read' })
        await settleMicrotasks()
        fake.readbacks.resolveMap(1)
        const lease = await second
        lease.dispose()
        expect(fake.calls.maps).to.have.length(2)
    })

    it('treats a pre-aborted signal as cancellation without native mapping side effects', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        const controller = new AbortController()
        controller.abort()
        const beforeUnmaps = fake.calls.unmaps.length

        await rejectedDiagnostic(
            runtime.mapBuffer({
                region: buffer.region(),
                mode: 'read',
                signal: controller.signal,
            }),
            'SCRATCH_BUFFER_MAPPING_ABORTED'
        )

        expect(fake.calls.maps).to.have.length(0)
        expect(fake.calls.unmaps).to.have.length(beforeUnmaps)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('rejects invalid descriptors before native mapping side effects', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const read = await runtime.createBuffer({ size: 32, usage: MAP_READ | COPY_DST })
        const write = await runtime.createBuffer({ size: 32, usage: MAP_WRITE | COPY_SRC })
        const otherFake = createFakeGpu()
        const otherRuntime = await scr.ScratchRuntime.create({ gpu: otherFake.gpu })
        const other = await otherRuntime.createBuffer({ size: 32, usage: MAP_READ | COPY_DST })
        const before = fake.calls.maps.length
        const hostileSignal = {}
        Object.defineProperty(hostileSignal, 'aborted', {
            get() {

                throw new Error('hostile structural signal')
            },
        })

        const cases = [
            [ { region: read.region(), mode: 'invalid' }, 'SCRATCH_BUFFER_MAPPING_MODE_INVALID' ],
            [ { region: read.region({ offset: 4, size: 8 }), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID' ],
            [ { region: read.region({ offset: 8, size: 6 }), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID' ],
            [ { region: write.region(), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_USAGE_INVALID' ],
            [ { region: other.region(), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RUNTIME_MISMATCH' ],
            [ { region: read.region(), mode: 'read', signal: {} }, 'SCRATCH_BUFFER_MAPPING_SIGNAL_INVALID' ],
            [ { region: read.region(), mode: 'read', signal: hostileSignal }, 'SCRATCH_BUFFER_MAPPING_SIGNAL_INVALID' ],
        ]
        for (const [ descriptor, code ] of cases) {
            await rejectedDiagnostic(runtime.mapBuffer(descriptor), code)
        }

        expect(fake.calls.maps).to.have.length(before)
    })

    it('uses branded AbortSignal hooks instead of shadowable instance methods', async () => {

        const { runtime, buffer } = await createMappedFixture('read')
        const controller = new AbortController()
        Object.defineProperties(controller.signal, {
            addEventListener: {
                value() {

                    throw new Error('shadowed addEventListener')
                },
            },
            removeEventListener: {
                value() {

                    throw new Error('shadowed removeEventListener')
                },
            },
        })

        const lease = await runtime.mapBuffer({
            region: buffer.region(),
            mode: 'read',
            signal: controller.signal,
        })
        lease.dispose()

        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('joins map and error-scope settlement in arbitrary order without leaking authority', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read', {
            deferMaps: true,
            deferErrorScopePops: true,
        })
        const mapping = runtime.mapBuffer({ region: buffer.region({ size: 16 }), mode: 'read' })
        await settleMicrotasks()
        const mappingPops = fake.errors.pendingPops.slice(-3)
        expect(mappingPops.map(pop => pop.filter)).to.deep.equal([
            'validation',
            'internal',
            'out-of-memory',
        ])

        fake.readbacks.resolveMap(0)
        const pendingPops = fake.errors.pendingPops
        for (const index of [ pendingPops.length - 2, pendingPops.length - 3, pendingPops.length - 1 ]) {
            fake.errors.settlePop(index)
        }
        const lease = await mapping
        lease.dispose()

        expect(fake.errors.scopeDepth).to.equal(0)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    for (const scenario of [
        {
            filter: 'validation',
            code: 'SCRATCH_BUFFER_MAPPING_VALIDATION_FAILED',
            name: 'GPUValidationError',
        },
        {
            filter: 'internal',
            code: 'SCRATCH_BUFFER_MAPPING_INTERNAL_FAILED',
            name: 'GPUInternalError',
        },
        {
            filter: 'out-of-memory',
            code: 'SCRATCH_BUFFER_MAPPING_OUT_OF_MEMORY',
            name: 'GPUOutOfMemoryError',
        },
    ]) {
        it(`classifies captured ${scenario.filter} mapping failures`, async () => {

            const { fake, runtime, buffer } = await createMappedFixture('read')
            const nativeError = Object.assign(new Error(`opaque ${scenario.filter}`), {
                name: scenario.name,
            })
            const beforeAggregates = runtime.diagnostics.snapshot().aggregates
            fake.errors.failNext('mapAsync', scenario.filter, nativeError)

            const failure = await rejectedDiagnostic(
                runtime.mapBuffer({ region: buffer.region(), mode: 'read' }),
                scenario.code
            )

            expect(failure.incident).to.deep.include({
                kind: 'buffer-mapping-failure',
                failureStage: 'mapping',
                nativeErrorCategory: scenario.filter,
            })
            expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
            expect(runtime.diagnostics.snapshot().aggregates.allocationAttempts)
                .to.equal(beforeAggregates.allocationAttempts)
            expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
        })
    }

    it('retains concurrent scope evidence when AbortSignal cancels mapping', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read', {
            deferMaps: true,
        })
        const controller = new AbortController()
        fake.errors.failNext(
            'mapAsync',
            'validation',
            Object.assign(new Error('opaque validation'), { name: 'GPUValidationError' })
        )
        const mapping = runtime.mapBuffer({
            region: buffer.region({ size: 16 }),
            mode: 'read',
            signal: controller.signal,
        })
        await settleMicrotasks()

        controller.abort()
        const failure = await rejectedDiagnostic(
            mapping,
            'SCRATCH_BUFFER_MAPPING_ABORTED'
        )

        expect(failure.incident.outcomes.map(outcome => outcome.diagnosticCode))
            .to.include.members([
                'SCRATCH_BUFFER_MAPPING_ABORTED',
                'SCRATCH_BUFFER_MAPPING_VALIDATION_FAILED',
            ])
        expect(failure.incident.nativeErrorCategory).to.equal('validation')
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('records map Promise rejection and releases authority for a later mapping', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        fake.readbacks.rejectNextMap(new DOMException('opaque rejection', 'OperationError'))

        await rejectedDiagnostic(
            runtime.mapBuffer({ region: buffer.region(), mode: 'read' }),
            'SCRATCH_BUFFER_MAPPING_REJECTED'
        )
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])

        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'read' })
        lease.dispose()
        expect(fake.calls.maps).to.have.length(2)
    })

    it('attributes an otherwise unexplained map AbortError to device loss', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        fake.readbacks.rejectNextMap(
            new DOMException('mapping ended with the device', 'AbortError')
        )

        const failure = await rejectedDiagnostic(
            runtime.mapBuffer({ region: buffer.region(), mode: 'read' }),
            'SCRATCH_BUFFER_MAPPING_DEVICE_LOST'
        )

        expect(failure.incident).to.deep.include({
            diagnosticCode: 'SCRATCH_BUFFER_MAPPING_DEVICE_LOST',
            nativeErrorCategory: 'device-lost',
            failureStage: 'lifecycle-recheck',
        })
        expect(failure.incident.outcomes).to.have.length(1)
        expect(failure.incident.outcomes[0]).to.not.have.property('nativeError')
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('cleans an active lease once when its resource is disposed', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        const view = lease.view

        buffer.dispose()
        buffer.dispose()

        expect(lease.state).to.equal('disposed')
        expect(view.byteLength).to.equal(0)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(fake.calls.bufferDestroys).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
    })

    for (const scenario of [
        { name: 'READ', mode: 'read', mappedCreation: false },
        { name: 'WRITE', mode: 'write', mappedCreation: false },
        { name: 'mapped creation', mode: 'write', mappedCreation: true },
    ]) {
        it(`quarantines ${scenario.name} authority after native release fails`, async () => {

            let fake
            let runtime
            let buffer
            let lease
            let assertGpuUseBlocked
            if (scenario.mappedCreation) {
                fake = createFakeGpu()
                runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
                const creation = await runtime.createMappedBuffer({
                    size: 32,
                    usage: COPY_DST,
                })
                buffer = creation.buffer
                lease = creation.lease
                const clear = runtime.createClearBufferCommand({ target: buffer.region() })
                assertGpuUseBlocked = async () => {
                    thrownDiagnostic(
                        () => runtime.submission().clear(clear).submit(),
                        'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
                    )
                }
            } else {
                const fixture = await createMappedFixture(scenario.mode)
                fake = fixture.fake
                runtime = fixture.runtime
                buffer = fixture.buffer
                if (scenario.mode === 'write') {
                    const initial = await runtime.mapBuffer({
                        region: buffer.region(),
                        mode: 'write',
                    })
                    new Uint8Array(initial.view)[0] = 7
                    initial.dispose()
                    const readback = runtime.createReadback({ source: buffer.region() })
                    assertGpuUseBlocked = async () => {
                        await rejectedDiagnostic(
                            readback.toBytes(),
                            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
                        )
                    }
                } else {
                    const upload = runtime.createUploadCommand({
                        target: buffer.region(),
                        data: new Uint8Array(buffer.size),
                    })
                    assertGpuUseBlocked = async () => {
                        thrownDiagnostic(
                            () => upload.execute(runtime.queue),
                            'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
                        )
                    }
                }
                lease = await runtime.mapBuffer({
                    region: buffer.region(),
                    mode: scenario.mode,
                })
            }
            const startingEpoch = buffer.contentEpoch
            const view = lease.view
            if (scenario.mode === 'write') new Uint8Array(view)[0] = 42
            fake.errors.throwNext('unmap', new Error('opaque unmap failure'))

            const failure = thrownDiagnostic(
                () => lease.dispose(),
                'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED'
            )

            expect(lease.state).to.equal('failed')
            expect(view.byteLength).to.equal(32)
            if (scenario.mode === 'write') {
                expect(buffer.state).to.equal('indeterminate')
                expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
            } else {
                expect(buffer.contentEpoch).to.equal(startingEpoch)
            }
            expect(runtime.diagnostics.snapshot().bufferMappings).to.have.length(1)
            expect(runtime.diagnostics.snapshot().bufferMappings[0]).to.deep.include({
                id: lease.id,
                state: 'mapped',
            })
            if (!scenario.mappedCreation) {
                await rejectedDiagnostic(
                    runtime.mapBuffer({ region: buffer.region(), mode: scenario.mode }),
                    'SCRATCH_BUFFER_MAPPING_CONFLICT'
                )
            }

            const beforeQueueWrites = fake.calls.queueWrites.length
            const beforeEncoders = fake.calls.commandEncoders.length
            await assertGpuUseBlocked()
            expect(fake.calls.queueWrites).to.have.length(beforeQueueWrites)
            expect(fake.calls.commandEncoders).to.have.length(beforeEncoders)
            expect(failure.incident).to.deep.include({ failureStage: 'release' })

            buffer.dispose()

            expect(view.byteLength).to.equal(0)
            expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
            expect(fake.calls.bufferDestroys).to.have.length(1)
        })
    }

    it('cancels an active WRITE lease on device loss and preserves uncertainty', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        new Uint8Array(lease.view)[0] = 42

        fake.errors.loseDevice({ reason: 'unknown', message: 'opaque device loss' })
        await settleMicrotasks()

        expect(lease.state).to.equal('disposed')
        expect(buffer.state).to.equal('indeterminate')
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(runtime.diagnostics.operations({
            kind: 'buffer-mapping',
            resourceId: buffer.id,
        }).at(-1)).to.deep.include({
            status: 'cancelled',
            nativeErrorCategory: 'device-lost',
        })
    })

    it('reclassifies a just-released host WRITE when device loss settles later', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        new Uint8Array(lease.view)[0] = 42

        fake.errors.loseDevice({ reason: 'unknown', message: 'opaque device loss' })
        lease.dispose()

        expect(lease.state).to.equal('released')
        expect(buffer.state).to.equal('ready')
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)

        await settleMicrotasks()

        expect(buffer.state).to.equal('indeterminate')
        expect(buffer.contentEpoch).to.equal(startingEpoch + 2)
    })

    it('attributes pending and active mapping shutdown to runtime disposal', async () => {

        const pendingFixture = await createMappedFixture('read', { deferMaps: true })
        const pending = pendingFixture.runtime.mapBuffer({
            region: pendingFixture.buffer.region(),
            mode: 'read',
        })
        await settleMicrotasks()
        pendingFixture.runtime.dispose()
        const pendingFailure = await rejectedDiagnostic(
            pending,
            'SCRATCH_BUFFER_MAPPING_RUNTIME_DISPOSED'
        )

        expect(pendingFailure.incident).to.deep.include({
            diagnosticCode: 'SCRATCH_BUFFER_MAPPING_RUNTIME_DISPOSED',
            failureStage: 'lifecycle-recheck',
        })

        const activeFixture = await createMappedFixture('read')
        const activeLease = await activeFixture.runtime.mapBuffer({
            region: activeFixture.buffer.region(),
            mode: 'read',
        })
        activeFixture.runtime.dispose()

        expect(activeLease.state).to.equal('disposed')
        expect(activeFixture.runtime.diagnostics.incidents({
            kind: 'buffer-mapping-failure',
            resourceId: activeFixture.buffer.id,
        }).at(-1)).to.deep.include({
            diagnosticCode: 'SCRATCH_BUFFER_MAPPING_RUNTIME_DISPOSED',
            failureStage: 'lifecycle-recheck',
        })
    })

    it('prevents public construction and prototype forgery', async () => {

        const { runtime, buffer } = await createMappedFixture('read')
        expect(() => new scr.MappedBufferLease()).to.throw(TypeError)
        const forged = Object.create(scr.MappedBufferLease.prototype)
        expect(() => forged.view).to.throw(TypeError)

        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'read' })
        lease.dispose()
    })
})
