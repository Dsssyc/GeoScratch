import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import { GPURuntime } from 'geoscratch/scratch'
import { createFlowSpawnIndex, prepareFlowSpawnCandidates } from '../examples/flowField/flow-spawn-index.ts'

describe('Flow Field observed endpoint-union spawn cache', () => {
    let originalFetch
    let originalUsage
    before(() => {
        originalFetch = globalThis.fetch
        originalUsage = globalThis.GPUBufferUsage
        globalThis.GPUBufferUsage = { COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
        globalThis.fetch = async url => new Response(await readFile(url, 'utf8'))
    })
    after(() => {
        globalThis.fetch = originalFetch
        if (originalUsage === undefined) delete globalThis.GPUBufferUsage
        else globalThis.GPUBufferUsage = originalUsage
    })

    it('reuses observed union support for alpha changes and equal replacement bytes', async() => {
        const context = await fixture()
        try {
            const first = context.encode()
            expect(first.frame.built).to.equal(true)
            await context.index.observe(first.frame, context.submit(first.builder))
            const second = context.encode({ progress: 0.75 })
            expect(second.frame).to.include({ built: false, reused: true, buildRevision: 1 })
            expect(second.builder.operations).to.have.length(0)
            await context.index.observe(second.frame, context.submit(second.builder))
            const third = context.encode({ bytes: context.bytes.slice(), progress: 0.9 })
            expect(third.frame.reused).to.equal(true)
            expect(context.index.facts()).to.include({ buildCount: 1, cacheHitCount: 2, cacheState: 'ready' })
        } finally { context.index.dispose() }
    })

    it('compares mutable bytes, including unaligned views, without relying on identity', async() => {
        const context = await fixture()
        try {
            const first = context.encode()
            await context.index.observe(first.frame, context.submit(first.builder))
            context.bytes[0] ^= 1
            const changed = context.encode()
            expect(changed.frame.built).to.equal(true)
            await context.index.observe(changed.frame, context.submit(changed.builder))
            const unaligned = new Uint8Array(context.bytes.byteLength + 1).subarray(1)
            unaligned.set(context.bytes)
            expect(context.encode({ bytes: unaligned }).frame.reused).to.equal(true)
            unaligned[31] ^= 1
            expect(context.encode({ bytes: unaligned }).frame.built).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('owns prepared bytes and reuses their observed identity without scanning', async() => {
        const context = await fixture()
        try {
            const prepared = prepareFlowSpawnCandidates(context.bytes)
            expect(Object.isFrozen(prepared)).to.equal(true)
            const first = context.encode({ bytes: prepared })
            await context.index.observe(first.frame, context.submit(first.builder))
            context.bytes[0] ^= 1
            for (let index = 0; index < 100; index++) {
                const next = context.encode({ bytes: prepared, progress: index / 100 })
                expect(next.frame.reused).to.equal(true)
                await context.index.observe(next.frame, context.submit(next.builder))
            }
            expect(context.index.facts()).to.include({ buildCount: 1, candidateComparisonCount: 0 })
            // A changed raw source remains detectable; preparation did not borrow it.
            expect(context.encode().frame.built).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('compares an equal replacement artifact once before promoting its identity', async() => {
        const context = await fixture()
        try {
            const first = context.encode({ bytes: prepareFlowSpawnCandidates(context.bytes) })
            await context.index.observe(first.frame, context.submit(first.builder))
            const replacement = prepareFlowSpawnCandidates(context.bytes)
            expect(context.encode({ bytes: replacement }).frame.reused).to.equal(true)
            expect(context.encode({ bytes: replacement }).frame.reused).to.equal(true)
            expect(context.index.facts().candidateComparisonCount).to.equal(1)
            expect(() => context.encode({ bytes: { ...replacement } })).to.throw('bounded record count')
            context.index.resources.output.buffer.contentEpoch++
            expect(context.encode({ bytes: replacement }).frame.built).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('never promotes a prepared identity before its native build succeeds', async() => {
        const context = await fixture()
        try {
            const bytes = prepareFlowSpawnCandidates(context.bytes)
            context.encode({ bytes })
            const next = context.encode({ bytes })
            expect(next.frame.built).to.equal(true)
            await expectRejected(context.index.observe(next.frame, context.submit(next.builder, {
                nativeOutcome: Promise.resolve({ status: 'observed-failed' }),
            })), 'observed-failed')
            expect(context.encode({ bytes }).frame.built).to.equal(true)
        } finally { context.index.dispose() }
        expect(() => prepareFlowSpawnCandidates(new Uint8Array(33))).to.throw('complete packed records')
    })

    it('invalidates on either publication, pair identity, bind set, or candidate count', async() => {
        const context = await fixture()
        try {
            let options = {}
            for (const update of [{}, { currentSnapshotEpoch: 2 }, { nextSnapshotEpoch: 3 },
                { generation: 2 }, { bindSet: { runtime: context.runtime, layout: context.layout } },
                { bytes: new Uint8Array(32) }]) {
                options = { ...options, ...update }
                const value = context.encode(options)
                expect(value.frame.built).to.equal(true)
                await context.index.observe(value.frame, context.submit(value.builder))
            }
            expect(context.index.facts().buildCount).to.equal(6)
        } finally { context.index.dispose() }
    })

    it('does not reuse an unsubmitted build or accept an unrelated native receipt', async() => {
        const context = await fixture()
        try {
            const abandoned = context.encode()
            const next = context.encode()
            expect(next.frame).to.include({ built: true, buildRevision: 2 })
            expect(next.builder.operations.filter(value => value.kind === 'clear')).to.have.length(3)
            const receipt = context.submit(next.builder)
            await expectRejected(context.index.observe(abandoned.frame, receipt), 'did not execute')
            expect(context.index.facts().cacheState).to.equal('encoded')
            await context.index.observe(next.frame, receipt)
            expect(context.encode().frame.reused).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('invalidates failed native work and rejects cache hits while observation is pending', async() => {
        const context = await fixture()
        try {
            const first = context.encode()
            let settle
            const nativeOutcome = new Promise(resolve => { settle = resolve })
            const receipt = context.submit(first.builder, { nativeOutcome })
            const observing = context.index.observe(first.frame, receipt)
            expect(context.index.observe(first.frame, receipt)).to.equal(observing)
            expect(() => context.encode()).to.throw('previous observation to settle')
            settle({ status: 'observed-failed' })
            await expectRejected(observing, 'observed-failed')
            expect(context.index.facts().cacheState).to.equal('failed')
            const retry = context.encode()
            expect(retry.frame.built).to.equal(true)
            await context.index.observe(retry.frame, context.submit(retry.builder))
            expect(context.encode().frame.reused).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('rejects output ownership replacement and ignores obsolete successful tickets', async() => {
        const context = await fixture()
        try {
            const first = context.encode()
            const oldReceipt = context.submit(first.builder)
            const next = context.encode()
            await context.index.observe(first.frame, oldReceipt)
            expect(context.index.facts().cacheState).to.equal('encoded')
            const receipt = context.submit(next.builder)
            receipt.producerEpochs.findLast(value => value.resourceId === context.index.resources.output.buffer.id)
                .producedBy.commandId = 'foreign-write'
            await expectRejected(context.index.observe(next.frame, receipt), 'publication ownership')
            const retry = context.encode()
            await context.index.observe(retry.frame, context.submit(retry.builder))
            context.index.resources.output.buffer.contentEpoch++
            expect(context.encode().frame.built).to.equal(true)
        } finally { context.index.dispose() }
    })

    it('retains current temporal validation on cache hits and proves worst-case capacity', async() => {
        const context = await fixture({ maximumCandidateCount: 4, capacity: 2 })
        try {
            const first = context.encode()
            await context.index.observe(first.frame, context.submit(first.builder))
            expect(() => context.encode({ frameProgress: 0.2 })).to.throw('progress is stale')
            expect(() => context.encode({ bytes: new Uint8Array(3 * 32) })).to.throw('without truncation')
            expect(() => context.index.observe({ ...first.frame }, context.submit(first.builder)))
                .to.throw('owned frame')
        } finally { context.index.dispose() }
        for (const subcellSide of [1, 2, 4]) {
            const configured = await fixture({ subcellSide })
            expect(configured.index.facts().subcellSide).to.equal(subcellSide)
            configured.index.dispose()
        }
        await expectRejected(fixture({ subcellSide: 3 }), 'subcellSide')
    })
})

async function expectRejected(promise, message) {
    try { await promise } catch (error) {
        expect(error.message).to.include(message)
        return
    }
    throw new Error(`Expected rejection containing ${message}`)
}

async function fixture(options = {}) {
    const runtime = Object.create(GPURuntime.prototype)
    let nextId = 0
    const value = descriptor => ({ ...descriptor, id: `fake-${++nextId}`, runtime, dispose() {} })
    runtime.createBuffer = async descriptor => {
        const buffer = value({ ...descriptor, contentEpoch: 0, allocationVersion: 1 })
        buffer.region = input => ({ buffer, size: buffer.size, ...input })
        return buffer
    }
    for (const name of ['createBindLayout', 'createBindSet', 'createShaderModule', 'createComputePipeline']) {
        runtime[name] = async descriptor => value(descriptor)
    }
    for (const name of ['createUploadCommand', 'createClearBufferCommand', 'createProgram',
        'createComputePass', 'createDispatchCommand']) runtime[name] = descriptor => value(descriptor)
    const layout = { runtime, group: 1 }
    const bindSet = { runtime, layout }
    const resources = Array.from({ length: 4 }, () => value({ contentEpoch: 1, allocationVersion: 1 }))
    const index = await createFlowSpawnIndex({ runtime, maximumCandidateCount: 2, capacity: 2,
        temporal: { layout, module: { kind: 'temporal-velocity-wgsl-module',
            code: 'fn FlowVelocity_sample(', bindings: { group: 1 } } }, ...options })
    const bytes = new Uint8Array(64)
    function encode(changes = {}) {
        const snapshot = { generation: 1, currentSnapshotEpoch: 1, nextSnapshotEpoch: 1,
            progress: 0, activitySpawn: 0.002, activityKill: 0.001, ...changes }
        const builder = { runtime, operations: [],
            upload(command) { this.operations.push({ kind: 'upload', command }) },
            clear(command) { this.operations.push({ kind: 'clear', command }) },
            compute(_pass, commands) { this.operations.push({ kind: 'compute', command: commands[0] }) },
        }
        const data = changes.bytes ?? bytes
        const frame = index.encode(builder, data, data.byteLength / 32, snapshot, {
            state: 'ready', bindSet: changes.bindSet ?? bindSet, resources,
            requestedRevision: 1, pairGeneration: snapshot.generation, requestedLevel: 0,
            progress: changes.frameProgress ?? snapshot.progress,
        })
        return { builder, frame }
    }
    function submit(builder, options = {}) {
        const producers = []
        const executionOutcomes = []
        for (const { kind, command } of builder.operations) {
            const writes = kind === 'compute' ? command.resources.write : [command.target.buffer]
            for (const resource of writes) {
                resource.contentEpoch++
                producers.push({ resourceId: resource.id, contentEpoch: resource.contentEpoch,
                    allocationVersion: resource.allocationVersion, producedBy: { commandId: command.id } })
            }
            if (kind === 'compute') executionOutcomes.push({ outcomeKind: 'command', status: 'executed',
                executedCommandId: command.id })
        }
        return { runtime, id: `submission-${++nextId}`, executionOutcomes,
            // Native SubmittedWork includes every write, including prior clears.
            producerEpochs: producers, done: Promise.resolve(),
            nativeOutcome: Promise.resolve({ status: builder.operations.length ? 'observed-succeeded' : 'no-native-work' }),
            ...options }
    }
    return { runtime, layout, index, bytes, encode, submit }
}
