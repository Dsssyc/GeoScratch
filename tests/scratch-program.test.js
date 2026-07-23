import { expect } from 'chai'
import {
    Program,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu, triangleWgsl } from './scratch-test-utils.js'

describe('scratch Program', () => {

    it('captures ShaderModule stage contracts, override facts, and device limits', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const vertexModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const fragmentModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const program = runtime.createProgram({
            label: 'split triangle program',
            vertex: {
                module: vertexModule,
                entryPoint: 'vsMain',
                constants: { scale: 2 },
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fsMain',
                constants: { alpha: 0.5 },
            },
            requiredFeatures: [ 'timestamp-query' ],
            requiredLimits: {
                maxBindGroups: 2,
                minUniformBufferOffsetAlignment: 256,
            },
        })

        expect(program.vertex).to.deep.equal({
            module: vertexModule,
            entryPoint: 'vsMain',
            constants: { scale: 2 },
        })
        expect(program.fragment).to.deep.equal({
            module: fragmentModule,
            entryPoint: 'fsMain',
            constants: { alpha: 0.5 },
        })
        expect(program.compute).to.equal(undefined)
        expect(program.requiredLimits).to.deep.equal({
            maxBindGroups: 2,
            minUniformBufferOffsetAlignment: 256,
        })
        expect(program).not.to.have.property('modules')
        expect(program).not.to.have.property('entryPoints')
        expect(Object.isFrozen(program.vertex)).to.equal(true)
        expect(Object.isFrozen(program.vertex.constants)).to.equal(true)
    })

    it('creates an explicit runtime-owned shader contract without resources', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const shaderModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const program = runtime.createProgram({
            label: 'hello triangle program',
            vertex: {
                module: shaderModule,
                entryPoint: 'vsMain',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fsMain',
            },
            requiredFeatures: [ 'timestamp-query' ],
        })

        expect(program).to.be.instanceOf(Program)
        expect(program.runtime).to.equal(runtime)
        expect(program.id).to.be.a('string').and.not.equal('')
        expect(program.label).to.equal('hello triangle program')
        expect(program.vertex.module).to.equal(shaderModule)
        expect(program.fragment.module).to.equal(shaderModule)
        expect(program.requiredFeatures).to.deep.equal([ 'timestamp-query' ])
        expect(program.isDisposed).to.equal(false)
        expect(program.bindSets).to.equal(undefined)
        expect(program.resources).to.equal(undefined)
    })

    it('rejects unavailable required features with structured diagnostics', async() => {

        const { gpu } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const shaderModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })

        try {
            runtime.createProgram({
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vsMain',
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
        const shaderModule = await runtime.createShaderModule({
            sourceParts: [ { code: triangleWgsl } ],
        })
        const program = runtime.createProgram({
            label: 'hello triangle program',
            vertex: {
                module: shaderModule,
                entryPoint: 'vsMain',
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
