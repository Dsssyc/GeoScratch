import { expect } from 'chai'
import * as scratch from '../packages/geoscratch/dist/scratch/index.js'

describe('Scratch GPU naming clean cut', () => {

    it('exports only the approved GPU runtime, diagnostics, capture, and pipeline values', () => {

        for (const name of [
            'GPURuntime',
            'GPURuntimeDiagnostics',
            'GPUDiagnosticCapture',
            'RenderPipeline',
            'ComputePipeline',
        ]) expect(scratch, name).to.have.property(name).that.is.a('function')

        for (const name of [
            'ScratchRuntime',
            'ScratchRuntimeDiagnostics',
            'ScratchDiagnosticCapture',
            'ScratchRenderPipeline',
            'ScratchComputePipeline',
        ]) expect(scratch, name).not.to.have.property(name)

        expect(scratch.GPURuntime.name).to.equal('GPURuntime')
        expect(scratch.GPURuntimeDiagnostics.name).to.equal('GPURuntimeDiagnostics')
        expect(scratch.GPUDiagnosticCapture.name).to.equal('GPUDiagnosticCapture')
        expect(scratch.RenderPipeline.name).to.equal('RenderPipeline')
        expect(scratch.ComputePipeline.name).to.equal('ComputePipeline')
    })
})
