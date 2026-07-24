import { expect } from 'chai'
import {
    ScratchRuntime,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

describe('scratch ShaderModule', () => {

    it('acknowledges one persistent native module with source-part compilation evidence', async() => {

        const { gpu, calls } = createFakeGpu({
            compilationMessages: [ {
                type: 'warning',
                message: 'portable warning',
                offset: 1,
                length: 1,
                lineNum: 1,
                linePos: 2,
            } ],
        })
        const runtime = await ScratchRuntime.create({ gpu })
        const promise = runtime.createShaderModule({
            label: 'shared shader',
            sourceParts: [
                {
                    label: 'shared declarations',
                    code: 'const scale = 1.0;',
                },
                {
                    label: 'compute entry',
                    code: '@compute @workgroup_size(1) fn main() {}',
                },
            ],
        })

        expect(promise).to.be.instanceOf(Promise)
        const shaderModule = await promise

        expect(shaderModule.runtime).to.equal(runtime)
        expect(shaderModule.label).to.equal('shared shader')
        expect(shaderModule.isDisposed).to.equal(false)
        expect(shaderModule.sourceParts.map(part => part.label)).to.deep.equal([
            'shared declarations',
            'compute entry',
        ])
        expect(shaderModule.sourceParts.map(part => part.hash))
            .to.deep.equal(shaderModule.compilationReport.sourceParts.map(part => part.hash))
        expect(shaderModule.compilationReport).to.deep.include({
            shaderModuleId: shaderModule.id,
            sourcePartCount: 2,
            errorCount: 0,
            warningCount: 1,
        })
        expect(calls.shaderModules).to.have.length(1)
        expect(calls.shaderModules[0]).to.equal(shaderModule.gpuShaderModule)
        expect(calls.shaderModules[0].descriptor.code).to.equal(
            'const scale = 1.0;\n@compute @workgroup_size(1) fn main() {}'
        )
        const [ operation ] = runtime.diagnostics.operations({
            kind: 'shader-module-creation',
            shaderModuleId: shaderModule.id,
        })
        expect(operation).to.deep.include({
            status: 'succeeded',
            target: {
                kind: 'shader-module',
                shaderModuleId: shaderModule.id,
                sourceHash: shaderModule.compilationReport.sourceHash,
                sourcePartCount: 2,
                compilationHintCount: 0,
            },
        })
        expect(JSON.stringify(operation)).not.to.include('const scale')
    })

    it('lowers entry-specific auto and explicit compilation hints without validity claims', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const bindLayout = await runtime.createBindLayout({
            group: 0,
            entries: [],
        })

        const shaderModule = await runtime.createShaderModule({
            sourceParts: [ {
                code: '@compute @workgroup_size(1) fn autoMain() {}',
            } ],
            compilationHints: [
                {
                    entryPoint: 'autoMain',
                    layout: 'auto',
                },
                {
                    entryPoint: 'explicitMain',
                    layout: {
                        bindLayouts: [ bindLayout ],
                    },
                },
                {
                    entryPoint: 'unspecifiedMain',
                },
            ],
        })

        expect(calls.pipelineLayouts).to.have.length(1)
        expect(calls.shaderModules[0].descriptor.compilationHints).to.deep.equal([
            {
                entryPoint: 'autoMain',
                layout: 'auto',
            },
            {
                entryPoint: 'explicitMain',
                layout: calls.pipelineLayouts[0],
            },
            {
                entryPoint: 'unspecifiedMain',
            },
        ])
        expect(shaderModule.compilationHints).to.deep.equal([
            {
                entryPoint: 'autoMain',
                layout: 'auto',
            },
            {
                entryPoint: 'explicitMain',
                layout: {
                    bindLayoutIds: [ bindLayout.id ],
                    immediateSize: 0,
                },
            },
            {
                entryPoint: 'unspecifiedMain',
            },
        ])
        expect(shaderModule).not.to.have.property('compilationHintsHonored')
    })

    it('attributes compilation rejection without retaining source text', async() => {

        const source = '@compute @workgroup_size(1) fn secretEntry() {}'
        const { gpu } = createFakeGpu({
            compilationMessages: [ {
                type: 'error',
                message: `invalid source near ${source}`,
                offset: 0,
                length: source.length,
                lineNum: 1,
                linePos: 1,
            } ],
        })
        const runtime = await ScratchRuntime.create({ gpu })

        try {
            await runtime.createShaderModule({
                sourceParts: [ { code: source } ],
            })
            throw new Error('expected ShaderModule rejection')
        } catch (error) {
            expect(error.diagnostic.code).to.equal('SCRATCH_SHADER_MODULE_COMPILATION_FAILED')
            expect(error.incident.failureStage).to.equal('shader-compilation')
            expect(error.incident.target.kind).to.equal('shader-module')
            expect(error.incident.shaderModuleCompilationReport).to.deep.include({
                shaderModuleId: error.incident.target.shaderModuleId,
                sourceHash: error.incident.target.sourceHash,
                errorCount: 1,
            })
        }

        const operation = runtime.diagnostics.operations({
            kind: 'shader-module-creation',
        })[0]
        expect(operation.status).to.equal('failed')
        expect(operation.incidentId).to.be.a('string')
        expect(JSON.stringify(runtime.diagnostics.exportEvidence())).not.to.include(source)
    })

    it('joins validation-scope and compilation failures without losing compilation evidence', async() => {

        const source = '@compute @workgroup_size(1) fn invalidEntry( {}'
        const validationError = Object.assign(
            new Error(`native validation rejected ${source}`),
            { name: 'GPUValidationError' }
        )
        const { gpu, errors } = createFakeGpu({
            compilationMessages: [ {
                type: 'error',
                message: `parse failure near ${source}`,
                offset: 36,
                length: 1,
                lineNum: 1,
                linePos: 37,
            } ],
        })
        errors.failNext('createShaderModule', 'validation', validationError)
        const runtime = await ScratchRuntime.create({ gpu })

        try {
            await runtime.createShaderModule({
                sourceParts: [ { label: 'invalid compute', code: source } ],
            })
            throw new Error('expected ShaderModule rejection')
        } catch (error) {
            expect(error.diagnostic.code).to.equal('SCRATCH_SHADER_MODULE_COMPILATION_FAILED')
            expect(error.incident.failureStage).to.equal('shader-compilation')
            expect(error.incident.shaderModuleCompilationReport).to.deep.include({
                shaderModuleId: error.incident.target.shaderModuleId,
                sourceHash: error.incident.target.sourceHash,
                sourcePartCount: 1,
                retainedSourcePartCount: 1,
                errorCount: 1,
            })
            const creationOutcome = error.incident.outcomes.find(outcome =>
                outcome.diagnosticCode === 'SCRATCH_SHADER_MODULE_CREATION_VALIDATION_FAILED'
            )
            expect(creationOutcome).to.deep.include({
                stage: 'scope-settlement',
                nativeErrorCategory: 'validation',
                subject: {
                    kind: 'ShaderModule',
                    id: error.incident.target.shaderModuleId,
                },
            })
            expect(creationOutcome.nativeError).to.deep.include({
                name: 'GPUValidationError',
                sourceExcerptRedacted: true,
            })
            expect(creationOutcome.nativeError.message).not.to.include(source)
            expect(error.incident.outcomes).to.deep.include({
                stage: 'shader-compilation',
                diagnosticCode: 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED',
                nativeErrorCategory: 'validation',
                subject: {
                    kind: 'ShaderModule',
                    id: error.incident.target.shaderModuleId,
                },
            })
        }

        const evidence = runtime.diagnostics.exportEvidence()
        expect(JSON.stringify(evidence)).not.to.include(source)
    })
})
