import { expect } from 'chai'
import {
    createGpuIncidentReport,
    createGpuOperationRecord,
    serializeNativeGpuError,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import {
    diagnosticsControllerFor,
} from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { ScratchRuntime } from '../packages/geoscratch/dist/scratch/runtime.js'
import { BufferResource } from '../packages/geoscratch/dist/scratch/buffer.js'
import { TextureResource } from '../packages/geoscratch/dist/scratch/texture.js'
import { ScratchDiagnosticError } from '../packages/geoscratch/dist/scratch/diagnostics.js'
import { createFakeGpu } from './scratch-test-utils.js'

describe('scratch GPU operation provenance facts', () => {

    it('creates deeply immutable JSON operation records from bounded fields', () => {

        const gpuBuffer = { type: 'buffer', destroy() {} }
        const record = createGpuOperationRecord({
            sequence: 7,
            id: 'gpu-operation-7',
            kind: 'buffer-allocation',
            status: 'succeeded',
            runtimeId: 'scratch-runtime-1',
            resourceId: 'scratch-resource-1',
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 4096,
            descriptor: {
                hash: 'buffer-4096-12',
                summary: { size: 4096, usage: 12 },
            },
            nativeLabel: 'vertices [scratch:scratch-resource-1]',
            // Unknown fields must never leak mutable native handles.
            gpuBuffer,
        })

        expect(record).to.deep.equal({
            version: 1,
            sequence: 7,
            id: 'gpu-operation-7',
            kind: 'buffer-allocation',
            status: 'succeeded',
            runtimeId: 'scratch-runtime-1',
            resourceId: 'scratch-resource-1',
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 4096,
            descriptor: {
                hash: 'buffer-4096-12',
                summary: { size: 4096, usage: 12 },
            },
            nativeLabel: 'vertices [scratch:scratch-resource-1]',
        })
        expect(Object.isFrozen(record)).to.equal(true)
        expect(Object.isFrozen(record.descriptor)).to.equal(true)
        expect(Object.isFrozen(record.descriptor.summary)).to.equal(true)
        expect(JSON.parse(JSON.stringify(record))).to.deep.equal(record)
        expect(JSON.stringify(record)).not.to.include('destroy')
        expect(record).not.to.have.property('gpuBuffer')
    })

    it('freezes bounded incident evidence without overstating OOM causality', () => {

        const triggerOperation = createGpuOperationRecord({
            sequence: 8,
            id: 'gpu-operation-8',
            kind: 'texture-allocation',
            status: 'failed',
            runtimeId: 'scratch-runtime-1',
            resourceId: 'scratch-resource-2',
            resourceKind: 'TextureResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 16_777_216,
            descriptor: {
                hash: 'texture-1024',
                summary: { width: 1024, height: 1024, format: 'rgba8unorm' },
            },
        })
        const report = createGpuIncidentReport({
            sequence: 3,
            id: 'gpu-incident-3',
            kind: 'allocation-failure',
            diagnosticCode: 'SCRATCH_TEXTURE_ALLOCATION_OUT_OF_MEMORY',
            nativeErrorCategory: 'out-of-memory',
            attribution: 'exact-operation',
            runtimeId: 'scratch-runtime-1',
            resourceId: 'scratch-resource-2',
            operationId: triggerOperation.id,
            triggerOperation,
            nativeError: { name: 'GPUOutOfMemoryError', message: 'allocation failed' },
            recentOperations: [ triggerOperation ],
            pressure: {
                triggerLogicalFootprintBytes: 16_777_216,
                currentScratchLogicalFootprintBytes: 4_096,
                peakScratchLogicalFootprintBytes: 8_192,
                liveResourceCounts: { BufferResource: 1, TextureResource: 0 },
                largestContributors: [ {
                    resourceId: 'scratch-resource-1',
                    resourceKind: 'BufferResource',
                    logicalFootprintBytes: 4_096,
                } ],
                recentChurn: [],
                caveats: [
                    'Scratch observes only Scratch-owned logical allocations.',
                    'Logical footprint is not physical GPU residency.',
                    'The triggering operation is not necessarily the sole OOM cause.',
                    'Browser, driver, tab, process, and system allocations are unknown.',
                ],
            },
            evidence: {
                complete: false,
                overwrittenOperations: 2,
                overwrittenIncidents: 0,
                omittedRecords: 1,
            },
        })

        expect(report.operationId).to.equal(triggerOperation.id)
        expect(report.attribution).to.equal('exact-operation')
        expect(report.pressure).to.have.property('largestContributors').with.length(1)
        expect(report.pressure).not.to.have.property('rootCause')
        expect(Object.isFrozen(report)).to.equal(true)
        expect(Object.isFrozen(report.recentOperations)).to.equal(true)
        expect(Object.isFrozen(report.pressure.largestContributors[0])).to.equal(true)
        expect(JSON.parse(JSON.stringify(report))).to.deep.equal(report)
    })

    it('serializes native error facts without retaining stack or custom handles', () => {

        const error = new Error('native validation text')
        error.name = 'GPUValidationError'
        error.gpuTexture = { destroy() {} }

        expect(serializeNativeGpuError(error)).to.deep.equal({
            name: 'GPUValidationError',
            message: 'native validation text',
        })
        expect(serializeNativeGpuError('plain failure')).to.deep.equal({
            message: 'plain failure',
        })
    })
})

describe('fake WebGPU error scopes', () => {

    it('captures an issued error in the innermost matching scope', async () => {

        const { device, errors, calls } = createFakeGpu()
        const validationError = Object.assign(new Error('invalid buffer'), {
            name: 'GPUValidationError',
        })

        device.pushErrorScope('validation')
        device.pushErrorScope('out-of-memory')
        device.pushErrorScope('validation')
        errors.failNext('createBuffer', 'validation', validationError)
        device.createBuffer({ size: 4, usage: 1 })

        const innerValidation = device.popErrorScope()
        const outOfMemory = device.popErrorScope()
        const outerValidation = device.popErrorScope()

        expect(await innerValidation).to.equal(validationError)
        expect(await outOfMemory).to.equal(null)
        expect(await outerValidation).to.equal(null)
        expect(calls.errorScopes.map(call => `${call.action}:${call.filter}`)).to.deep.equal([
            'push:validation',
            'push:out-of-memory',
            'push:validation',
            'pop:validation',
            'pop:out-of-memory',
            'pop:validation',
        ])
    })

    it('lets popped scope promises settle out of order without changing ownership', async () => {

        const { device, errors } = createFakeGpu({ deferErrorScopePops: true })
        const oom = Object.assign(new Error('oom'), { name: 'GPUOutOfMemoryError' })

        device.pushErrorScope('out-of-memory')
        device.pushErrorScope('validation')
        errors.failNext('createTexture', 'out-of-memory', oom)
        device.createTexture({
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 1,
        })

        const validationResult = device.popErrorScope()
        const oomResult = device.popErrorScope()
        errors.settlePop(1)
        errors.settlePop(0)

        expect(await oomResult).to.equal(oom)
        expect(await validationResult).to.equal(null)
    })
})

describe('ScratchRuntime bounded GPU diagnostics', () => {

    it('exposes a readonly immutable current fact graph without GPU handles', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu, label: 'facts runtime' })
        const buffer = await runtime.createBuffer({
            label: 'facts buffer',
            size: 64,
            usage: 1,
        })

        const snapshot = runtime.diagnostics.snapshot()
        const descriptor = Object.getOwnPropertyDescriptor(runtime, 'diagnostics')

        expect(descriptor).to.include({ writable: false, configurable: false })
        expect(snapshot.runtime).to.deep.include({
            id: runtime.id,
            label: 'facts runtime',
            isDisposed: false,
            isDeviceLost: false,
        })
        expect(snapshot.resources).to.have.length(1)
        expect(snapshot.resources[0]).to.deep.include({
            id: buffer.id,
            resourceKind: 'BufferResource',
            logicalFootprintBytes: 64,
            allocationVersion: 1,
            contentEpoch: 0,
            state: 'empty',
        })
        expect(snapshot.pressure).to.deep.include({
            currentScratchLogicalFootprintBytes: 64,
            peakScratchLogicalFootprintBytes: 64,
        })
        expect(Object.isFrozen(snapshot)).to.equal(true)
        expect(Object.isFrozen(snapshot.resources)).to.equal(true)
        expect(JSON.parse(JSON.stringify(snapshot))).to.deep.equal(snapshot)
        expect(JSON.stringify(snapshot)).not.to.include('gpuBuffer')
        expect(snapshot.runtime).not.to.have.property('device')
        expect(JSON.stringify(snapshot)).not.to.include('"type":"buffer"')

        buffer.dispose()
        expect(runtime.diagnostics.snapshot().resources).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pressure.currentScratchLogicalFootprintBytes).to.equal(0)
    })

    it('bounds operation records, evidence bytes, and monotonic sequence facts', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu,
            diagnostics: {
                operationCapacity: 3,
                incidentCapacity: 2,
                evidenceByteCapacity: 2_048,
            },
        })
        const controller = diagnosticsControllerFor(runtime)

        for (let index = 0; index < 10; index++) {
            const operation = controller.beginOperation(operationInput(index))
            controller.completeOperation(operation, { status: 'succeeded' })
        }

        const firstSnapshot = runtime.diagnostics.snapshot()
        const firstRecords = runtime.diagnostics.operations()
        expect(firstRecords).to.have.length(3)
        expect(firstRecords.map(record => record.sequence)).to.deep.equal([ 8, 9, 10 ])
        expect(firstSnapshot.recorder.overwrittenOperations).to.equal(7)
        expect(firstSnapshot.recorder.retainedEvidenceBytes).to.be.at.most(2_048)
        expect(firstSnapshot.pendingOperations).to.have.length(0)
        expect(firstRecords.every(record => record.stack === undefined)).to.equal(true)
        expect(firstRecords.every(record => record.descriptor.full === undefined)).to.equal(true)

        for (let index = 10; index < 20; index++) {
            const operation = controller.beginOperation(operationInput(index))
            controller.completeOperation(operation, { status: 'succeeded' })
        }

        const secondSnapshot = runtime.diagnostics.snapshot()
        expect(runtime.diagnostics.operations()).to.have.length(3)
        expect(secondSnapshot.recorder.retainedEvidenceBytes).to.be.at.most(2_048)
        expect(secondSnapshot.recorder.overwrittenOperations).to.equal(17)
        expect(secondSnapshot.aggregates.allocationAttempts).to.equal(20)
        expect(secondSnapshot.aggregates.successfulAllocations).to.equal(20)
    })

    it('releases successful pending detail after settlement', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const operation = controller.beginOperation(operationInput(0))

        const pendingSnapshot = runtime.diagnostics.snapshot()
        expect(pendingSnapshot.pendingOperations).to.have.length(1)
        expect(pendingSnapshot.pendingOperations[0]).to.deep.include({
            id: operation.id,
            resourceId: 'candidate-buffer-0',
            kind: 'buffer-allocation',
        })

        controller.completeOperation(operation, { status: 'succeeded' })

        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.operation(operation.id).descriptor).not.to.have.property('full')
    })

    it('keeps uncaptured incidents bounded and removes only its own listener', async () => {

        const { gpu, device, errors } = createFakeGpu()
        let applicationEvents = 0
        const applicationListener = () => applicationEvents++
        device.addEventListener('uncapturederror', applicationListener)
        const runtime = await ScratchRuntime.create({
            gpu,
            diagnostics: {
                operationCapacity: 2,
                incidentCapacity: 2,
                evidenceByteCapacity: 8_192,
            },
        })

        expect(errors.listenerCount('uncapturederror')).to.equal(2)
        errors.emitUncaptured(Object.assign(new Error('raw 1'), { name: 'GPUValidationError' }))
        errors.emitUncaptured(Object.assign(new Error('raw 2'), { name: 'GPUValidationError' }))
        errors.emitUncaptured(Object.assign(new Error('raw 3'), { name: 'GPUValidationError' }))
        await settleMicrotasks()

        const incidents = runtime.diagnostics.incidents()
        expect(applicationEvents).to.equal(3)
        expect(incidents).to.have.length(2)
        expect(incidents.every(incident => incident.diagnosticCode === 'SCRATCH_RUNTIME_UNCAPTURED_GPU_ERROR')).to.equal(true)
        expect(incidents.every(incident => [ 'temporal-correlation', 'unknown' ].includes(incident.attribution))).to.equal(true)
        expect(runtime.diagnostics.snapshot().recorder.overwrittenIncidents).to.equal(1)

        runtime.dispose()
        expect(errors.listenerCount('uncapturederror')).to.equal(1)
        device.removeEventListener('uncapturederror', applicationListener)
    })

    it('records device loss without fabricating operation causality', async () => {

        const { gpu, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const pending = controller.beginOperation(operationInput(0))

        errors.loseDevice({ reason: 'unknown', message: 'fake device disappeared' })
        await settleMicrotasks()

        const incident = runtime.diagnostics.incidents().at(-1)
        expect(runtime.isDeviceLost).to.equal(true)
        expect(incident).to.deep.include({
            kind: 'device-loss',
            diagnosticCode: 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            nativeErrorCategory: 'device-lost',
            attribution: 'temporal-correlation',
        })
        expect(incident).not.to.have.property('causeOperationId')
        expect(runtime.diagnostics.snapshot().pendingOperations.map(item => item.id)).to.include(pending.id)
    })

    it('captures stacks and full descriptors only in finite deep capture sessions', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const capture = runtime.diagnostics.capture({
            maxOperations: 2,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 16_384,
            includeStacks: true,
            includeDescriptors: true,
        })

        expect(capture).not.to.have.property('then')
        for (let index = 0; index < 2; index++) {
            const operation = controller.beginOperation(operationInput(index))
            controller.completeOperation(operation, { status: 'succeeded' })
        }

        expect(capture.isActive).to.equal(false)
        const report = capture.stop()
        expect(report.stopReason).to.equal('operation-limit')
        expect(report.operations).to.have.length(2)
        expect(report.operations.every(record => typeof record.stack === 'string')).to.equal(true)
        expect(report.operations.every(record => record.descriptor.full !== undefined)).to.equal(true)
        expect(report.retainedEvidenceBytes).to.be.at.most(16_384)
        expect(Object.isFrozen(report)).to.equal(true)
        expect(runtime.diagnostics.operations().every(record => record.stack === undefined)).to.equal(true)
        expect(runtime.diagnostics.operations().every(record => record.descriptor.full === undefined)).to.equal(true)
    })

    it('automatically expires capture sessions by duration', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const capture = runtime.diagnostics.capture({
            maxOperations: 100,
            maxDurationMs: 5,
            maxEvidenceBytes: 16_384,
            includeStacks: false,
        })

        await new Promise(resolve => setTimeout(resolve, 20))

        expect(capture.isActive).to.equal(false)
        expect(capture.stop().stopReason).to.equal('duration-limit')
        expect(runtime.diagnostics.snapshot().capture.activeCount).to.equal(0)
    })
})

