import { expect } from 'chai'
import {
    Program,
    ScratchDiagnosticError,
    ScratchRuntime,
} from '../packages/geoscratch/src/index.js'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

describe('scratch Program', () => {

    it('creates an explicit runtime-owned shader contract without resources', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        const program = runtime.createProgram({
            label: 'hello triangle program',
            modules: [ triangleWgsl ],
            entryPoints: {
                vertex: 'vsMain',
                fragment: 'fsMain',
            },
            requiredFeatures: [ 'timestamp-query' ],
        })

        expect(program).to.be.instanceOf(Program)
        expect(program.runtime).to.equal(runtime)
        expect(program.id).to.be.a('string').and.not.equal('')
        expect(program.label).to.equal('hello triangle program')
        expect(program.modules).to.deep.equal([ triangleWgsl ])
        expect(program.entryPoints).to.deep.equal({
            vertex: 'vsMain',
            fragment: 'fsMain',
        })
        expect(program.requiredFeatures).to.deep.equal([ 'timestamp-query' ])
        expect(program.isDisposed).to.equal(false)
        expect(program.bindSets).to.equal(undefined)
        expect(program.resources).to.equal(undefined)
    })

    it('rejects unavailable required features with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })

        try {
            runtime.createProgram({
                modules: [ triangleWgsl ],
                entryPoints: {
                    vertex: 'vsMain',
                    fragment: 'fsMain',
                },
                requiredFeatures: [ 'texture-compression-astc' ],
            })
            throw new Error('expected feature validation to fail')
        } catch (error) {
            expect(error).to.be.instanceOf(ScratchDiagnosticError)
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE',
                severity: 'error',
                phase: 'program',
            })
            expect(error.diagnostic.expected).to.deep.equal({
                feature: 'texture-compression-astc',
            })
        }
    })

    it('rejects use after disposal with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const program = runtime.createProgram({
            label: 'hello triangle program',
            modules: [ triangleWgsl ],
            entryPoints: {
                vertex: 'vsMain',
                fragment: 'fsMain',
            },
        })

        program.dispose()

        expect(() => program.assertUsable()).to.throw(ScratchDiagnosticError)
        try {
            program.assertUsable()
        } catch (error) {
            expect(error.diagnostic).to.include({
                code: 'SCRATCH_PROGRAM_DISPOSED',
                severity: 'error',
                phase: 'program',
            })
            expect(error.diagnostic.subject).to.deep.equal({
                kind: 'Program',
                id: program.id,
                label: 'hello triangle program',
            })
        }
    })
})
