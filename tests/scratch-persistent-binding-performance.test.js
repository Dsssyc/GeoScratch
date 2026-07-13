import { expect } from 'chai'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const runner = path.join(process.cwd(), 'tests', 'stress', 'scratch-persistent-binding-views.mjs')

describe('Scratch persistent binding performance gate', () => {

    it('locks the full 20,000-cycle structural counter contract in the runner', () => {

        const source = fs.readFileSync(runner, 'utf8')

        expect(source).to.include('20_000')
        expect(source).to.include('bindGroupCount')
        expect(source).to.include('textureViewCount')
        expect(source).to.include('scopePushCount')
        expect(source).to.include('scopePopCount')
        expect(source).to.include('preparationOperationCount')
        expect(source).to.include('prepareGeneration')
        expect(source).to.include('nativeOffsetIdentityChanges')
        expect(source).to.include('dynamicOffsetNameMapReads')
        expect(source).to.include('SCRATCH_BIND_SET_STALE')
        expect(source).to.include('firstPrepare === sameSnapshotPrepare')
    })

    it('executes the same gate in a short deterministic regression profile', function() {

        this.timeout(10_000)
        const output = execFileSync(process.execPath, [ runner ], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
                ...process.env,
                SCRATCH_BINDING_STRESS_ALLOW_SHORT: '1',
                SCRATCH_BINDING_STRESS_ITERATIONS: '64',
            },
        })
        const result = JSON.parse(output)

        expect(result.verification.status).to.equal('passed')
        expect(result.firstSteadyState.cycles).to.equal(64)
        expect(result.secondSteadyState.cycles).to.equal(64)
        expect(bindingDeltas(result.firstSteadyState)).to.deep.equal(zeroBindingDeltas())
        expect(bindingDeltas(result.secondSteadyState)).to.deep.equal(zeroBindingDeltas())
        expect(result.firstSteadyState.nativeOffsetIdentityChanges).to.equal(0)
        expect(result.secondSteadyState.nativeOffsetIdentityChanges).to.equal(0)
        expect(result.firstSteadyState.dynamicOffsetNameMapReads).to.equal(0)
        expect(result.secondSteadyState.dynamicOffsetNameMapReads).to.equal(0)
        expect(result.replacement).to.deep.include({
            staleDiagnosticCode: 'SCRATCH_BIND_SET_STALE',
            commandEncodersCreatedByStaleSubmission: 0,
            concurrentPromiseShared: true,
            bindGroupsCreated: 1,
            textureViewsCreated: 1,
            preparationOperationsCreated: 1,
            nativeBindGroupChanged: true,
            candidateLocalViewChanged: true,
        })
        expect(result.replacement.generationAfter - result.replacement.generationBefore).to.equal(1)
    })
})

function bindingDeltas(phase) {

    const before = phase.countersBefore
    const after = phase.countersAfter
    return {
        bindGroups: after.bindGroupCount - before.bindGroupCount,
        textureViews: after.textureViewCount - before.textureViewCount,
        scopePushes: after.scopePushCount - before.scopePushCount,
        scopePops: after.scopePopCount - before.scopePopCount,
        preparationOperations:
            after.preparationOperationCount - before.preparationOperationCount,
        allocationAttempts: after.allocationAttemptCount - before.allocationAttemptCount,
        prepareGeneration: after.prepareGeneration - before.prepareGeneration,
        snapshotChanged: after.preparedSnapshotHash !== before.preparedSnapshotHash,
    }
}

function zeroBindingDeltas() {

    return {
        bindGroups: 0,
        textureViews: 0,
        scopePushes: 0,
        scopePops: 0,
        preparationOperations: 0,
        allocationAttempts: 0,
        prepareGeneration: 0,
        snapshotChanged: false,
    }
}
