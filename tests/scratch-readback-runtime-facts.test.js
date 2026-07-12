import { expect } from 'chai'
import * as scr from 'geoscratch'
import { diagnosticsControllerFor } from '../packages/geoscratch/dist/scratch/runtime-diagnostics.js'
import { createFakeGpu } from './scratch-test-utils.js'

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

function commandFact(id = 'readback-command-1') {

    return {
        id,
        label: 'runtime fact command',
        sourceResourceId: 'buffer-1',
        allocationVersion: 1,
        contentEpoch: 2,
        byteLength: 16,
        state: 'idle',
        stagingAllocationOperationId: 'allocation-1',
    }
}

function operationFact(id = 'readback-operation-1') {

    return {
        id,
        label: 'runtime fact operation',
        path: 'direct',
        state: 'requested',
        retain: 'consume-on-read',
        sourceResourceId: 'buffer-1',
        allocationVersion: 1,
        contentEpoch: 2,
        byteLength: 16,
        stagingBytes: 0,
        retainedHostBytes: 0,
        isMapping: false,
    }
}

describe('scratch readback runtime facts', () => {

    it('publishes finite default readback policy and empty current facts', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const snapshot = runtime.diagnostics.snapshot()

        expect(runtime.readbackPolicy).to.deep.equal({
            maxPendingOperations: 16,
            maxStagingBytes: 64 * 1024 * 1024,
        })
        expect(Object.isFrozen(runtime.readbackPolicy)).to.equal(true)
        expect(snapshot.readbackCommands).to.deep.equal([])
        expect(snapshot.readbacks).to.deep.equal([])
        expect(snapshot.readbackMemory).to.deep.equal({
            maxPendingOperations: 16,
            maxStagingBytes: 64 * 1024 * 1024,
            currentStagingBytes: 0,
            peakStagingBytes: 0,
            currentRetainedHostBytes: 0,
            peakRetainedHostBytes: 0,
            activeMappings: 0,
            peakActiveMappings: 0,
        })
        expect(Object.isFrozen(snapshot.readbackCommands)).to.equal(true)
        expect(Object.isFrozen(snapshot.readbacks)).to.equal(true)
        expect(Object.isFrozen(snapshot.readbackMemory)).to.equal(true)
    })

    it('rejects invalid readback policy before requesting an adapter', async () => {

        for (const [ name, value ] of [
            [ 'maxPendingOperations', 0 ],
            [ 'maxPendingOperations', 1.5 ],
            [ 'maxStagingBytes', -1 ],
            [ 'maxStagingBytes', Number.POSITIVE_INFINITY ],
            [ 'maxStagingBytes', null ],
        ]) {
            const fake = createFakeGpu()
            let adapterRequests = 0
            const gpu = {
                ...fake.gpu,
                async requestAdapter(options) {
                    adapterRequests++
                    return fake.gpu.requestAdapter(options)
                },
            }

            const diagnostic = await expectScratchDiagnostic(
                () => scr.ScratchRuntime.create({
                    gpu,
                    readback: { [name]: value },
                }),
                {
                    code: 'SCRATCH_READBACK_POLICY_INVALID',
                    severity: 'error',
                    phase: 'runtime',
                }
            )
            expect(diagnostic.actual).to.deep.equal({ [name]: value })
            expect(adapterRequests).to.equal(0)
        }
    })

    it('tracks immutable command and operation facts without native handles', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const controller = diagnosticsControllerFor(runtime)
        controller.registerReadbackCommand(commandFact())
        controller.registerReadbackOperation(operationFact())
        controller.updateReadbackCommand('readback-command-1', { state: 'submitted' })
        controller.updateReadbackOperation('readback-operation-1', {
            state: 'mapping',
            stagingBytes: 16,
            isMapping: true,
            commandId: 'readback-command-1',
            submissionId: 'submission-1',
            stepIndex: 3,
        })

        const snapshot = runtime.diagnostics.snapshot()
        expect(snapshot.readbackCommands).to.deep.equal([ {
            ...commandFact(),
            state: 'submitted',
        } ])
        expect(snapshot.readbacks).to.deep.equal([ {
            ...operationFact(),
            state: 'mapping',
            stagingBytes: 16,
            isMapping: true,
            commandId: 'readback-command-1',
            submissionId: 'submission-1',
            stepIndex: 3,
        } ])
        expect(snapshot.readbackMemory.activeMappings).to.equal(0)
        expect(snapshot.readbackMemory.peakActiveMappings).to.equal(0)
        expect(JSON.stringify(snapshot)).not.to.include('GPUBuffer')
        expect(Object.isFrozen(snapshot.readbackCommands[0])).to.equal(true)
        expect(Object.isFrozen(snapshot.readbacks[0])).to.equal(true)
    })

    it('enforces pending-operation and staging-byte budgets without partial mutation', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            readback: {
                maxPendingOperations: 1,
                maxStagingBytes: 16,
            },
        })
        const controller = diagnosticsControllerFor(runtime)
        controller.registerReadbackOperation(operationFact('operation-1'))

        const pendingDiagnostic = await expectScratchDiagnostic(
            () => controller.registerReadbackOperation(operationFact('operation-2')),
            {
                code: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
                severity: 'error',
                phase: 'readback',
            }
        )
        const pendingIncident = runtime.diagnostics.incidents({ readbackId: 'operation-2' }).at(-1)
        expect(pendingDiagnostic.subject).to.deep.include({
            kind: 'ReadbackOperation',
            id: 'operation-2',
        })
        expect(pendingDiagnostic.actual).to.deep.include({
            currentPendingOperations: 1,
            requested: 1,
            readbackId: 'operation-2',
        })
        expect(pendingIncident).to.deep.include({
            kind: 'readback-failure',
            diagnosticCode: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
            attribution: 'exact-operation',
            failureStage: 'budget',
        })
        expect(pendingIncident.target).to.deep.include({
            kind: 'readback',
            readbackId: 'operation-2',
            path: 'direct',
            sourceResourceId: 'buffer-1',
        })
        const reservation = controller.reserveReadbackStaging('reservation-1', 12)
        await expectScratchDiagnostic(
            () => controller.reserveReadbackStaging('reservation-2', 8),
            {
                code: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
                severity: 'error',
                phase: 'readback',
            }
        )

        let snapshot = runtime.diagnostics.snapshot()
        expect(snapshot.readbacks.map(fact => fact.id)).to.deep.equal([ 'operation-1' ])
        expect(snapshot.readbackMemory.currentStagingBytes).to.equal(12)
        expect(snapshot.readbackMemory.peakStagingBytes).to.equal(12)

        reservation.release()
        snapshot = runtime.diagnostics.snapshot()
        expect(reservation.isReleased).to.equal(true)
        expect(snapshot.readbackMemory.currentStagingBytes).to.equal(0)
        expect(snapshot.readbackMemory.peakStagingBytes).to.equal(12)
    })

    it('accounts retained host bytes separately and returns current facts to zero under churn', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({
            gpu: fake.gpu,
            readback: {
                maxPendingOperations: 1,
                maxStagingBytes: 16,
            },
        })
        const controller = diagnosticsControllerFor(runtime)

        for (let index = 0; index < 256; index++) {
            const id = `operation-${index}`
            const reservation = controller.reserveReadbackStaging(`reservation-${index}`, 16)
            controller.registerReadbackOperation(operationFact(id))
            controller.updateReadbackOperation(id, {
                state: 'ready',
                retainedHostBytes: 16,
            })
            reservation.release()
            controller.unregisterReadbackOperation(id)
        }

        const snapshot = runtime.diagnostics.snapshot()
        expect(snapshot.readbacks).to.have.length(0)
        expect(snapshot.readbackCommands).to.have.length(0)
        expect(snapshot.readbackMemory).to.deep.include({
            currentStagingBytes: 0,
            peakStagingBytes: 16,
            currentRetainedHostBytes: 0,
            peakRetainedHostBytes: 16,
            activeMappings: 0,
        })
    })
})
