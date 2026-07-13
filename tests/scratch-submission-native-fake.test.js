import { expect } from 'chai'
import { createFakeGpu } from './scratch-test-utils.js'

describe('fake WebGPU submission native outcomes', () => {

    it('injects scoped failures across encoder, pass, finish, and queue methods', async () => {

        const cases = [
            [ 'createCommandEncoder', fake => fake.device.createCommandEncoder({ label: 'create' }) ],
            [ 'beginRenderPass', fake => fake.device.createCommandEncoder().beginRenderPass({}) ],
            [ 'beginComputePass', fake => fake.device.createCommandEncoder().beginComputePass({}) ],
            [ 'copyBufferToBuffer', fake => {
                const source = fake.device.createBuffer({ size: 4 })
                const target = fake.device.createBuffer({ size: 4 })
                fake.device.createCommandEncoder().copyBufferToBuffer(source, 0, target, 0, 4)
            } ],
            [ 'renderPassEnd', fake => fake.device.createCommandEncoder().beginRenderPass({}).end() ],
            [ 'computePassEnd', fake => fake.device.createCommandEncoder().beginComputePass({}).end() ],
            [ 'finish', fake => fake.device.createCommandEncoder().finish() ],
            [ 'writeBuffer', fake => {
                const target = fake.device.createBuffer({ size: 4 })
                fake.queue.writeBuffer(target, 0, new Uint8Array([ 1, 2, 3, 4 ]))
            } ],
            [ 'writeTexture', fake => {
                const target = fake.device.createTexture({ size: [ 1, 1 ], format: 'rgba8unorm' })
                fake.queue.writeTexture({ texture: target }, new Uint8Array(4), {}, [ 1, 1 ])
            } ],
            [ 'copyExternalImageToTexture', fake => {
                const target = fake.device.createTexture({ size: [ 1, 1 ], format: 'rgba8unorm' })
                fake.queue.copyExternalImageToTexture({ source: {} }, { texture: target }, [ 1, 1 ])
            } ],
            [ 'submit', fake => fake.queue.submit([ fake.device.createCommandEncoder().finish() ]) ],
        ]

        for (const [ method, issue ] of cases) {
            const fake = createFakeGpu()
            const expected = new Error(`fake ${method} validation`)
            fake.device.pushErrorScope('validation')
            fake.errors.failNext(method, 'validation', expected)

            issue(fake)

            expect(await fake.device.popErrorScope()).to.equal(expected)
            expect(fake.calls.nativeTimeline).to.deep.include({
                type: 'native-method',
                method,
            })
            expect(fake.errors.scopeDepth).to.equal(0)
        }
    })

    it('marks failed encoder work invalid and prevents command-buffer effects', async () => {

        const fake = createFakeGpu()
        const source = fake.device.createBuffer({ size: 4 })
        const target = fake.device.createBuffer({ size: 4 })
        source.data.set([ 7, 8, 9, 10 ])
        const expected = new Error('fake copy validation')

        fake.device.pushErrorScope('validation')
        fake.errors.failNext('copyBufferToBuffer', 'validation', expected)
        const encoder = fake.device.createCommandEncoder({ label: 'invalid copy encoder' })
        encoder.copyBufferToBuffer(source, 0, target, 0, 4)
        const commandBuffer = encoder.finish()
        fake.queue.submit([ commandBuffer ])

        expect(await fake.device.popErrorScope()).to.equal(expected)
        expect(encoder.invalid).to.equal(true)
        expect(commandBuffer.invalid).to.equal(true)
        expect([ ...target.data ]).to.deep.equal([ 0, 0, 0, 0 ])
    })

    it('throws configured synchronous queue failures before side effects', () => {

        const cases = [
            [ 'writeBuffer', fake => {
                const target = fake.device.createBuffer({ size: 4 })
                fake.queue.writeBuffer(target, 0, new Uint8Array([ 1, 2, 3, 4 ]))
                return target
            } ],
            [ 'writeTexture', fake => {
                const target = fake.device.createTexture({ size: [ 1, 1 ], format: 'rgba8unorm' })
                fake.queue.writeTexture({ texture: target }, new Uint8Array(4), {}, [ 1, 1 ])
                return target
            } ],
            [ 'copyExternalImageToTexture', fake => {
                const target = fake.device.createTexture({ size: [ 1, 1 ], format: 'rgba8unorm' })
                fake.queue.copyExternalImageToTexture({ source: {} }, { texture: target }, [ 1, 1 ])
                return target
            } ],
            [ 'submit', fake => fake.queue.submit([ fake.device.createCommandEncoder().finish() ]) ],
        ]

        for (const [ method, issue ] of cases) {
            const fake = createFakeGpu()
            const expected = new Error(`fake synchronous ${method}`)
            fake.errors.throwNext(method, expected)

            expect(() => issue(fake)).to.throw(expected)
            expect(fake.calls.nativeTimeline).to.deep.include({
                type: 'native-method',
                method,
            })
            expect(fake.calls.queueTimeline).to.deep.equal([])
        }
    })

    it('settles nested submission scopes in arbitrary order without consuming an outer scope', async () => {

        const fake = createFakeGpu({ deferErrorScopePops: true })
        const outerError = new Error('application outer validation')
        const innerValidation = new Error('submission validation')
        const innerInternal = new Error('submission internal')

        fake.device.pushErrorScope('validation')
        fake.device.pushErrorScope('out-of-memory')
        fake.device.pushErrorScope('internal')
        fake.device.pushErrorScope('validation')
        fake.errors.failNext('finish', 'validation', innerValidation)
        fake.errors.failNext('submit', 'internal', innerInternal)

        const commandBuffer = fake.device.createCommandEncoder().finish()
        fake.queue.submit([ commandBuffer ])

        const validation = fake.device.popErrorScope()
        const internal = fake.device.popErrorScope()
        const outOfMemory = fake.device.popErrorScope()
        fake.errors.emit('validation', outerError)
        const outer = fake.device.popErrorScope()

        fake.errors.settlePop(2)
        fake.errors.settlePop(0)
        fake.errors.settlePop(3)
        fake.errors.settlePop(1)

        expect(await validation).to.equal(innerValidation)
        expect(await internal).to.equal(innerInternal)
        expect(await outOfMemory).to.equal(null)
        expect(await outer).to.equal(outerError)
        expect(fake.errors.scopeDepth).to.equal(0)
    })
})