describe('ScratchRuntime fallible initial GPU allocation', () => {

    it('pops both scopes before awaiting and registers a buffer only after acknowledgement', async () => {

        const { gpu, calls, errors } = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu })

        const creation = runtime.createBuffer({
            label: 'vertices',
            size: 64,
            usage: 1,
        })

        expect(creation).to.be.an.instanceOf(Promise)
        expect(calls.buffers).to.have.length(1)
        expect(calls.errorScopes.map(call => `${call.action}:${call.filter}`)).to.deep.equal([
            'push:out-of-memory',
            'push:validation',
            'pop:validation',
            'pop:out-of-memory',
        ])
        expect(errors.scopeDepth).to.equal(0)
        expect(runtime._resources.size).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(1)

        errors.settlePop(1)
        await settleMicrotasks()
        expect(runtime._resources.size).to.equal(0)
        errors.settlePop(0)

        const buffer = await creation
        expect(buffer).to.be.an.instanceOf(BufferResource)
        expect(runtime._resources.size).to.equal(1)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(calls.buffers[0].descriptor.label).to.equal(`vertices [scratch:${buffer.id}]`)
        expect(runtime.diagnostics.operations()).to.have.length(1)
        expect(runtime.diagnostics.operations()[0]).to.deep.include({
            kind: 'buffer-allocation',
            status: 'succeeded',
            resourceId: buffer.id,
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 64,
        })
    })

    it('attributes validation failure exactly and never registers the failed candidate', async () => {

        const { gpu, calls, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const nativeError = Object.assign(new Error('invalid native descriptor'), {
            name: 'GPUValidationError',
        })
        errors.failNext('createBuffer', 'validation', nativeError)

        const error = await rejectedDiagnostic(runtime.createBuffer({ size: 64, usage: 1 }))

        expect(error.diagnostic.code).to.equal('SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED')
        expect(error.cause).to.equal(nativeError)
        expect(error.incident).to.deep.include({
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
        })
        expect(error.incident.operationId).to.equal(error.diagnostic.subject.id)
        expect(calls.buffers).to.have.length(1)
        expect(calls.buffers[0].destroyed).to.equal(true)
        expect(runtime._resources.size).to.equal(0)
        expect(runtime.diagnostics.snapshot().pressure.currentScratchLogicalFootprintBytes).to.equal(0)
        expect(runtime.diagnostics.operations()[0]).to.deep.include({
            status: 'failed',
            nativeErrorCategory: 'validation',
        })
    })

    it('attributes OOM to the trigger operation while preserving contributor caveats', async () => {

        const { gpu, calls, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const resident = await Promise.resolve(runtime.createBuffer({ size: 32, usage: 1 }))
        const nativeError = Object.assign(new Error('out of memory'), {
            name: 'GPUOutOfMemoryError',
        })
        errors.failNext('createTexture', 'out-of-memory', nativeError)

        const error = await rejectedDiagnostic(runtime.createTexture(textureDescriptor('oom texture')))

        expect(error.diagnostic.code).to.equal('SCRATCH_TEXTURE_ALLOCATION_OUT_OF_MEMORY')
        expect(error.incident.nativeErrorCategory).to.equal('out-of-memory')
        expect(error.incident.pressure).to.deep.include({
            triggerLogicalFootprintBytes: 64,
            currentScratchLogicalFootprintBytes: 32,
        })
        expect(error.incident.pressure.largestContributors[0].resourceId).to.equal(resident.id)
        expect(error.incident.pressure).not.to.have.property('rootCause')
        expect(error.incident.pressure.caveats).to.include(
            'The triggering operation is not necessarily the sole OOM cause.'
        )
        expect(calls.textures[0].destroyed).to.equal(true)
        expect(runtime._resources.size).to.equal(1)
    })

    it('balances scopes after a synchronous native throw and reports the native category', async () => {

        const { gpu, calls, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const nativeError = new TypeError('native createBuffer threw')
        errors.throwNext('createBuffer', nativeError)

        const error = await rejectedDiagnostic(runtime.createBuffer({ size: 4, usage: 1 }))

        expect(error.diagnostic.code).to.equal('SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED')
        expect(error.cause).to.equal(nativeError)
        expect(error.incident.nativeErrorCategory).to.equal('native-exception')
        expect(calls.errorScopes.map(call => call.action)).to.deep.equal([
            'push', 'push', 'pop', 'pop',
        ])
        expect(errors.scopeDepth).to.equal(0)
        expect(calls.buffers).to.have.length(0)
        expect(runtime._resources.size).to.equal(0)
    })

    it('handles a scope-pop failure structurally after issuing both pops', async () => {

        const { gpu, calls, errors } = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu })
        const creation = runtime.createTexture(textureDescriptor('scope failure'))

        errors.rejectPop(0, new Error('validation pop rejected'))
        errors.settlePop(1)
        const error = await rejectedDiagnostic(creation)

        expect(error.diagnostic.code).to.equal('SCRATCH_GPU_ERROR_SCOPE_FAILED')
        expect(error.incident.nativeErrorCategory).to.equal('scope-failure')
        expect(calls.textures[0].destroyed).to.equal(true)
        expect(runtime._resources.size).to.equal(0)
        expect(errors.scopeDepth).to.equal(0)
    })

    it('isolates concurrent allocations and preserves an application outer scope', async () => {

        const { gpu, device, errors } = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu })
        const nativeError = Object.assign(new Error('first invalid'), { name: 'GPUValidationError' })

        device.pushErrorScope('validation')
        errors.failNext('createBuffer', 'validation', nativeError)
        const first = runtime.createBuffer({ size: 4, usage: 1 })
        const second = runtime.createBuffer({ size: 8, usage: 1 })
        expect(errors.scopeDepth).to.equal(1)

        errors.settlePop(3)
        errors.settlePop(1)
        errors.settlePop(2)
        errors.settlePop(0)

        const firstError = await rejectedDiagnostic(first)
        const secondBuffer = await second
        expect(firstError.diagnostic.code).to.equal('SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED')
        expect(secondBuffer.size).to.equal(8)
        const outerScope = device.popErrorScope()
        errors.settlePop(4)
        expect(await outerScope).to.equal(null)
        expect(errors.scopeDepth).to.equal(0)
    })

    it('rejects device loss and runtime disposal while scopes settle without exposing candidates', async () => {

        const lostFake = createFakeGpu({ deferErrorScopePops: true })
        const lostRuntime = await ScratchRuntime.create({ gpu: lostFake.gpu })
        const lostCreation = lostRuntime.createTexture(textureDescriptor('lost candidate'))
        lostFake.errors.loseDevice({ reason: 'unknown', message: 'device vanished' })
        const lostError = await rejectedDiagnostic(lostCreation)

        expect(lostError.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION')
        expect(lostError.incident.kind).to.equal('device-loss')
        expect(lostError.incident.attribution).to.equal('temporal-correlation')
        expect(lostFake.calls.textures[0].destroyed).to.equal(true)
        expect(lostRuntime._resources.size).to.equal(0)
        lostFake.errors.settlePop(0)
        lostFake.errors.settlePop(1)

        const disposedFake = createFakeGpu({ deferErrorScopePops: true })
        const disposedRuntime = await ScratchRuntime.create({ gpu: disposedFake.gpu })
        const disposedCreation = disposedRuntime.createBuffer({ size: 4, usage: 1 })
        disposedRuntime.dispose()
        const disposedError = await rejectedDiagnostic(disposedCreation)

        expect(disposedError.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(disposedFake.calls.buffers[0].destroyed).to.equal(true)
        expect(disposedRuntime._resources.size).to.equal(0)
        disposedFake.errors.settlePop(0)
        disposedFake.errors.settlePop(1)
    })

    it('removes every synchronous public allocation bypass', async () => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        expect(BufferResource).not.to.have.property('create')
        expect(TextureResource).not.to.have.property('create')
        expect(() => new BufferResource(runtime, { size: 4, usage: 1 })).to.throw()
        expect(() => new TextureResource(runtime, textureDescriptor('direct'))).to.throw()
        expect(calls.buffers).to.have.length(0)
        expect(calls.textures).to.have.length(0)
    })
})

function operationInput(index) {

    return {
        kind: 'buffer-allocation',
        resourceId: `candidate-buffer-${index}`,
        resourceKind: 'BufferResource',
        allocationVersion: 1,
        contentEpoch: 0,
        logicalFootprintBytes: 64 + index,
        descriptorSummary: { size: 64 + index, usage: 1 },
        fullDescriptor: {
            label: `candidate ${index}`,
            size: 64 + index,
            usage: 1,
            mappedAtCreation: false,
        },
        nativeLabel: `candidate ${index} [scratch:candidate-buffer-${index}]`,
    }
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

function textureDescriptor(label) {

    return {
        label,
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: 1,
    }
}
