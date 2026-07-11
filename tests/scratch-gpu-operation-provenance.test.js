import { expect } from 'chai'
import {
    createGpuIncidentReport,
    createGpuOperationRecord,
    serializeNativeGpuError,
} from '../packages/geoscratch/dist/scratch/gpu-operation.js'
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
