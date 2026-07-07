import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
} from 'geoscratch'

describe('scratch diagnostics', () => {

    it('creates machine-readable diagnostics with stable fields', () => {

        const diagnostic = createScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
            subject: { kind: 'Resource', id: 'buffer-a', resourceKind: 'BufferResource' },
            message: 'Resource belongs to a different ScratchRuntime.',
            expected: { runtimeId: 'runtime-a' },
            actual: { runtimeId: 'runtime-b' },
            hints: [ 'Use resources with the runtime that created them.' ],
            related: [
                { kind: 'ScratchRuntime', id: 'runtime-a' },
            ],
        })

        expect(diagnostic).to.deep.equal({
            version: 1,
            code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
            severity: 'error',
            phase: 'resource',
            subject: { kind: 'Resource', id: 'buffer-a', resourceKind: 'BufferResource' },
            message: 'Resource belongs to a different ScratchRuntime.',
            expected: { runtimeId: 'runtime-a' },
            actual: { runtimeId: 'runtime-b' },
            hints: [ 'Use resources with the runtime that created them.' ],
            related: [
                { kind: 'ScratchRuntime', id: 'runtime-a' },
            ],
        })
    })

    it('builds deterministic diagnostic reports and errors', () => {

        const warning = createScratchDiagnostic({
            code: 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
            severity: 'warn',
            phase: 'program',
            subject: { kind: 'Program', id: 'program-a' },
            message: 'Shader reflection could not verify the explicit layout.',
        })
        const errorDiagnostic = createScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DISPOSED',
            severity: 'error',
            phase: 'runtime',
            subject: { kind: 'ScratchRuntime', id: 'runtime-a' },
            message: 'ScratchRuntime has been disposed.',
        })

        const report = createScratchDiagnosticReport([ warning, errorDiagnostic ])
        const error = new ScratchDiagnosticError(errorDiagnostic, report)

        expect(report).to.deep.equal({
            version: 1,
            diagnostics: [ warning, errorDiagnostic ],
            hasErrors: true,
            errorCount: 1,
            warningCount: 1,
        })
        expect(error).to.be.instanceOf(Error)
        expect(error.name).to.equal('ScratchDiagnosticError')
        expect(error.message).to.equal(errorDiagnostic.message)
        expect(error.diagnostic).to.equal(errorDiagnostic)
        expect(error.report).to.equal(report)
    })
})
