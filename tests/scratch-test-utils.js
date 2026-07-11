export function createFakeExternalImageSource(
    kind = 'ImageData',
    { width = 4, height = 4, ...properties } = {}
) {

    const dimensionFields = {
        ImageBitmap: [ 'width', 'height' ],
        ImageData: [ 'width', 'height' ],
        HTMLImageElement: [ 'naturalWidth', 'naturalHeight' ],
        HTMLVideoElement: [ 'videoWidth', 'videoHeight' ],
        VideoFrame: [ 'displayWidth', 'displayHeight' ],
        HTMLCanvasElement: [ 'width', 'height' ],
        OffscreenCanvas: [ 'width', 'height' ],
    }[kind]
    if (dimensionFields === undefined) throw new TypeError(`Unsupported fake external image source kind: ${kind}`)

    const source = {
        [Symbol.toStringTag]: kind,
        revision: 0,
        ...properties,
    }
    source[dimensionFields[0]] = width
    source[dimensionFields[1]] = height

    return source
}

export function createFakeGpu() {

    const calls = {
        buffers: [],
        shaderModules: [],
        bindGroupLayouts: [],
        bindGroups: [],
        textures: [],
        textureViews: [],
        samplers: [],
        pipelineLayouts: [],
        renderPipelines: [],
        computePipelines: [],
        querySets: [],
        commandEncoders: [],
        queueWrites: [],
        queueTextureWrites: [],
        queueExternalImageCopies: [],
        queueSubmissions: [],
        queueTimeline: [],
        submittedWorkDoneRegistrations: [],
        renderPasses: [],
        computePasses: [],
        drawCalls: [],
        dispatchCalls: [],
        occlusionQueries: [],
        copies: [],
        textureCopies: [],
        bufferTextureCopies: [],
        textureBufferCopies: [],
        resolveQueries: [],
        maps: [],
    }

    const queue = {
        submittedWorkDoneCalls: 0,
        writeBuffer(buffer, offset, data, dataOffset, size) {
            calls.queueTimeline.push({
                type: 'write-buffer',
                buffer,
                offset,
            })
            calls.queueWrites.push({
                buffer,
                offset,
                data,
                dataOffset,
                size,
            })
            const source = bytesFrom(data, dataOffset ?? 0, size)
            buffer.data.set(source, offset)
        },
        writeTexture(destination, data, layout, size) {
            calls.queueTimeline.push({
                type: 'write-texture',
                destination,
            })
            calls.queueTextureWrites.push({
                destination,
                data,
                layout,
                size,
            })
            destination.texture.writes.push({
                destination,
                data: bytesFrom(data),
                layout,
                size,
            })
        },
        copyExternalImageToTexture(source, destination, copySize) {
            calls.queueTimeline.push({
                type: 'external-image-upload',
                source,
                destination,
            })
            calls.queueExternalImageCopies.push({
                source,
                destination,
                copySize,
            })
        },
        submit(commandBuffers) {
            calls.queueTimeline.push({
                type: 'submit',
                commandBuffers,
            })
            calls.queueSubmissions.push(commandBuffers)
            for (const commandBuffer of commandBuffers) {
                executeFakeCommandBuffer(commandBuffer)
            }
        },
        onSubmittedWorkDone() {
            this.submittedWorkDoneCalls++
            calls.submittedWorkDoneRegistrations.push({
                queueTimelineLength: calls.queueTimeline.length,
            })
            return Promise.resolve('queue done')
        },
    }

    const device = {
        features: new Set([ 'timestamp-query' ]),
        limits: {
            maxColorAttachments: 8,
            maxComputeWorkgroupsPerDimension: 65_535,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
        },
        queue,
        lost: new Promise(() => {}),
        createBuffer(descriptor) {
            const data = new Uint8Array(descriptor.size ?? 0)
            const buffer = {
                type: 'buffer',
                descriptor,
                data,
                destroyed: false,
                mapped: false,
                async mapAsync(mode, offset = 0, size = data.byteLength - offset) {
                    this.mapped = true
                    calls.maps.push({ buffer: this, mode, offset, size })
                },
                getMappedRange(offset = 0, size = data.byteLength - offset) {
                    return data.buffer.slice(offset, offset + size)
                },
                unmap() {
                    this.mapped = false
                },
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
        createTexture(descriptor) {
            const texture = {
                type: 'texture',
                descriptor,
                views: [],
                writes: [],
                destroyed: false,
                createView(viewDescriptor = {}) {
                    const view = {
                        type: 'textureView',
                        texture: this,
                        descriptor: viewDescriptor,
                    }
                    this.views.push(view)
                    calls.textureViews.push(view)
                    return view
                },
                destroy() {
                    this.destroyed = true
                },
            }
            calls.textures.push(texture)
            return texture
        },
        createSampler(descriptor) {
            const sampler = {
                type: 'sampler',
                descriptor,
            }
            calls.samplers.push(sampler)
            return sampler
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
        createComputePipeline(descriptor) {
            const pipeline = {
                type: 'computePipeline',
                descriptor,
            }
            calls.computePipelines.push(pipeline)
            return pipeline
        },
        createQuerySet(descriptor) {
            const querySet = {
                type: 'querySet',
                descriptor,
                values: new BigUint64Array(descriptor.count ?? 0),
                destroyed: false,
                destroy() {
                    this.destroyed = true
                },
            }
            calls.querySets.push(querySet)
            return querySet
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
        limits: {
            maxColorAttachments: 8,
            maxComputeWorkgroupsPerDimension: 65_535,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
        },
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

    const commands = []

    return {
        descriptor,
        beginRenderPass(renderPassDescriptor) {
            const passEncoder = createFakeRenderPassEncoder(calls, renderPassDescriptor)
            calls.renderPasses.push(passEncoder)
            return passEncoder
        },
        beginComputePass(computePassDescriptor) {
            const passEncoder = createFakeComputePassEncoder(calls, computePassDescriptor)
            calls.computePasses.push(passEncoder)
            return passEncoder
        },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
            const call = {
                source,
                sourceOffset,
                destination,
                destinationOffset,
                size,
            }
            calls.copies.push(call)
            commands.push({ type: 'copy-buffer-to-buffer', ...call })
        },
        copyTextureToTexture(source, destination, size) {
            calls.textureCopies.push({
                source,
                destination,
                size,
            })
        },
        copyBufferToTexture(source, destination, size) {
            calls.bufferTextureCopies.push({
                source,
                destination,
                size,
            })
        },
        copyTextureToBuffer(source, destination, size) {
            calls.textureBufferCopies.push({
                source,
                destination,
                size,
            })
        },
        resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
            const call = {
                querySet,
                firstQuery,
                queryCount,
                destination,
                destinationOffset,
            }
            calls.resolveQueries.push(call)
            commands.push({ type: 'resolve-query-set', ...call })
        },
        finish() {
            const commandBuffer = {
                type: 'commandBuffer',
                descriptor,
            }
            Object.defineProperty(commandBuffer, 'commands', {
                value: [ ...commands ],
                enumerable: false,
            })
            return commandBuffer
        },
    }
}

function executeFakeCommandBuffer(commandBuffer) {

    for (const command of commandBuffer.commands ?? []) {
        if (command.type === 'copy-buffer-to-buffer') {
            const sourceBytes = command.source.data.slice(
                command.sourceOffset,
                command.sourceOffset + command.size
            )
            command.destination.data.set(sourceBytes, command.destinationOffset)
            continue
        }

        if (command.type === 'resolve-query-set') {
            const view = new DataView(command.destination.data.buffer)
            for (let index = 0; index < command.queryCount; index++) {
                view.setBigUint64(
                    command.destinationOffset + index * 8,
                    command.querySet.values[command.firstQuery + index],
                    true
                )
            }
        }
    }
}

function createFakeRenderPassEncoder(calls, descriptor) {

    return {
        descriptor,
        actions: [],
        setPipeline(pipeline) {
            this.actions.push({ type: 'setPipeline', pipeline })
        },
        setBindGroup(group, bindGroup, dynamicOffsets) {
            const action = { type: 'setBindGroup', group, bindGroup }
            if (dynamicOffsets !== undefined) action.dynamicOffsets = [ ...dynamicOffsets ]
            this.actions.push(action)
        },
        setVertexBuffer(slot, buffer, offset, size) {
            this.actions.push({ type: 'setVertexBuffer', slot, buffer, offset, size })
        },
        setIndexBuffer(buffer, indexFormat, offset, size) {
            this.actions.push({ type: 'setIndexBuffer', buffer, indexFormat, offset, size })
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
        drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
            const call = {
                indexCount,
                instanceCount,
                firstIndex,
                baseVertex,
                firstInstance,
            }
            this.actions.push({ type: 'drawIndexed', call })
            calls.drawCalls.push(call)
        },
        drawIndirect(buffer, offset) {
            const action = { type: 'drawIndirect', buffer, offset }
            this.actions.push(action)
            calls.drawCalls.push(action)
        },
        drawIndexedIndirect(buffer, offset) {
            const action = { type: 'drawIndexedIndirect', buffer, offset }
            this.actions.push(action)
            calls.drawCalls.push(action)
        },
        beginOcclusionQuery(queryIndex) {
            const call = { type: 'begin', queryIndex }
            this.actions.push({ type: 'beginOcclusionQuery', queryIndex })
            calls.occlusionQueries.push(call)
        },
        endOcclusionQuery() {
            const call = { type: 'end' }
            this.actions.push({ type: 'endOcclusionQuery' })
            calls.occlusionQueries.push(call)
        },
        end() {
            this.actions.push({ type: 'end' })
        },
    }
}

function createFakeComputePassEncoder(calls, descriptor) {

    return {
        descriptor,
        actions: [],
        setPipeline(pipeline) {
            this.actions.push({ type: 'setPipeline', pipeline })
        },
        setBindGroup(group, bindGroup, dynamicOffsets) {
            const action = { type: 'setBindGroup', group, bindGroup }
            if (dynamicOffsets !== undefined) action.dynamicOffsets = [ ...dynamicOffsets ]
            this.actions.push(action)
        },
        dispatchWorkgroups(x, y, z) {
            const call = { x, y, z }
            this.actions.push({ type: 'dispatchWorkgroups', call })
            calls.dispatchCalls.push(call)
        },
        dispatchWorkgroupsIndirect(buffer, offset) {
            const action = { type: 'dispatchWorkgroupsIndirect', buffer, offset }
            this.actions.push(action)
            calls.dispatchCalls.push(action)
        },
        end() {
            this.actions.push({ type: 'end' })
        },
    }
}

function bytesFrom(data, dataOffset = 0, size) {

    if (data instanceof ArrayBuffer) {
        const byteLength = size ?? data.byteLength - dataOffset
        return new Uint8Array(data, dataOffset, byteLength)
    }

    const byteLength = size ?? data.byteLength - dataOffset
    return new Uint8Array(data.buffer, data.byteOffset + dataOffset, byteLength)
}
