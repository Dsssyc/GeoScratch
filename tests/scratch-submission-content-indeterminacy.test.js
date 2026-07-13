import { expect } from 'chai'
import { ScratchDiagnosticError, ScratchRuntime } from 'geoscratch'
import { setResourceContentState } from '../packages/geoscratch/dist/scratch/resource.js'
import { createFakeCanvas, createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createFixture() {

    const fakeOptions = {
        deferErrorScopePops: false,
        deferSubmittedWorkDone: false,
    }
    const fake = createFakeGpu(fakeOptions)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    return { ...fake, fakeOptions, runtime }
}

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error
    }
}

function settlePendingScopes(fixture) {

    for (const [ index, pending ] of fixture.errors.pendingPops.entries()) {
        if (!pending.settled) fixture.errors.settlePop(index)
    }
}

function createUpload(runtime, target, value) {

    return runtime.createUploadCommand({
        target,
        data: new Uint32Array([ value, value, value, value ]),
    })
}

async function createComputePipeline(runtime) {

    const program = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    return await runtime.createComputePipeline({ program, compute: 'csMain' })
}

describe('scratch submission content indeterminacy', () => {

    it('marks a failed upload indeterminate without rolling back its epoch and lets a later upload recover', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const failedUpload = createUpload(fixture.runtime, target, 1)
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('writeBuffer', 'validation', new Error('delayed upload validation'))
        const failed = fixture.runtime.submission().upload(failedUpload).submit()

        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(1)
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => failed.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(target.state).to.equal('indeterminate')
        expect(target.contentEpoch).to.equal(1)
        expect(failed.resourceAccesses[0]).to.deep.include({
            resourceId: target.id,
            access: 'write',
            contentEpochAfter: 1,
        })
        expect(failed.producerEpochs[0].contentEpoch).to.equal(1)
        expect(failed.potentialWrites).to.deep.equal([ {
            kind: 'resource',
            resourceId: target.id,
            resourceKind: target.resourceKind,
            subject: target.subject,
            allocationVersion: 1,
            contentEpoch: 1,
        } ])
        expect(Object.isFrozen(failed.potentialWrites)).to.equal(true)
        expect(Object.isFrozen(failed.potentialWrites[0])).to.equal(true)
        expect(Object.isFrozen(failed.potentialWrites[0].subject)).to.equal(true)
        expect(JSON.parse(JSON.stringify(failed.potentialWrites))).to.deep.equal(failed.potentialWrites)
        expect(Object.getOwnPropertyNames(failed.potentialWrites[0])).not.to.include.members([
            'resource',
            'querySet',
            'gpuBuffer',
            'gpuTexture',
            'gpuQuerySet',
        ])

        fixture.fakeOptions.deferErrorScopePops = false
        const recovered = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 2))
            .submit()
        await recovered.done
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(2)
    })

    it('guards partial replay writes when a later queue action throws synchronously', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const copyTarget = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const copy = fixture.runtime.createCopyCommand({
            source: { resource: target, contentEpoch: 1 },
            target: copyTarget,
            byteLength: 16,
            whenMissing: 'throw',
        })
        const queueFailure = new Error('later queue submit throws')
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('writeBuffer', 'validation', new Error('partial upload validation'))
        fixture.errors.throwNext('submit', queueFailure)

        expect(() => fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .copy(copy)
            .submit()
        ).to.throw(queueFailure)
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(1)
        expect(copyTarget.state).to.equal('empty')
        expect(copyTarget.contentEpoch).to.equal(0)

        settlePendingScopes(fixture)
        for (let attempt = 0; attempt < 20 && target.state === 'ready'; attempt++) {
            await Promise.resolve()
        }

        expect(target.state).to.equal('indeterminate')
        expect(target.contentEpoch).to.equal(1)
        expect(copyTarget.state).to.equal('empty')
        expect(copyTarget.contentEpoch).to.equal(0)
        expect(fixture.runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations)
            .to.equal(0)
    })

    it('hard-rejects direct readback of indeterminate content before staging allocation', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('writeBuffer', 'validation', new Error('direct source validation'))
        const failed = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .submit()
        const readback = fixture.runtime.createReadback({ source: target })
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => failed.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(target.state).to.equal('indeterminate')
        fixture.fakeOptions.deferErrorScopePops = false
        const bufferCount = fixture.calls.buffers.length
        const encoderCount = fixture.calls.commandEncoders.length

        await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE',
            phase: 'readback',
        })
        expect(fixture.calls.buffers).to.have.length(bufferCount)
        expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        expect(readback.state).to.equal('failed')
    })

    it('does not let a delayed failure poison a later confirmed writer', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('writeBuffer', 'validation', new Error('late first upload failure'))
        const first = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .submit()

        fixture.fakeOptions.deferErrorScopePops = false
        const second = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 2))
            .submit()
        await second.done
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(2)

        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => first.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(2)
        expect((await first.nativeOutcome).status).to.equal('observed-failed')
    })

    it('marks a native failure before deferred queue completion settles', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.fakeOptions.deferSubmittedWorkDone = true
        fixture.errors.failNext('writeBuffer', 'validation', new Error('native failure before queue'))
        const submitted = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .submit()
        let doneSettled = false
        submitted.done.then(
            () => { doneSettled = true },
            () => { doneSettled = true }
        )

        settlePendingScopes(fixture)
        expect((await submitted.nativeOutcome).status).to.equal('observed-failed')
        expect(target.state).to.equal('indeterminate')
        expect(doneSettled).to.equal(false)

        fixture.readbacks.resolveQueueCompletion(0)
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
    })

    it('marks queue rejection before deferred native observation settles', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.readbacks.rejectNextQueueCompletion(new Error('queue failed before scopes'))
        const submitted = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .submit()

        await new Promise(resolve => setImmediate(resolve))
        expect(target.state).to.equal('indeterminate')
        expect(fixture.errors.pendingPops.some(pending => !pending.settled)).to.equal(true)

        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            phase: 'submission',
        })
    })

    it('marks current writes indeterminate when native scope settlement itself fails', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        fixture.fakeOptions.deferErrorScopePops = true
        const submitted = fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, target, 1))
            .submit()

        fixture.errors.rejectPop(0, new Error('submission validation scope settlement failed'))
        fixture.errors.settlePop(2)
        fixture.errors.settlePop(1)
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED',
            phase: 'submission',
        })
        expect((await submitted.nativeOutcome).status).to.equal('observation-failed')
        expect(target.state).to.equal('indeterminate')
        expect(target.contentEpoch).to.equal(1)
    })

    it('does not poison a replacement texture allocation that preserves the old epoch', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createTexture({
            size: { width: 1, height: 1 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const upload = fixture.runtime.createTextureUploadCommand({
            target,
            data: new Uint8Array([ 1, 2, 3, 4 ]),
            layout: { bytesPerRow: 4, rowsPerImage: 1 },
            size: { width: 1, height: 1 },
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('writeTexture', 'validation', new Error('old allocation upload failure'))
        const submitted = fixture.runtime.submission().upload(upload).submit()
        expect(target.contentEpoch).to.equal(1)
        expect(target.allocationVersion).to.equal(1)

        fixture.fakeOptions.deferErrorScopePops = false
        await target.resize({ width: 2, height: 2 })
        expect(target.state).to.equal('empty')
        expect(target.contentEpoch).to.equal(1)
        expect(target.allocationVersion).to.equal(2)

        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(target.state).to.equal('empty')
        expect(target.contentEpoch).to.equal(1)
        expect(target.allocationVersion).to.equal(2)
    })

    it('marks only the copy target indeterminate after queue completion rejection', async () => {

        const fixture = await createFixture()
        const source = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const target = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        await fixture.runtime.submission()
            .upload(createUpload(fixture.runtime, source, 7))
            .submit().done
        const copy = fixture.runtime.createCopyCommand({
            source: { resource: source, contentEpoch: 1 },
            target,
            byteLength: 16,
            whenMissing: 'throw',
        })
        fixture.readbacks.rejectNextQueueCompletion(new Error('copy queue completion rejected'))
        const submitted = fixture.runtime.submission().copy(copy).submit()

        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED',
            phase: 'submission',
        })
        expect(source.state).to.equal('ready')
        expect(source.contentEpoch).to.equal(1)
        expect(target.state).to.equal('indeterminate')
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.potentialWrites.map(write => write.resourceId)).to.deep.equal([ target.id ])
    })

    it('hard-rejects indeterminate command reads in every validation and readiness mode', async () => {

        const fixture = await createFixture()
        const input = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE,
        })
        setResourceContentState(input, 'indeterminate', 1)
        const pipeline = await createComputePipeline(fixture.runtime)
        const pass = fixture.runtime.createComputePass()
        const fallback = fixture.runtime.createDispatchCommand({
            pipeline,
            count: { workgroups: [ 1 ] },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const policies = [ 'throw', 'skip-command', 'skip-pass', 'use-fallback' ]

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            for (const policy of policies) {
                const command = fixture.runtime.createDispatchCommand({
                    pipeline,
                    count: { workgroups: [ 1 ] },
                    resources: {
                        read: [ { resource: input, contentEpoch: 1 } ],
                        write: [],
                    },
                    whenMissing: policy,
                    ...(policy === 'use-fallback' ? { fallback } : {}),
                })
                const encoderCount = fixture.calls.commandEncoders.length
                const error = await expectScratchDiagnostic(
                    () => fixture.runtime.submission({ validation })
                        .compute(pass, [ command ])
                        .submit(),
                    {
                        code: 'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
                        phase: 'command',
                    }
                )
                expect(error.diagnostic.actual).to.deep.include({
                    commandId: command.id,
                    resourceId: input.id,
                    resourceState: 'indeterminate',
                    contentEpoch: 1,
                    whenMissing: policy,
                    validation,
                })
                expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
            }
        }
    })

    it('allows an explicit same-submission producer to recover before an indeterminate read', async () => {

        const fixture = await createFixture()
        const input = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
        })
        setResourceContentState(input, 'indeterminate', 1)
        const pipeline = await createComputePipeline(fixture.runtime)
        const pass = fixture.runtime.createComputePass()
        const consumer = fixture.runtime.createDispatchCommand({
            pipeline,
            count: { workgroups: [ 1 ] },
            resources: {
                read: [ { resource: input, contentEpoch: 2 } ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const submitted = fixture.runtime.submission({ validation: 'throw' })
            .upload(createUpload(fixture.runtime, input, 3))
            .compute(pass, [ consumer ])
            .submit()
        await submitted.done
        expect(input.state).to.equal('ready')
        expect(input.contentEpoch).to.equal(2)
    })

    it('hard-rejects an ordered readback of indeterminate content before encoder effects', async () => {

        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const fixture = await createFixture()
            const source = await fixture.runtime.createBuffer({
                size: 16,
                usage: GPU_BUFFER_USAGE_COPY_SRC,
            })
            setResourceContentState(source, 'indeterminate', 1)
            const command = await fixture.runtime.createReadbackCommand({
                source: { resource: source, contentEpoch: 1 },
                whenMissing: 'throw',
            })
            const encoderCount = fixture.calls.commandEncoders.length

            await expectScratchDiagnostic(
                () => fixture.runtime.submission({ validation }).readback(command).submit(),
                {
                    code: 'SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE',
                    phase: 'command',
                }
            )
            expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
            expect(fixture.calls.queueSubmissions).to.have.length(0)
        }
    })

    it('tracks compute writes and timestamp slots, rejects slot reads, and recovers with later producers', async () => {

        const fixture = await createFixture()
        const output = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
        })
        const destination = await fixture.runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
        })
        const querySet = fixture.runtime.createQuerySet({ type: 'timestamp', count: 2 })
        const pipeline = await createComputePipeline(fixture.runtime)
        const dispatch = fixture.runtime.createDispatchCommand({
            pipeline,
            count: { workgroups: [ 1 ] },
            resources: { read: [], write: [ output ] },
            whenMissing: 'throw',
        })
        const pass = fixture.runtime.createComputePass({
            timestampWrites: { querySet, begin: 0, end: 1 },
        })

        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('beginComputePass', 'validation', new Error('compute pass validation'))
        const failed = fixture.runtime.submission().compute(pass, [ dispatch ]).submit()
        expect(output.state).to.equal('ready')
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'ready', 'ready' ])
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => failed.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(output.state).to.equal('indeterminate')
        expect(output.contentEpoch).to.equal(1)
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'indeterminate', 'indeterminate' ])
        expect(querySet.slots().map(slot => slot.contentEpoch)).to.deep.equal([ 1, 1 ])
        expect(failed.potentialWrites.map(write => write.kind)).to.deep.equal([
            'resource',
            'query-slot',
            'query-slot',
        ])
        expect(failed.potentialWrites.filter(write => write.kind === 'query-slot'))
            .to.deep.include.members([
                {
                    kind: 'query-slot',
                    querySetId: querySet.id,
                    queryType: 'timestamp',
                    subject: querySet.subject,
                    index: 0,
                    allocationVersion: 1,
                    contentEpoch: 1,
                },
                {
                    kind: 'query-slot',
                    querySetId: querySet.id,
                    queryType: 'timestamp',
                    subject: querySet.subject,
                    index: 1,
                    allocationVersion: 1,
                    contentEpoch: 1,
                },
            ])

        const resolveEpochOne = fixture.runtime.createResolveQuerySetCommand({
            source: { querySet, slots: [ { index: 0, contentEpoch: 1 } ] },
            destination,
            whenMissing: 'throw',
        })
        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const encoderCount = fixture.calls.commandEncoders.length
            await expectScratchDiagnostic(
                () => fixture.runtime.submission({ validation }).resolve(resolveEpochOne).submit(),
                {
                    code: 'SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE',
                    phase: 'query',
                }
            )
            expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        }

        fixture.fakeOptions.deferErrorScopePops = false
        const recovered = fixture.runtime.submission().compute(pass, [ dispatch ]).submit()
        await recovered.done
        expect(output.state).to.equal('ready')
        expect(output.contentEpoch).to.equal(2)
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'ready', 'ready' ])
        expect(querySet.slots().map(slot => slot.contentEpoch)).to.deep.equal([ 2, 2 ])

        const resolveEpochTwo = fixture.runtime.createResolveQuerySetCommand({
            source: { querySet, slots: [ { index: 0, contentEpoch: 2 } ] },
            destination,
            whenMissing: 'throw',
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('resolveQuerySet', 'validation', new Error('resolve validation'))
        const failedResolve = fixture.runtime.submission().resolve(resolveEpochTwo).submit()
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => failedResolve.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(destination.state).to.equal('indeterminate')
        expect(destination.contentEpoch).to.equal(1)
    })

    it('tracks render attachments and occlusion slots and rejects indeterminate attachment loads', async () => {

        const fixture = await createFixture()
        const target = await fixture.runtime.createTexture({
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const querySet = fixture.runtime.createQuerySet({ type: 'occlusion', count: 1 })
        const clearPass = fixture.runtime.createRenderPass({
            color: [ { target, load: 'clear', store: 'store' } ],
            occlusionQuerySet: querySet,
        })
        const begin = fixture.runtime.createBeginOcclusionQueryCommand({ querySet, index: 0 })
        const end = fixture.runtime.createEndOcclusionQueryCommand()

        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('beginRenderPass', 'validation', new Error('render pass validation'))
        const failed = fixture.runtime.submission().render(clearPass, [ begin, end ]).submit()
        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => failed.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(target.state).to.equal('indeterminate')
        expect(target.contentEpoch).to.equal(1)
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'indeterminate' ])
        expect(querySet.slots().map(slot => slot.contentEpoch)).to.deep.equal([ 1 ])
        expect(failed.potentialWrites.map(write => write.kind)).to.deep.equal([
            'resource',
            'query-slot',
        ])

        const loadPass = fixture.runtime.createRenderPass({
            color: [ { target, load: 'load', store: 'store' } ],
        })
        for (const validation of [ 'throw', 'warn', 'off' ]) {
            const encoderCount = fixture.calls.commandEncoders.length
            await expectScratchDiagnostic(
                () => fixture.runtime.submission({ validation }).render(loadPass, []).submit(),
                {
                    code: 'SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE',
                    phase: 'submission',
                }
            )
            expect(fixture.calls.commandEncoders).to.have.length(encoderCount)
        }

        fixture.fakeOptions.deferErrorScopePops = false
        const recovered = fixture.runtime.submission().render(clearPass, [ begin, end ]).submit()
        await recovered.done
        expect(target.state).to.equal('ready')
        expect(target.contentEpoch).to.equal(2)
        expect(querySet.slots().map(slot => slot.state)).to.deep.equal([ 'ready' ])
        expect(querySet.slots().map(slot => slot.contentEpoch)).to.deep.equal([ 2 ])
    })

    it('keeps ephemeral surface output out of persistent potential-write facts', async () => {

        const fixture = await createFixture()
        const canvas = createFakeCanvas()
        const surface = fixture.runtime.createSurface(canvas.canvas, {
            format: 'bgra8unorm',
            size: { width: 2, height: 2 },
        })
        const pass = fixture.runtime.createRenderPass({
            color: [ {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        fixture.fakeOptions.deferErrorScopePops = true
        fixture.errors.failNext('beginRenderPass', 'validation', new Error('surface pass failure'))
        const submitted = fixture.runtime.submission().render(pass, []).submit()

        settlePendingScopes(fixture)
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            phase: 'submission',
        })
        expect(submitted.potentialWrites).to.deep.equal([])
    })
})
