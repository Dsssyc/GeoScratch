import { expect } from 'chai'
import { Director } from '../packages/geoscratch/src/gpu/director/director.js'
import { RenderPass } from '../packages/geoscratch/src/gpu/pass/renderPass.js'
import { ComputePipeline } from '../packages/geoscratch/src/gpu/pipeline/computePipeline.js'

describe('runtime performance contracts', () => {

    it('does not submit an empty queue when no visible stages produce work', () => {

        const director = new Director()
        let submitCount = 0
        director.device = {
            queue: {
                submit: () => { submitCount++ },
            },
            createCommandEncoder: () => {
                throw new Error('no encoder should be created')
            },
        }
        director.addStage({ name: 'hidden', items: [], visibility: false })

        director.tickRender()

        expect(submitCount).to.equal(0)
    })

    it('lets RenderPass.update run more than once without replacing initialize()', () => {

        const texture = {
            texture: { width: 1, height: 1 },
            format: 'rgba8unorm',
            view: () => ({}),
            registerCallback: () => 0,
        }
        const pass = new RenderPass({
            name: 'repeatable render pass',
            colorAttachments: [ { colorResource: texture } ],
        })

        pass.update()
        pass.dirty = true
        pass.update()

        expect(pass.initialized).to.equal(true)
        expect(pass.initialize).to.be.a('function')
    })

    it('creates compute pipelines from isComplete without an undefined renderPass reference', () => {

        const pipeline = Object.create(ComputePipeline.prototype)
        const binding = {}
        let receivedBinding

        pipeline.pipeline = undefined
        pipeline.pipelineCreating = false
        pipeline.createPipeline = (nextBinding) => {
            receivedBinding = nextBinding
        }

        expect(() => pipeline.isComplete({}, binding)).not.to.throw()
        expect(receivedBinding).to.equal(binding)
    })
})
