import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
    isScratchDiagnosticError,
} from 'geoscratch/scratch'
import { WorkerSystem } from 'geoscratch/scratch'

describe('Scratch foundation diagnostics', () => {

    it('copies and freezes library-owned envelope structure without freezing opaque facts', () => {

        const subject = { kind: 'Resource', id: 'buffer-a', resourceKind: 'BufferResource' }
        const hints = [ 'Use the owning runtime.' ]
        const related = [ { kind: 'GPURuntime', id: 'runtime-a' } ]
        const suggestions = [ {
            kind: 'replace-runtime',
            confidence: 'high',
            target: { kind: 'Resource', id: 'buffer-a' },
            action: 'edit',
        } ]
        const evidence = [ { kind: 'runtime-id', value: 'runtime-b' } ]
        const expected = { runtimeId: 'runtime-a' }
        const actual = { runtimeId: 'runtime-b' }
        const diagnostic = createScratchDiagnostic({
            domain: 'gpu',
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
            subject,
            message: 'Resource belongs to a different GPURuntime.',
            expected,
            actual,
            hints,
            related,
            suggestions,
            evidence,
        })

        subject.id = 'mutated'
        hints.push('mutated')
        related[0].id = 'mutated'
        suggestions[0].target.id = 'mutated'
        evidence[0].kind = 'mutated'

        expect(diagnostic).to.deep.include({
            version: 1,
            domain: 'gpu',
            subject: { kind: 'Resource', id: 'buffer-a', resourceKind: 'BufferResource' },
            hints: [ 'Use the owning runtime.' ],
            related: [ { kind: 'GPURuntime', id: 'runtime-a' } ],
        })
        expect(diagnostic.suggestions[0].target.id).to.equal('buffer-a')
        expect(diagnostic.evidence[0].kind).to.equal('runtime-id')
        expect(diagnostic.expected).to.equal(expected)
        expect(diagnostic.actual).to.equal(actual)
        expect(Object.isFrozen(expected)).to.equal(false)
        expect(Object.isFrozen(actual)).to.equal(false)
        expect(Object.isFrozen(diagnostic)).to.equal(true)
        expect(Object.isFrozen(diagnostic.subject)).to.equal(true)
        expect(Object.isFrozen(diagnostic.hints)).to.equal(true)
        expect(Object.isFrozen(diagnostic.related[0])).to.equal(true)
        expect(Object.isFrozen(diagnostic.suggestions[0])).to.equal(true)
        expect(Object.isFrozen(diagnostic.suggestions[0].target)).to.equal(true)
        expect(Object.isFrozen(diagnostic.evidence[0])).to.equal(true)
    })

    it('brands GPU and Worker errors and enforces context-domain agreement', async() => {

        const gpuDiagnostic = createScratchDiagnostic({
            domain: 'gpu',
            code: 'SCRATCH_RUNTIME_DISPOSED',
            phase: 'runtime',
            subject: { kind: 'GPURuntime', id: 'runtime-a' },
            message: 'GPURuntime has been disposed.',
        })
        const gpuReport = createScratchDiagnosticReport([ gpuDiagnostic ])
        const gpuError = new ScratchDiagnosticError(gpuDiagnostic, gpuReport, {
            context: { domain: 'gpu' },
        })

        expect(gpuError).to.be.instanceOf(ScratchDiagnosticError)
        expect(isScratchDiagnosticError(gpuError)).to.equal(true)
        expect(isScratchDiagnosticError({
            name: 'ScratchDiagnosticError',
            diagnostic: gpuDiagnostic,
            report: gpuReport,
        })).to.equal(false)
        expect(() => new ScratchDiagnosticError(gpuDiagnostic, gpuReport, {
            context: { domain: 'worker' },
        })).to.throw(TypeError, 'context domain')

        const system = new WorkerSystem({ maxWorkers: 1 })
        let workerError
        try {
            system.createGroup({
                id: 'too-large',
                modules: [],
                isolation: 'group',
                size: { min: 2, max: 2 },
                maxQueuedTasks: 1,
                maxActiveTasks: 1,
                idleTimeoutMs: 1,
            })
        } catch (error) {
            workerError = error
        }
        await system.dispose()

        expect(workerError).to.be.instanceOf(ScratchDiagnosticError)
        expect(isScratchDiagnosticError(workerError)).to.equal(true)
        expect(workerError.diagnostic.domain).to.equal('worker')
        expect(workerError.context?.domain).to.equal('worker')
        expect(workerError).not.to.have.property('incident')
    })

    it('freezes mixed-domain reports without reinterpreting domain codes', () => {

        const gpu = createScratchDiagnostic({
            domain: 'gpu',
            code: 'GPU_WARNING',
            severity: 'warn',
            phase: 'runtime',
            subject: { kind: 'GPURuntime', id: 'runtime-a' },
        })
        const worker = createScratchDiagnostic({
            domain: 'worker',
            code: 'WORKER_TASK_FAILED',
            severity: 'error',
            phase: 'worker-task',
            subject: { kind: 'WorkerTask', id: 'task-a' },
        })
        const report = createScratchDiagnosticReport([ gpu, worker ])

        expect(report).to.deep.include({
            version: 1,
            hasErrors: true,
            errorCount: 1,
            warningCount: 1,
        })
        expect(report.diagnostics).to.deep.equal([ gpu, worker ])
        expect(Object.isFrozen(report)).to.equal(true)
        expect(Object.isFrozen(report.diagnostics)).to.equal(true)
    })

    it('normalizes mutable report inputs into immutable diagnostic entries', () => {

        const mutableDiagnostic = {
            version: 1,
            domain: 'gpu',
            code: 'MUTABLE_REPORT_INPUT',
            severity: 'warn',
            phase: 'runtime',
            subject: { kind: 'GPURuntime', id: 'runtime-a' },
            message: 'Mutable report input.',
            hints: [ 'original' ],
        }
        const report = createScratchDiagnosticReport([ mutableDiagnostic ])

        mutableDiagnostic.subject.id = 'mutated'
        mutableDiagnostic.hints.push('mutated')

        expect(report.diagnostics[0].subject.id).to.equal('runtime-a')
        expect(report.diagnostics[0].hints).to.deep.equal([ 'original' ])
        expect(Object.isFrozen(report.diagnostics[0])).to.equal(true)
        expect(Object.isFrozen(report.diagnostics[0].subject)).to.equal(true)
        expect(Object.isFrozen(report.diagnostics[0].hints)).to.equal(true)
    })

    it('normalizes mutable constructor inputs into immutable public facts', () => {

        const expected = { retained: true }
        const mutableDiagnostic = {
            version: 1,
            domain: 'gpu',
            code: 'MUTABLE_CALLER_INPUT',
            severity: 'error',
            phase: 'runtime',
            subject: { kind: 'GPURuntime', id: 'runtime-a' },
            message: 'Mutable caller input.',
            expected,
            hints: [ 'original' ],
        }
        const mutableReport = {
            version: 1,
            diagnostics: [ mutableDiagnostic ],
            hasErrors: true,
            errorCount: 1,
            warningCount: 0,
        }
        const error = new ScratchDiagnosticError(mutableDiagnostic, mutableReport)

        mutableDiagnostic.subject.id = 'mutated'
        mutableDiagnostic.hints.push('mutated')
        mutableReport.diagnostics.length = 0

        expect(error.diagnostic.subject.id).to.equal('runtime-a')
        expect(error.diagnostic.hints).to.deep.equal([ 'original' ])
        expect(error.diagnostic.expected).to.equal(expected)
        expect(error.report.diagnostics).to.deep.equal([ error.diagnostic ])
        expect(Object.isFrozen(error.diagnostic)).to.equal(true)
        expect(Object.isFrozen(error.report)).to.equal(true)
        expect(Object.isFrozen(error.report.diagnostics)).to.equal(true)
    })
})
