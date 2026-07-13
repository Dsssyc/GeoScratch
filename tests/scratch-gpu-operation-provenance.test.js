import { expect } from 'chai'
import {
    createGpuIncidentReport,
    createGpuOperationRecord,
    serializeNativeGpuError,
    serializedEvidenceBytes,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
import {
    diagnosticsControllerFor,
    logicalTextureDescriptorFootprint,
} from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { ScratchRuntime } from '../packages/geoscratch/dist/scratch/runtime.js'
import { BufferResource } from '../packages/geoscratch/dist/scratch/buffer.js'
import { TextureResource } from '../packages/geoscratch/dist/scratch/texture.js'
import { layoutCodec } from '../packages/geoscratch/dist/scratch/layout-codec.js'
import { resourceDisposalSubscriberCount } from '../packages/geoscratch/dist/scratch/resource.js'
import { ScratchDiagnosticError } from '../packages/geoscratch/dist/scratch/diagnostics.js'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
} from './scratch-test-utils.js'

describe('scratch GPU operation provenance facts', () => {

    it('creates deeply immutable JSON operation records from bounded fields', () => {

        const gpuBuffer = { type: 'buffer', destroy() {} }
        const record = createGpuOperationRecord({
            sequence: 7,
            id: 'gpu-operation-7',
            kind: 'buffer-allocation',
            status: 'succeeded',
            runtimeId: 'scratch-runtime-1',
            target: {
                kind: 'resource',
                resourceId: 'scratch-resource-1',
                resourceKind: 'BufferResource',
                allocationVersion: 1,
                contentEpoch: 0,
                logicalFootprintBytes: 4096,
            },
            descriptor: {
                hash: 'buffer-4096-12',
                summary: { size: 4096, usage: 12 },
            },
            nativeLabel: 'vertices [scratch:scratch-resource-1]',
            // Unknown fields must never leak mutable native handles.
            gpuBuffer,
        })

        expect(record).to.deep.equal({
            version: 5,
            sequence: 7,
            id: 'gpu-operation-7',
            kind: 'buffer-allocation',
            status: 'succeeded',
            runtimeId: 'scratch-runtime-1',
            target: {
                kind: 'resource',
                resourceId: 'scratch-resource-1',
                resourceKind: 'BufferResource',
                allocationVersion: 1,
                contentEpoch: 0,
                logicalFootprintBytes: 4096,
            },
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
            target: {
                kind: 'resource',
                resourceId: 'scratch-resource-2',
                resourceKind: 'TextureResource',
                allocationVersion: 1,
                contentEpoch: 0,
                logicalFootprintBytes: 16_777_216,
            },
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
            target: triggerOperation.target,
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
        expect(serializeNativeGpuError({
            reason: 'unknown',
            message: '[native device-loss message omitted]',
            nativeMessageOmitted: true,
        })).to.deep.equal({
            reason: 'unknown',
            message: '[native device-loss message omitted]',
            nativeMessageOmitted: true,
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

    it('keeps the runtime native-device ownership immutable', async () => {

        const primary = createFakeGpu()
        const replacement = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: primary.gpu })
        const originalDevice = runtime.device
        const originalQueue = runtime.queue

        expect(() => { runtime.device = replacement.device }).to.throw(TypeError)
        expect(() => { runtime.queue = replacement.device.queue }).to.throw(TypeError)
        expect(() => {
            Object.defineProperty(runtime, 'device', { value: replacement.device })
        }).to.throw(TypeError)
        expect(() => {
            Object.defineProperty(runtime, 'isDeviceLost', { value: false })
        }).to.throw(TypeError)
        expect(runtime.device).to.equal(originalDevice)
        expect(runtime.queue).to.equal(originalQueue)

        primary.errors.loseDevice({ reason: 'unknown', message: 'owned device lost' })
        await settleMicrotasks()

        expect(runtime.isDeviceLost).to.equal(true)
        expect(runtime.diagnostics.incidents().at(-1).kind).to.equal('device-loss')
    })

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
        const exported = runtime.diagnostics.exportEvidence()
        expect(Object.isFrozen(exported)).to.equal(true)
        expect(JSON.parse(JSON.stringify(exported))).to.deep.equal(exported)
        expect(exported.snapshot).to.deep.equal(snapshot)

        buffer.dispose()
        expect(runtime.diagnostics.snapshot().resources).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pressure.currentScratchLogicalFootprintBytes).to.equal(0)
    })

    it('bounds diagnostic labels while preserving the full native label and Scratch ID suffix', async () => {

        const { gpu, calls } = createFakeGpu()
        const longRuntimeLabel = `runtime-${'r'.repeat(100_000)}`
        const longResourceLabel = `buffer-${'b'.repeat(100_000)}`
        const longLayoutLabel = `layout-${'l'.repeat(1_000_000)}`
        const codec = layoutCodec({
            label: longLayoutLabel,
            name: 'CapturedLayout',
            fields: [ { name: 'value', type: 'f32' } ],
        })
        const runtime = await ScratchRuntime.create({ gpu, label: longRuntimeLabel })
        const buffer = await runtime.createBuffer({
            label: longResourceLabel,
            size: 4,
            usage: 1,
        })
        const nativeSuffix = ` [scratch:${buffer.id}]`
        const operation = runtime.diagnostics.operations().at(-1)
        const snapshot = runtime.diagnostics.snapshot()
        const evidenceJson = JSON.stringify(runtime.diagnostics.exportEvidence())

        expect(calls.buffers[0].descriptor.label).to.equal(`${longResourceLabel}${nativeSuffix}`)
        expect(snapshot.runtime.label.length).to.be.at.most(256)
        expect(snapshot.resources[0].label.length).to.be.at.most(256)
        expect(operation.nativeLabel.length).to.be.at.most(256)
        expect(operation.nativeLabel.endsWith(nativeSuffix)).to.equal(true)
        expect(evidenceJson).not.to.include(longRuntimeLabel)
        expect(evidenceJson).not.to.include(longResourceLabel)

        const capture = runtime.diagnostics.capture({
            maxOperations: 1,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 16_384,
            includeDescriptors: true,
        })
        const capturedBuffer = await runtime.createBuffer({
            label: longResourceLabel,
            size: codec.artifact.stride,
            usage: 1,
        })
        const capturedRegion = capturedBuffer.region({ layout: codec.artifact })
        const captureReport = capture.stop()
        expect(calls.buffers[1].descriptor.label).to.equal(
            `${longResourceLabel} [scratch:${capturedBuffer.id}]`
        )
        expect(captureReport.operations[0].descriptor.full.label.length).to.be.at.most(256)
        expect(captureReport.operations[0].descriptor.full).not.to.have.property('layout')
        expect(capturedRegion.layout).to.equal(codec.artifact)
        expect(JSON.stringify(captureReport)).not.to.include(longResourceLabel)
        expect(JSON.stringify(captureReport)).not.to.include(longLayoutLabel)
    })

    it('shrinks depth across 3D mip levels without shrinking 2D array layers', () => {

        const baseDescriptor = {
            size: { width: 8, height: 8, depthOrArrayLayers: 8 },
            format: 'rgba8unorm',
            mipLevelCount: 4,
            sampleCount: 1,
        }

        expect(logicalTextureDescriptorFootprint({
            ...baseDescriptor,
            dimension: '3d',
        })).to.deep.equal({ bytes: 2_340, known: true })
        expect(logicalTextureDescriptorFootprint({
            ...baseDescriptor,
            dimension: '2d',
        })).to.deep.equal({ bytes: 2_720, known: true })
        expect(logicalTextureDescriptorFootprint({
            ...baseDescriptor,
            dimension: 'future-dimension',
        })).to.deep.equal({ bytes: 0, known: false })
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

    it('does not clone full descriptors into default pending operation state', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)
        const compact = controller.beginOperation(operationInput(0))

        expect(compact).not.to.have.property('fullDescriptor')
        controller.completeOperation(compact, { status: 'succeeded' })

        const oversizedInput = operationInput(2)
        const oversizedPending = controller.beginOperation({
            ...oversizedInput,
            nativeLabel: `${'x'.repeat(100_000)} [scratch:${oversizedInput.target.resourceId}]`,
        })
        expect(oversizedPending.nativeLabel.length).to.be.at.most(256)
        expect(oversizedPending.nativeLabel.endsWith(
            ` [scratch:${oversizedInput.target.resourceId}]`
        )).to.equal(true)
        controller.completeOperation(oversizedPending, { status: 'succeeded' })

        const capture = runtime.diagnostics.capture({
            maxOperations: 1,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 16_384,
            includeDescriptors: true,
        })
        const longNestedLabel = `layout-${'l'.repeat(100_000)}`
        const detailedInput = operationInput(1)
        const detailed = controller.beginOperation({
            ...detailedInput,
            fullDescriptor: {
                ...detailedInput.fullDescriptor,
                layout: { label: longNestedLabel },
            },
        })
        expect(detailed.fullDescriptor.full).to.deep.include({ label: 'candidate 1' })
        expect(detailed.fullDescriptor.full.layout.label.length).to.be.at.most(256)
        expect(JSON.stringify(detailed)).not.to.include(longNestedLabel)
        controller.completeOperation(detailed, { status: 'succeeded' })
        expect(capture.stop().operations[0].descriptor.full).to.deep.include({ label: 'candidate 1' })
    })

    it('removes disposed resources from current facts before disposal capture can degrade', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const buffer = await runtime.createBuffer({ size: 4, usage: 1 })
        const capture = runtime.diagnostics.capture({
            maxOperations: 8,
            maxDurationMs: 1_000,
            maxEvidenceBytes: 1,
        })

        buffer.dispose()

        const incident = runtime.diagnostics.incidents().at(-1)
        expect(capture.stop().stopReason).to.equal('evidence-limit')
        expect(runtime.diagnostics.snapshot().resources).to.have.length(0)
        expect(incident.kind).to.equal('capture-degraded')
        expect((incident.currentResources ?? []).map(resource => resource.id)).not.to.include(buffer.id)
    })

    it('keeps recorder state structurally bounded under sustained overwrite stress', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu,
            diagnostics: {
                operationCapacity: 8,
                incidentCapacity: 4,
                evidenceByteCapacity: 32_768,
                recentOperationLimit: 4,
                contributorLimit: 2,
            },
        })
        const controller = diagnosticsControllerFor(runtime)

        const emitBatch = (offset) => {
            for (let index = 0; index < 128; index++) {
                const operation = controller.beginOperation(operationInput(offset + index))
                const record = controller.completeOperation(operation, { status: 'succeeded' })
                if (index % 8 === 0) {
                    controller.recordIncident({
                        kind: 'allocation-failure',
                        diagnosticCode: 'SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED',
                        nativeErrorCategory: 'validation',
                        attribution: 'exact-operation',
                        target: record.target,
                        operationId: record.id,
                        triggerOperation: record,
                        nativeError: { name: 'GPUValidationError', message: 'synthetic stress incident' },
                        triggerLogicalFootprintBytes: record.target.logicalFootprintBytes,
                    })
                }
            }
        }

        emitBatch(0)
        const first = runtime.diagnostics.snapshot()
        const firstRetainedCount = first.recorder.retainedOperationCount + first.recorder.retainedIncidentCount
        emitBatch(128)
        const second = runtime.diagnostics.snapshot()
        const operations = runtime.diagnostics.operations()
        const incidents = runtime.diagnostics.incidents()

        expect(operations.length).to.be.at.most(8)
        expect(incidents.length).to.be.at.most(4)
        expect(second.recorder.retainedEvidenceBytes).to.be.at.most(32_768)
        expect(second.recorder.overwrittenOperations).to.be.greaterThan(first.recorder.overwrittenOperations)
        expect(second.recorder.overwrittenIncidents).to.be.greaterThan(first.recorder.overwrittenIncidents)
        expect(second.recorder.retainedOperationCount + second.recorder.retainedIncidentCount).to.be.at.most(firstRetainedCount)
        expect(operations.map(record => record.sequence)).to.deep.equal(
            [ ...operations ].map(record => record.sequence).sort((left, right) => left - right)
        )
        expect(incidents.map(report => report.sequence)).to.deep.equal(
            [ ...incidents ].map(report => report.sequence).sort((left, right) => left - right)
        )
        expect(operations.every(record => record.stack === undefined)).to.equal(true)
        expect(operations.every(record => record.descriptor.full === undefined)).to.equal(true)
    })

    it('releases runtime and resource lifecycle subscriptions after successful settlement', async () => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const controller = diagnosticsControllerFor(runtime)

        for (let index = 0; index < 64; index++) {
            const buffer = await runtime.createBuffer({ size: 4, usage: 1 })
            buffer.dispose()
            expect(controller.lifecycleSubscriberCount).to.equal(0)
        }

        const texture = await runtime.createTexture(textureDescriptor('subscription retention'))
        expect(controller.lifecycleSubscriberCount).to.equal(0)
        for (let index = 0; index < 16; index++) {
            const size = index % 2 === 0 ? 8 : 4
            await texture.resize({ width: size, height: size })
            expect(controller.lifecycleSubscriberCount).to.equal(0)
            expect(resourceDisposalSubscriberCount(texture)).to.equal(0)
        }
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
            kind: 'buffer-allocation',
        })
        expect(pendingSnapshot.pendingOperations[0].target).to.deep.include({
            kind: 'resource',
            resourceId: 'candidate-buffer-0',
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
        })
        expect(runtime.diagnostics.operations()[0].target).to.deep.equal({
            kind: 'resource',
            resourceId: buffer.id,
            resourceKind: 'BufferResource',
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

    it('keeps a returned failure incident finite when the native label is extremely long', async () => {

        const { gpu, calls, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({
            gpu,
            diagnostics: { evidenceByteCapacity: 1_024 },
        })
        const label = `oversized-${'x'.repeat(1_000_000)}`
        errors.failNext(
            'createBuffer',
            'validation',
            Object.assign(new Error('invalid native descriptor'), { name: 'GPUValidationError' })
        )

        const error = await rejectedDiagnostic(runtime.createBuffer({ label, size: 4, usage: 1 }))
        const nativeSuffix = ` [scratch:${error.incident.target.resourceId}]`
        const serializedIncident = JSON.stringify(error.incident)

        expect(calls.buffers[0].descriptor.label).to.equal(`${label}${nativeSuffix}`)
        expect(error.incident.triggerOperation.nativeLabel.length).to.be.at.most(256)
        expect(error.incident.triggerOperation.nativeLabel.endsWith(nativeSuffix)).to.equal(true)
        expect(serializedIncident.length).to.be.lessThan(16_384)
        expect(serializedIncident).not.to.include(label)
    })

    it('links incidents into active and operation-limited capture records', async () => {

        for (const maxOperations of [ 1, 2 ]) {
            const { gpu, errors } = createFakeGpu()
            const runtime = await ScratchRuntime.create({
                gpu,
                diagnostics: { operationCapacity: 0 },
            })
            const capture = runtime.diagnostics.capture({
                maxOperations,
                maxDurationMs: 1_000,
                maxEvidenceBytes: 16_384,
            })
            errors.failNext(
                'createBuffer',
                'validation',
                Object.assign(new Error('captured validation'), { name: 'GPUValidationError' })
            )

            const error = await rejectedDiagnostic(runtime.createBuffer({ size: 4, usage: 1 }))
            const report = capture.stop()

            expect(report.operations).to.have.length(1)
            expect(report.operations[0].incidentId).to.equal(error.incident.id)
            expect(report.retainedEvidenceBytes).to.be.at.most(16_384)
            expect(report.retainedEvidenceBytes).to.equal(
                serializedEvidenceBytes(report.operations[0])
            )
            expect(runtime.diagnostics.operations()).to.have.length(0)
        }
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

    it('records bounded disposal churn without counting disposal as allocation', async () => {

        const { gpu, errors } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const resident = await runtime.createBuffer({
            label: 'temporary resident',
            size: 32,
            usage: 1,
        })
        resident.dispose()
        errors.failNext(
            'createBuffer',
            'out-of-memory',
            Object.assign(new Error('out of memory'), { name: 'GPUOutOfMemoryError' })
        )

        const error = await rejectedDiagnostic(runtime.createBuffer({ size: 64, usage: 1 }))
        const disposal = runtime.diagnostics.operations()
            .find(operation => operation.kind === 'resource-disposal')
        const queriedDisposals = runtime.diagnostics.operations({ kind: 'resource-disposal' })
        const snapshot = runtime.diagnostics.snapshot()

        expect(disposal).to.deep.include({
            status: 'succeeded',
        })
        expect(disposal.target).to.deep.include({
            kind: 'resource',
            resourceId: resident.id,
            resourceKind: 'BufferResource',
            logicalFootprintBytes: 32,
        })
        expect(queriedDisposals.map(operation => operation.id)).to.deep.equal([ disposal.id ])
        expect(error.incident.pressure.recentChurn).to.deep.include({
            sequence: disposal.sequence,
            operationId: disposal.id,
            operationKind: 'resource-disposal',
            status: 'succeeded',
            resourceId: resident.id,
            logicalFootprintBytes: 32,
        })
        expect(snapshot.aggregates.allocationAttempts).to.equal(2)
        expect(snapshot.aggregates.successfulAllocations).to.equal(1)
        expect(snapshot.resources).to.have.length(0)
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

    it('keeps concurrent allocation scope ownership separate across runtimes', async () => {

        const fakeA = createFakeGpu({ deferErrorScopePops: true })
        const fakeB = createFakeGpu({ deferErrorScopePops: true })
        const runtimeA = await ScratchRuntime.create({ gpu: fakeA.gpu })
        const runtimeB = await ScratchRuntime.create({ gpu: fakeB.gpu })
        const validationError = Object.assign(new Error('runtime A invalid'), {
            name: 'GPUValidationError',
        })
        fakeA.errors.failNext('createBuffer', 'validation', validationError)

        const allocationA = runtimeA.createBuffer({ size: 4, usage: 1 })
        const allocationB = runtimeB.createBuffer({ size: 8, usage: 1 })
        fakeB.errors.settlePop(1)
        fakeA.errors.settlePop(0)
        fakeB.errors.settlePop(0)
        fakeA.errors.settlePop(1)

        const errorA = await rejectedDiagnostic(allocationA)
        const bufferB = await allocationB
        expect(errorA.diagnostic.code).to.equal('SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED')
        expect(errorA.incident.runtimeId).to.equal(runtimeA.id)
        expect(bufferB.runtime).to.equal(runtimeB)
        expect(runtimeA._resources.size).to.equal(0)
        expect(runtimeB._resources.size).to.equal(1)
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

    it('rechecks runtime lifecycle after scope acknowledgement and before resource installation', async () => {

        const bufferFake = createFakeGpu()
        const bufferRuntime = await ScratchRuntime.create({ gpu: bufferFake.gpu })
        triggerOnLifecycleUnsubscribe(bufferRuntime, () => bufferRuntime.dispose())
        const bufferFailure = await rejectedDiagnostic(
            bufferRuntime.createBuffer({ size: 4, usage: 1 })
        )

        expect(bufferFailure.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(bufferFake.calls.buffers[0].destroyed).to.equal(true)
        expect(bufferRuntime._resources.size).to.equal(0)
        expect(bufferRuntime.diagnostics.operations().at(-1).status).to.equal('cancelled')

        const textureFake = createFakeGpu()
        const textureRuntime = await ScratchRuntime.create({ gpu: textureFake.gpu })
        triggerOnLifecycleUnsubscribe(textureRuntime, () => textureRuntime.dispose())
        const textureFailure = await rejectedDiagnostic(
            textureRuntime.createTexture(textureDescriptor('dispose after scopes'))
        )

        expect(textureFailure.diagnostic.code).to.equal('SCRATCH_RUNTIME_DISPOSED')
        expect(textureFake.calls.textures[0].destroyed).to.equal(true)
        expect(textureRuntime._resources.size).to.equal(0)
        expect(textureRuntime.diagnostics.operations().at(-1).status).to.equal('cancelled')
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

describe('TextureResource transactional replacement allocation', () => {

    it('keeps the old allocation current until scoped replacement acknowledgement', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const initial = runtime.createTexture(textureDescriptor('transactional'))
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        const texture = await initial
        advanceResourceContentEpochForTest(texture)
        const oldTexture = texture.gpuTexture
        const oldView = texture.view()
        const replacement = texture.resize({ width: 8, height: 8 })

        expect(replacement).to.be.an.instanceOf(Promise)
        expect(texture.gpuTexture).to.equal(oldTexture)
        expect(texture.width).to.equal(4)
        expect(texture.height).to.equal(4)
        expect(texture.allocationVersion).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(texture.state).to.equal('ready')
        expect(() => oldView.assertUsable()).not.to.throw()
        expect(texture.view().hash).to.equal(oldView.hash)
        expect(oldTexture.destroyed).to.equal(false)
        expect(runtime.diagnostics.snapshot().resources[0].pendingReplacementOperationId).to.be.a('string')

        const conflict = await rejectedDiagnostic(texture.resize({ width: 16, height: 16 }))
        expect(conflict.diagnostic.code).to.equal('SCRATCH_TEXTURE_REPLACEMENT_PENDING')
        expect(fake.calls.textures).to.have.length(2)

        fake.errors.settlePop(3)
        fake.errors.settlePop(2)
        await replacement

        expect(texture.gpuTexture).to.equal(fake.calls.textures[1])
        expect(texture.gpuTexture).not.to.equal(oldTexture)
        expect(texture.width).to.equal(8)
        expect(texture.height).to.equal(8)
        expect(texture.allocationVersion).to.equal(2)
        expect(texture.contentEpoch).to.equal(1)
        expect(texture.state).to.equal('empty')
        expect(oldTexture.destroyed).to.equal(true)
        expect(() => oldView.assertUsable()).not.to.throw()
        expect(texture.view().hash).to.equal(oldView.hash)
        expect(runtime.diagnostics.snapshot().resources[0]).not.to.have.property('pendingReplacementOperationId')
        expect(runtime.diagnostics.operations().at(-1)).to.deep.include({
            kind: 'texture-replacement',
            status: 'succeeded',
        })
        expect(runtime.diagnostics.operations().at(-1).target).to.deep.include({
            kind: 'resource',
            allocationVersion: 2,
            contentEpoch: 1,
        })
    })

    it('preserves every old allocation fact after validation failure', async () => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture(textureDescriptor('rollback'))
        advanceResourceContentEpochForTest(texture)
        const oldTexture = texture.gpuTexture
        const oldView = texture.view()
        const oldDescriptor = texture.descriptor
        const error = Object.assign(new Error('replacement invalid'), { name: 'GPUValidationError' })
        fake.errors.failNext('createTexture', 'validation', error)

        const failure = await rejectedDiagnostic(texture.resize({ width: 8, height: 8 }))

        expect(failure.diagnostic.code).to.equal('SCRATCH_TEXTURE_REPLACEMENT_VALIDATION_FAILED')
        expect(failure.cause).to.equal(error)
        expect(failure.incident).to.deep.include({
            nativeErrorCategory: 'validation',
            attribution: 'exact-operation',
        })
        expect(failure.incident.target).to.deep.include({
            kind: 'resource',
            resourceId: texture.id,
        })
        expect(texture.gpuTexture).to.equal(oldTexture)
        expect(texture.descriptor).to.equal(oldDescriptor)
        expect(texture.width).to.equal(4)
        expect(texture.height).to.equal(4)
        expect(texture.allocationVersion).to.equal(1)
        expect(texture.contentEpoch).to.equal(1)
        expect(texture.state).to.equal('ready')
        expect(() => oldView.assertUsable()).not.to.throw()
        expect(texture.view().hash).to.equal(oldView.hash)
        expect(oldTexture.destroyed).to.equal(false)
        expect(fake.calls.textures[1].destroyed).to.equal(true)
    })

    it('reports replacement OOM without treating the trigger as the sole cause', async () => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture(textureDescriptor('replacement oom'))
        const error = Object.assign(new Error('replacement oom'), { name: 'GPUOutOfMemoryError' })
        fake.errors.failNext('createTexture', 'out-of-memory', error)

        const failure = await rejectedDiagnostic(texture.resize({ width: 8, height: 8 }))

        expect(failure.diagnostic.code).to.equal('SCRATCH_TEXTURE_REPLACEMENT_OUT_OF_MEMORY')
        expect(failure.incident.pressure.triggerLogicalFootprintBytes).to.equal(256)
        expect(failure.incident.pressure.caveats).to.include(
            'The triggering operation is not necessarily the sole OOM cause.'
        )
        expect(texture.width).to.equal(4)
        expect(texture.allocationVersion).to.equal(1)
    })

    it('keeps same-size resize scope-free and cancels a candidate on resource disposal', async () => {

        const noOpFake = createFakeGpu()
        const noOpRuntime = await ScratchRuntime.create({ gpu: noOpFake.gpu })
        const texture = await noOpRuntime.createTexture(textureDescriptor('no-op'))
        const scopeCallsBefore = noOpFake.calls.errorScopes.length
        const operationRecordsBefore = noOpRuntime.diagnostics.operations().length

        const noOp = texture.resize([ 4, 4, 1 ])
        expect(noOp).to.be.an.instanceOf(Promise)
        await noOp
        expect(noOpFake.calls.errorScopes).to.have.length(scopeCallsBefore)
        expect(noOpFake.calls.textures).to.have.length(1)
        expect(noOpRuntime.diagnostics.operations()).to.have.length(operationRecordsBefore)

        const disposeFake = createFakeGpu({ deferErrorScopePops: true })
        const disposeRuntime = await ScratchRuntime.create({ gpu: disposeFake.gpu })
        const initial = disposeRuntime.createTexture(textureDescriptor('dispose pending'))
        disposeFake.errors.settlePop(0)
        disposeFake.errors.settlePop(1)
        const disposable = await initial
        const replacement = disposable.resize({ width: 8, height: 8 })
        disposable.dispose()
        const failure = await rejectedDiagnostic(replacement)

        expect(failure.diagnostic.code).to.equal('SCRATCH_RESOURCE_DISPOSED')
        expect(disposeFake.calls.textures[0].destroyed).to.equal(true)
        expect(disposeFake.calls.textures[1].destroyed).to.equal(true)
        expect(disposeRuntime._resources.size).to.equal(0)
        disposeFake.errors.settlePop(2)
        disposeFake.errors.settlePop(3)
    })

    it('records device loss during replacement without claiming rollback usability', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const initial = runtime.createTexture(textureDescriptor('loss replacement'))
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        const texture = await initial
        const oldTexture = texture.gpuTexture
        const replacement = texture.resize({ width: 8, height: 8 })

        fake.errors.loseDevice({ reason: 'unknown', message: 'replacement device loss' })
        const failure = await rejectedDiagnostic(replacement)

        expect(failure.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION')
        expect(failure.incident).to.deep.include({
            kind: 'device-loss',
            attribution: 'temporal-correlation',
        })
        expect(runtime.isDeviceLost).to.equal(true)
        expect(fake.calls.textures[1].destroyed).to.equal(true)
        expect(texture.gpuTexture).to.equal(oldTexture)
        expect(() => texture.assertUsable()).to.throw(ScratchDiagnosticError)
        expect(failure.incident).not.to.have.property('rollbackRestoredUsability')
        fake.errors.settlePop(2)
        fake.errors.settlePop(3)
    })

    it('rechecks device loss after scope acknowledgement and before replacement commit', async () => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const texture = await runtime.createTexture(textureDescriptor('late replacement loss'))
        const oldTexture = texture.gpuTexture
        const oldVersion = texture.allocationVersion
        triggerOnLifecycleUnsubscribe(runtime, () => {
            fake.errors.loseDevice({ reason: 'unknown', message: 'loss after scope acknowledgement' })
        })

        const failure = await rejectedDiagnostic(texture.resize({ width: 8, height: 8 }))

        expect(failure.diagnostic.code).to.equal('SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION')
        expect(fake.calls.textures[1].destroyed).to.equal(true)
        expect(oldTexture.destroyed).to.equal(false)
        expect(texture.gpuTexture).to.equal(oldTexture)
        expect(texture.allocationVersion).to.equal(oldVersion)
        expect(runtime.diagnostics.operations().at(-1).status).to.equal('cancelled')
    })
})

function operationInput(index) {

    return {
        kind: 'buffer-allocation',
        target: {
            kind: 'resource',
            resourceId: `candidate-buffer-${index}`,
            resourceKind: 'BufferResource',
            allocationVersion: 1,
            contentEpoch: 0,
            logicalFootprintBytes: 64 + index,
        },
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

function triggerOnLifecycleUnsubscribe(runtime, trigger) {

    const controller = diagnosticsControllerFor(runtime)
    const subscribeLifecycle = controller.subscribeLifecycle.bind(controller)
    let triggered = false
    controller.subscribeLifecycle = subscriber => {
        const unsubscribe = subscribeLifecycle(subscriber)
        return () => {
            unsubscribe()
            if (triggered) return
            triggered = true
            trigger()
        }
    }
}

function textureDescriptor(label) {

    return {
        label,
        size: { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: 1,
    }
}
