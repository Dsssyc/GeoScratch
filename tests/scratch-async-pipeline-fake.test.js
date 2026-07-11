import { expect } from 'chai'
import {
    createFakeGpu,
    createFakePipelineError,
} from './scratch-test-utils.js'

describe('fake WebGPU async pipeline state machine', () => {

    it('provides default compilation info and ready render/compute pipelines', async() => {

        const { device, calls } = createFakeGpu({
            compilationMessages: [ {
                type: 'warning',
                message: 'fake warning',
                offset: 3,
                length: 2,
                lineNum: 1,
                linePos: 4,
            } ],
        })
        const module = device.createShaderModule({ code: 'fake shader' })
        const layout = device.createPipelineLayout({ bindGroupLayouts: [] })

        const compilation = module.getCompilationInfo()
        const render = device.createRenderPipelineAsync({
            layout,
            vertex: { module },
        })
        const compute = device.createComputePipelineAsync({
            layout,
            compute: { module },
        })

        expect(await compilation).to.deep.equal({
            messages: [ {
                type: 'warning',
                message: 'fake warning',
                offset: 3,
                length: 2,
                lineNum: 1,
                linePos: 4,
            } ],
        })
        expect(await render).to.equal(calls.renderPipelines[0])
        expect(await compute).to.equal(calls.computePipelines[0])
        expect(calls.compilationInfoRequests).to.have.length(1)
        expect(calls.asyncPipelineRequests.map(request => request.kind)).to.deep.equal([
            'render',
            'compute',
        ])
    })

    it('settles compilation, pipeline, and scope promises in arbitrary order', async() => {

        const { device, errors, pipelines } = createFakeGpu({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        device.pushErrorScope('out-of-memory')
        device.pushErrorScope('internal')
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: 'fake shader' })
        const layout = device.createPipelineLayout({ bindGroupLayouts: [] })
        const compilation = module.getCompilationInfo()
        const pipeline = device.createRenderPipelineAsync({
            layout,
            vertex: { module },
        })
        const validation = device.popErrorScope()
        const internal = device.popErrorScope()
        const outOfMemory = device.popErrorScope()

        pipelines.resolvePipeline(0)
        errors.settlePop(2)
        pipelines.resolveCompilation(0, { messages: [] })
        errors.settlePop(0)
        errors.settlePop(1)

        expect(await pipeline).to.equal(pipelines.pipelineRequests[0].pipeline)
        expect(await compilation).to.deep.equal({ messages: [] })
        expect(await validation).to.equal(null)
        expect(await internal).to.equal(null)
        expect(await outOfMemory).to.equal(null)
    })

    it('rejects async pipeline creation without dispatching a GPUError', async() => {

        const { device, calls, pipelines } = createFakeGpu()
        const rejection = createFakePipelineError('validation', 'pipeline rejected')
        pipelines.rejectNextPipeline('render', rejection)

        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: 'fake shader' })
        const pipeline = device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module },
        })
        const scope = device.popErrorScope()

        await expectRejectedWith(pipeline, rejection)
        expect(await scope).to.equal(null)
        await Promise.resolve()
        expect(calls.uncapturedErrors).to.have.length(0)
        expect(calls.renderPipelines).to.have.length(0)

        const computeRejection = createFakePipelineError('internal', 'compute rejected')
        pipelines.rejectNextPipeline('compute', computeRejection)
        await expectRejectedWith(device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module },
        }), computeRejection)
        expect(calls.computePipelines).to.have.length(0)
    })

    it('defers configured compilation and pipeline rejections until explicit settlement', async() => {

        const { device, pipelines } = createFakeGpu({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
        })
        const compilationError = new Error('compilation info unavailable')
        const pipelineError = createFakePipelineError('internal', 'pipeline internal failure')
        pipelines.rejectNextCompilation(compilationError)
        pipelines.rejectNextPipeline('compute', pipelineError)
        const module = device.createShaderModule({ code: 'fake shader' })
        const compilation = module.getCompilationInfo()
        const pipeline = device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module },
        })

        pipelines.settlePipeline(0)
        pipelines.settleCompilation(0)

        await expectRejectedWith(compilation, compilationError)
        await expectRejectedWith(pipeline, pipelineError)
    })

    it('retains attempted issue order when a native method throws synchronously', () => {

        const shaderFake = createFakeGpu()
        const shaderError = new Error('synchronous shader module throw')
        shaderFake.errors.throwNext('createShaderModule', shaderError)

        expect(() => shaderFake.device.createShaderModule({ code: 'fake' })).to.throw(shaderError)
        expect(shaderFake.calls.nativeTimeline).to.deep.equal([
            { type: 'create-shader-module' },
        ])

        const pipelineFake = createFakeGpu()
        const pipelineError = new Error('synchronous async-pipeline throw')
        pipelineFake.errors.throwNext('createRenderPipelineAsync', pipelineError)

        expect(() => pipelineFake.device.createRenderPipelineAsync({})).to.throw(pipelineError)
        expect(pipelineFake.calls.nativeTimeline).to.deep.equal([
            { type: 'create-render-pipeline-async' },
        ])
    })

    it('captures supporting-object errors in the innermost matching scope', async() => {

        const { device, errors } = createFakeGpu()
        const validationError = Object.assign(new Error('invalid module'), {
            name: 'GPUValidationError',
        })
        const internalError = Object.assign(new Error('layout failed'), {
            name: 'GPUInternalError',
        })

        device.pushErrorScope('internal')
        device.pushErrorScope('validation')
        errors.failNext('createShaderModule', 'validation', validationError)
        device.createShaderModule({ code: 'invalid' })
        errors.failNext('createPipelineLayout', 'internal', internalError)
        device.createPipelineLayout({ bindGroupLayouts: [] })
        const validation = device.popErrorScope()
        const internal = device.popErrorScope()

        expect(await validation).to.equal(validationError)
        expect(await internal).to.equal(internalError)

        const oomError = Object.assign(new Error('module allocation failed'), {
            name: 'GPUOutOfMemoryError',
        })
        device.pushErrorScope('out-of-memory')
        errors.failNext('createShaderModule', 'out-of-memory', oomError)
        device.createShaderModule({ code: 'large shader' })
        expect(await device.popErrorScope()).to.equal(oomError)
    })

    it('supports concurrent render/compute settlement around device loss', async() => {

        const { device, calls, errors, pipelines } = createFakeGpu({
            deferAsyncPipelines: true,
        })
        const module = device.createShaderModule({ code: 'fake shader' })
        const render = device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module },
        })
        const compute = device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module },
        })

        errors.loseDevice({ reason: 'unknown', message: 'interleaved loss' })
        pipelines.resolvePipeline(1)
        pipelines.resolvePipeline(0)

        expect(await device.lost).to.deep.equal({ reason: 'unknown', message: 'interleaved loss' })
        expect(await compute).to.equal(calls.computePipelines[0])
        expect(await render).to.equal(calls.renderPipelines[0])
        expect(calls.asyncPipelineRequests.map(request => request.kind)).to.deep.equal([
            'render',
            'compute',
        ])
    })

    it('records one exact native issue timeline', async() => {

        const { device, calls } = createFakeGpu()

        device.pushErrorScope('out-of-memory')
        device.pushErrorScope('internal')
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ code: 'fake shader' })
        const layout = device.createPipelineLayout({ bindGroupLayouts: [] })
        const compilation = module.getCompilationInfo()
        const pipeline = device.createComputePipelineAsync({
            layout,
            compute: { module },
        })
        const validation = device.popErrorScope()
        const internal = device.popErrorScope()
        const outOfMemory = device.popErrorScope()

        expect(calls.nativeTimeline).to.deep.equal([
            { type: 'push-error-scope', filter: 'out-of-memory' },
            { type: 'push-error-scope', filter: 'internal' },
            { type: 'push-error-scope', filter: 'validation' },
            { type: 'create-shader-module' },
            { type: 'create-pipeline-layout' },
            { type: 'get-compilation-info' },
            { type: 'create-compute-pipeline-async' },
            { type: 'pop-error-scope', filter: 'validation' },
            { type: 'pop-error-scope', filter: 'internal' },
            { type: 'pop-error-scope', filter: 'out-of-memory' },
        ])
        await Promise.all([ compilation, pipeline, validation, internal, outOfMemory ])
    })
})

async function expectRejectedWith(promise, expected) {

    try {
        await promise
        throw new Error('expected promise to reject')
    } catch (error) {
        expect(error).to.equal(expected)
    }
}
