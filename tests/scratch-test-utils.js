export function createFakeGpu() {

    const calls = {
        buffers: [],
        shaderModules: [],
        bindGroupLayouts: [],
        bindGroups: [],
        pipelineLayouts: [],
        renderPipelines: [],
        commandEncoders: [],
        queueWrites: [],
        queueSubmissions: [],
        renderPasses: [],
        drawCalls: [],
    }

    const queue = {
        submittedWorkDoneCalls: 0,
        writeBuffer(buffer, offset, data, dataOffset, size) {
            calls.queueWrites.push({
                buffer,
                offset,
                data,
                dataOffset,
                size,
            })
        },
        submit(commandBuffers) {
            calls.queueSubmissions.push(commandBuffers)
        },
        onSubmittedWorkDone() {
            this.submittedWorkDoneCalls++
            return Promise.resolve('queue done')
        },
    }

    const device = {
        features: new Set([ 'timestamp-query' ]),
        limits: { maxColorAttachments: 8 },
        queue,
        lost: new Promise(() => {}),
        createBuffer(descriptor) {
            const buffer = {
                type: 'buffer',
                descriptor,
                destroyed: false,
                destroy() {
                    this.destroyed = true
                },
            }
            calls.buffers.push(buffer)
            return buffer
        },
        createShaderModule(descriptor) {
            const shaderModule = {
                type: 'shaderModule',
                descriptor,
            }
            calls.shaderModules.push(shaderModule)
            return shaderModule
        },
        createBindGroupLayout(descriptor) {
            const layout = {
                type: 'bindGroupLayout',
                descriptor,
            }
            calls.bindGroupLayouts.push(layout)
            return layout
        },
        createBindGroup(descriptor) {
            const bindGroup = {
                type: 'bindGroup',
                descriptor,
            }
            calls.bindGroups.push(bindGroup)
            return bindGroup
        },
        createPipelineLayout(descriptor) {
            const layout = {
                type: 'pipelineLayout',
                descriptor,
            }
            calls.pipelineLayouts.push(layout)
            return layout
        },
        createRenderPipeline(descriptor) {
            const pipeline = {
                type: 'renderPipeline',
                descriptor,
            }
            calls.renderPipelines.push(pipeline)
            return pipeline
        },
        createCommandEncoder(descriptor) {
            const encoder = createFakeCommandEncoder(calls, descriptor)
            calls.commandEncoders.push(encoder)
            return encoder
        },
        destroy() {},
    }

    const adapter = {
        features: new Set([ 'timestamp-query' ]),
        limits: { maxColorAttachments: 8 },
        async requestDevice() {
            return device
        },
    }

    const gpu = {
        async requestAdapter() {
            return adapter
        },
        getPreferredCanvasFormat() {
            return 'bgra8unorm'
        },
    }

    return { gpu, adapter, device, queue, calls }
}

export function createFakeCanvas() {

    const textureViews = []
    const context = {
        configureCalls: [],
        unconfigureCalls: 0,
        currentTextureCalls: 0,
        configure(descriptor) {
            this.configureCalls.push(descriptor)
        },
        unconfigure() {
            this.unconfigureCalls++
        },
        getCurrentTexture() {
            this.currentTextureCalls++
            return {
                createView(descriptor) {
                    const view = {
                        type: 'textureView',
                        descriptor,
                    }
                    textureViews.push(view)
                    return view
                },
            }
        },
    }

    const canvas = {
        width: 1,
        height: 1,
        getContext(kind) {
            if (kind !== 'webgpu') return null
            return context
        },
    }

    return { canvas, context, textureViews }
}

export const triangleWgsl = `
@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(0.0, 0.5),
        vec2f(-0.5, -0.5),
        vec2f(0.5, -0.5)
    );
    let p = positions[vertexIndex];
    return vec4f(p, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(1.0, 0.35, 0.05, 1.0);
}
`

function createFakeCommandEncoder(calls, descriptor) {

    return {
        descriptor,
        beginRenderPass(renderPassDescriptor) {
            const passEncoder = createFakeRenderPassEncoder(calls, renderPassDescriptor)
            calls.renderPasses.push(passEncoder)
            return passEncoder
        },
        finish() {
            return {
                type: 'commandBuffer',
                descriptor,
            }
        },
    }
}

function createFakeRenderPassEncoder(calls, descriptor) {

    return {
        descriptor,
        actions: [],
        setPipeline(pipeline) {
            this.actions.push({ type: 'setPipeline', pipeline })
        },
        setBindGroup(group, bindGroup) {
            this.actions.push({ type: 'setBindGroup', group, bindGroup })
        },
        draw(vertexCount, instanceCount, firstVertex, firstInstance) {
            const call = {
                vertexCount,
                instanceCount,
                firstVertex,
                firstInstance,
            }
            this.actions.push({ type: 'draw', call })
            calls.drawCalls.push(call)
        },
        end() {
            this.actions.push({ type: 'end' })
        },
    }
}
