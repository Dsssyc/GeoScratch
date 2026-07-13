import {
    advanceResourceContentEpoch,
    replaceResourceAllocation,
} from '../packages/geoscratch/dist/scratch/resource.js'
import { advanceQuerySlotContentEpoch } from '../packages/geoscratch/dist/scratch/query-set.js'

const fakeExternalImageSourcePlatforms = new Map()

export function createFakePipelineError(reason = 'validation', message = 'fake pipeline failure') {

    if (reason !== 'validation' && reason !== 'internal') {
        throw new TypeError(`Unsupported fake pipeline error reason: ${reason}`)
    }
    const error = new Error(message)
    error.name = 'GPUPipelineError'
    Object.defineProperty(error, 'reason', {
        value: reason,
        enumerable: true,
        configurable: false,
        writable: false,
    })
    return error
}

export function replaceResourceAllocationForTest(resource, descriptor = resource.descriptor) {

    replaceResourceAllocation(resource, descriptor)
}

export function advanceResourceContentEpochForTest(resource) {

    advanceResourceContentEpoch(resource)
}

export function advanceQuerySlotContentEpochForTest(querySet, index) {

    advanceQuerySlotContentEpoch(querySet, index)
}

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

    const platform = fakeExternalImageSourcePlatform(kind, dimensionFields)
    const source = new platform.constructor({
        [dimensionFields[0]]: width,
        [dimensionFields[1]]: height,
    })
    Object.assign(source, {
        revision: 0,
        ...properties,
    })

    return source
}

function fakeExternalImageSourcePlatform(kind, dimensionFields) {

    let platform = fakeExternalImageSourcePlatforms.get(kind)
    if (platform === undefined) {
        const slots = new WeakMap()
        const constructor = function(initialDimensions) {

            slots.set(this, initialDimensions)
        }
        Object.defineProperty(constructor, 'name', { value: kind })
        Object.defineProperty(constructor.prototype, Symbol.toStringTag, { value: kind })

        for (const field of dimensionFields) {
            Object.defineProperty(constructor.prototype, field, {
                get() {

                    const dimensions = slots.get(this)
                    if (dimensions === undefined) throw new TypeError('Illegal invocation')
                    return dimensions[field]
                },
                set(value) {

                    const dimensions = slots.get(this)
                    if (dimensions === undefined) throw new TypeError('Illegal invocation')
                    dimensions[field] = value
                },
            })
        }

        platform = { constructor }
        fakeExternalImageSourcePlatforms.set(kind, platform)
    }

    if (globalThis[kind] !== platform.constructor) {
        Object.defineProperty(globalThis, kind, {
            configurable: true,
            writable: true,
            value: platform.constructor,
        })
    }

    return platform
}

export function createFakeGpu(options = {}) {

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
        mappedRanges: [],
        unmaps: [],
        bufferDestroys: [],
        errorScopes: [],
        debugGroups: [],
        nativeTimeline: [],
        compilationInfoRequests: [],
        asyncPipelineRequests: [],
        uncapturedErrors: [],
        deviceLosses: [],
    }

    const errorScopeStack = []
    const nativeFailures = []
    const pendingPops = []
    const mapRequests = []
    const nextMapOutcomes = []
    const queueCompletionRequests = []
    const nextQueueCompletionOutcomes = []
    let shouldDetachNextMappedRange = false
    const compilationRequests = []
    const pipelineRequests = []
    const nextCompilationOutcomes = []
    const nextPipelineOutcomes = []
    const eventListeners = new Map()
    let resolveDeviceLost
    let deviceLossSettled = false
    const deviceLost = new Promise(resolve => {
        resolveDeviceLost = resolve
    })

    const errors = {
        failNext(method, filter, error) {
            nativeFailures.push({ method, kind: 'error', filter, error })
        },
        throwNext(method, error) {
            nativeFailures.push({ method, kind: 'throw', error })
        },
        settlePop(index) {
            const pending = pendingPops[index]
            if (pending === undefined) throw new RangeError(`No pending error-scope pop at index ${index}.`)
            if (pending.settled) throw new Error(`Error-scope pop ${index} is already settled.`)
            pending.settled = true
            pending.resolve(pending.scope.error)
        },
        rejectPop(index, error = new Error('fake error-scope pop failure')) {
            const pending = pendingPops[index]
            if (pending === undefined) throw new RangeError(`No pending error-scope pop at index ${index}.`)
            if (pending.settled) throw new Error(`Error-scope pop ${index} is already settled.`)
            pending.settled = true
            pending.reject(error)
        },
        emit(filter, error) {
            captureOrDispatchError(filter, error)
        },
        emitUncaptured(error) {
            queueMicrotask(() => dispatchUncapturedError(error))
        },
        loseDevice(info = { reason: 'unknown', message: 'fake device loss' }) {
            if (deviceLossSettled) return
            deviceLossSettled = true
            calls.deviceLosses.push(info)
            resolveDeviceLost(info)
        },
        listenerCount(type) {
            return eventListeners.get(type)?.size ?? 0
        },
        get pendingPops() {
            return pendingPops.map(({ scope, settled }) => ({
                filter: scope.filter,
                error: scope.error,
                settled,
            }))
        },
        get scopeDepth() {
            return errorScopeStack.length
        },
    }

    const pipelines = {
        setNextCompilationInfo(info) {
            nextCompilationOutcomes.push({ kind: 'resolve', value: normalizeCompilationInfo(info) })
        },
        rejectNextCompilation(error = new Error('fake compilation info failure')) {
            nextCompilationOutcomes.push({ kind: 'reject', error })
        },
        rejectNextPipeline(kind, error = createFakePipelineError()) {
            assertPipelineKind(kind)
            nextPipelineOutcomes.push({ kind: 'reject', pipelineKind: kind, error })
        },
        settleCompilation(index) {
            const request = pendingRequest(compilationRequests, index, 'compilation info')
            request.settled = true
            if (request.outcome.kind === 'reject') request.reject(request.outcome.error)
            else request.resolve(request.outcome.value)
        },
        resolveCompilation(index, info) {
            const request = pendingRequest(compilationRequests, index, 'compilation info')
            request.settled = true
            request.resolve(info === undefined ? request.defaultInfo : normalizeCompilationInfo(info))
        },
        rejectCompilation(index, error = new Error('fake compilation info failure')) {
            const request = pendingRequest(compilationRequests, index, 'compilation info')
            request.settled = true
            request.reject(error)
        },
        settlePipeline(index) {
            const request = pendingRequest(pipelineRequests, index, 'pipeline creation')
            request.settled = true
            if (request.outcome?.kind === 'reject') request.reject(request.outcome.error)
            else {
                request.install()
                request.resolve(request.pipeline)
            }
        },
        resolvePipeline(index, value) {
            const request = pendingRequest(pipelineRequests, index, 'pipeline creation')
            request.settled = true
            const resolved = value === undefined ? request.pipeline : value
            if (resolved === request.pipeline) request.install()
            request.resolve(resolved)
        },
        rejectPipeline(index, error = createFakePipelineError()) {
            const request = pendingRequest(pipelineRequests, index, 'pipeline creation')
            request.settled = true
            request.reject(error)
        },
        get compilationRequests() {
            return compilationRequests
        },
        get pipelineRequests() {
            return pipelineRequests
        },
    }

    const readbacks = {
        rejectNextMap(error = new DOMException('fake map failure', 'OperationError')) {
            nextMapOutcomes.push({ kind: 'reject', error })
        },
        resolveMap(index, value) {
            settleMapRequest(index, { kind: 'resolve', value })
        },
        rejectMap(index, error = new DOMException('fake map failure', 'OperationError')) {
            settleMapRequest(index, { kind: 'reject', error })
        },
        rejectNextQueueCompletion(error = new Error('fake queue completion failure')) {
            nextQueueCompletionOutcomes.push({ kind: 'reject', error })
        },
        resolveQueueCompletion(index, value) {
            settleQueueCompletionRequest(index, { kind: 'resolve', value })
        },
        rejectQueueCompletion(index, error = new Error('fake queue completion failure')) {
            settleQueueCompletionRequest(index, { kind: 'reject', error })
        },
        detachNextMappedRange() {
            shouldDetachNextMappedRange = true
        },
        get mapRequests() {
            return mapRequests
        },
        get queueCompletionRequests() {
            return queueCompletionRequests
        },
    }

    function settleMapRequest(index, outcome) {

        const request = pendingRequest(mapRequests, index, 'map')
        request.settled = true
        request.buffer.mapped = outcome.kind === 'resolve'
        request.buffer.mapState = outcome.kind === 'resolve' ? 'mapped' : 'unmapped'
        if (outcome.kind === 'resolve') request.resolve(outcome.value)
        else request.reject(outcome.error)
    }

    function settleQueueCompletionRequest(index, outcome) {

        const request = pendingRequest(queueCompletionRequests, index, 'queue completion')
        request.settled = true
        if (outcome.kind === 'resolve') request.resolve(outcome.value)
        else request.reject(outcome.error)
    }

    function cancelPendingMap(buffer) {

        const request = mapRequests.find(candidate => candidate.buffer === buffer && !candidate.settled)
        if (request === undefined) return
        request.settled = true
        request.buffer.mapped = false
        request.buffer.mapState = 'unmapped'
        request.reject(new DOMException('The mapping was cancelled.', 'OperationError'))
    }

    function applyNativeFailure(method) {

        const failure = takeNativeFailure(method)
        if (failure === undefined) return false
        if (failure.kind === 'throw') throw failure.error
        captureOrDispatchError(failure.filter, failure.error)
        return true
    }

    function issueNativeMethod(method) {

        calls.nativeTimeline.push({ type: 'native-method', method })
        return applyNativeFailure(method)
    }

    function applyPromiseMethodSynchronousFailure(method) {

        const failure = takeNativeFailure(method)
        if (failure === undefined) return
        if (failure.kind === 'throw') throw failure.error
        throw new TypeError(`${method} failures must be configured as Promise rejections.`)
    }

    function takeNativeFailure(method) {

        const index = nativeFailures.findIndex(failure => failure.method === method)
        if (index < 0) return undefined
        return nativeFailures.splice(index, 1)[0]
    }

    function issueCompilationInfo(shaderModule) {

        calls.nativeTimeline.push({ type: 'get-compilation-info' })
        calls.compilationInfoRequests.push({ shaderModule })
        applyPromiseMethodSynchronousFailure('getCompilationInfo')
        const defaultInfo = normalizeCompilationInfo({
            messages: options.compilationMessages ?? [],
        })
        const nextOutcome = nextCompilationOutcomes.shift()
        const outcome = nextOutcome ?? { kind: 'resolve', value: defaultInfo }

        if (!options.deferCompilationInfo) {
            if (outcome.kind === 'reject') return Promise.reject(outcome.error)
            return Promise.resolve(outcome.value)
        }

        return new Promise((resolve, reject) => {
            compilationRequests.push({
                shaderModule,
                defaultInfo: outcome.kind === 'resolve' ? outcome.value : defaultInfo,
                outcome,
                resolve,
                reject,
                settled: false,
            })
        })
    }

    function issueAsyncPipeline(kind, descriptor) {

        assertPipelineKind(kind)
        const method = kind === 'render'
            ? 'createRenderPipelineAsync'
            : 'createComputePipelineAsync'
        calls.nativeTimeline.push({ type: `create-${kind}-pipeline-async` })
        applyPromiseMethodSynchronousFailure(method)
        const pipeline = {
            type: `${kind}Pipeline`,
            descriptor,
            getBindGroupLayout(index) {
                return descriptor.layout?.descriptor?.bindGroupLayouts?.[index]
            },
        }
        const targetCalls = kind === 'render' ? calls.renderPipelines : calls.computePipelines
        let installed = false
        const install = () => {
            if (installed) return
            installed = true
            targetCalls.push(pipeline)
        }
        calls.asyncPipelineRequests.push({ kind, descriptor, pipeline })

        const outcomeIndex = nextPipelineOutcomes.findIndex(outcome => outcome.pipelineKind === kind)
        const nextOutcome = outcomeIndex < 0
            ? undefined
            : nextPipelineOutcomes.splice(outcomeIndex, 1)[0]
        if (!options.deferAsyncPipelines) {
            if (nextOutcome?.kind === 'reject') return Promise.reject(nextOutcome.error)
            install()
            return Promise.resolve(pipeline)
        }

        return new Promise((resolve, reject) => {
            pipelineRequests.push({
                kind,
                descriptor,
                pipeline,
                resolve,
                reject,
                settled: false,
                outcome: nextOutcome,
                install,
            })
        })
    }

    function captureOrDispatchError(filter, error) {

        for (let index = errorScopeStack.length - 1; index >= 0; index--) {
            const scope = errorScopeStack[index]
            if (scope.filter !== filter) continue
            if (scope.error === null) scope.error = error
            return
        }

        queueMicrotask(() => dispatchUncapturedError(error))
    }

    function dispatchUncapturedError(error) {

        const event = { type: 'uncapturederror', error }
        calls.uncapturedErrors.push(event)
        for (const listener of [ ...(eventListeners.get('uncapturederror') ?? []) ]) {
            if (typeof listener === 'function') listener.call(device, event)
            else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event)
        }
    }

    const queue = {
        submittedWorkDoneCalls: 0,
        writeBuffer(buffer, offset, data, dataOffset, size) {
            if (issueNativeMethod('writeBuffer')) return
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
            if (issueNativeMethod('writeTexture')) return
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
            if (issueNativeMethod('copyExternalImageToTexture')) return
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
            if (issueNativeMethod('submit')) return
            calls.queueTimeline.push({
                type: 'submit',
                commandBuffers,
            })
            calls.queueSubmissions.push(commandBuffers)
            for (const commandBuffer of commandBuffers) {
                if (commandBuffer.invalid === true) {
                    captureOrDispatchError(
                        'validation',
                        new Error('Fake queue received an invalid command buffer.')
                    )
                    continue
                }
                executeFakeCommandBuffer(commandBuffer)
            }
        },
        onSubmittedWorkDone() {
            this.submittedWorkDoneCalls++
            calls.submittedWorkDoneRegistrations.push({
                queueTimelineLength: calls.queueTimeline.length,
            })
            const outcome = nextQueueCompletionOutcomes.shift() ?? { kind: 'resolve', value: 'queue done' }
            if (!options.deferSubmittedWorkDone) {
                return outcome.kind === 'resolve'
                    ? Promise.resolve(outcome.value)
                    : Promise.reject(outcome.error)
            }

            return new Promise((resolve, reject) => {
                queueCompletionRequests.push({
                    resolve,
                    reject,
                    settled: false,
                    outcome,
                })
            })
        },
    }

    const device = {
        features: new Set([ 'timestamp-query' ]),
        limits: {
            maxColorAttachments: 8,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxTextureDimension2D: 8192,
            maxTextureArrayLayers: 256,
            minUniformBufferOffsetAlignment: 256,
            minStorageBufferOffsetAlignment: 256,
        },
        queue,
        lost: deviceLost,
        pushErrorScope(filter) {
            errorScopeStack.push({ filter, error: null })
            calls.errorScopes.push({ action: 'push', filter })
            calls.nativeTimeline.push({ type: 'push-error-scope', filter })
        },
        popErrorScope() {
            const scope = errorScopeStack.pop()
            if (scope === undefined) {
                calls.errorScopes.push({ action: 'pop', filter: 'none' })
                return Promise.reject(new Error('No error scope is currently pushed.'))
            }

            calls.errorScopes.push({ action: 'pop', filter: scope.filter })
            calls.nativeTimeline.push({ type: 'pop-error-scope', filter: scope.filter })
            if (!options.deferErrorScopePops) return Promise.resolve(scope.error)

            return new Promise((resolve, reject) => {
                pendingPops.push({ scope, resolve, reject, settled: false })
            })
        },
        addEventListener(type, listener) {
            if (!eventListeners.has(type)) eventListeners.set(type, new Set())
            eventListeners.get(type).add(listener)
        },
        removeEventListener(type, listener) {
            eventListeners.get(type)?.delete(listener)
        },
        createBuffer(descriptor) {
            applyNativeFailure('createBuffer')
            const data = new Uint8Array(descriptor.size ?? 0)
            const buffer = {
                id: `fake-buffer-${calls.buffers.length + 1}`,
                type: 'buffer',
                descriptor,
                data,
                destroyed: false,
                mapped: false,
                mapState: 'unmapped',
                mapAsync(mode, offset = 0, size = data.byteLength - offset) {
                    applyNativeFailure('mapAsync')
                    this.mapState = 'pending'
                    calls.maps.push({ buffer: this, mode, offset, size })
                    calls.nativeTimeline.push({
                        type: 'map-async',
                        bufferId: this.id,
                        offset,
                        size,
                    })
                    const outcome = nextMapOutcomes.shift() ?? { kind: 'resolve', value: undefined }
                    if (!options.deferMaps) {
                        this.mapped = outcome.kind === 'resolve'
                        this.mapState = outcome.kind === 'resolve' ? 'mapped' : 'unmapped'
                        return outcome.kind === 'resolve'
                            ? Promise.resolve(outcome.value)
                            : Promise.reject(outcome.error)
                    }

                    return new Promise((resolve, reject) => {
                        mapRequests.push({
                            buffer: this,
                            mode,
                            offset,
                            size,
                            outcome,
                            resolve,
                            reject,
                            settled: false,
                        })
                    })
                },
                getMappedRange(offset = 0, size = data.byteLength - offset) {
                    applyNativeFailure('getMappedRange')
                    calls.mappedRanges.push({ buffer: this, offset, size })
                    const range = data.buffer.slice(offset, offset + size)
                    if (shouldDetachNextMappedRange) {
                        shouldDetachNextMappedRange = false
                        structuredClone(range, { transfer: [ range ] })
                    }
                    return range
                },
                unmap() {
                    applyNativeFailure('unmap')
                    calls.unmaps.push({ buffer: this })
                    cancelPendingMap(this)
                    this.mapped = false
                    this.mapState = 'unmapped'
                },
                destroy() {
                    applyNativeFailure('destroyBuffer')
                    calls.bufferDestroys.push({ buffer: this })
                    cancelPendingMap(this)
                    this.destroyed = true
                    this.mapped = false
                    this.mapState = 'unmapped'
                },
            }
            calls.buffers.push(buffer)
            return buffer
        },
        createShaderModule(descriptor) {
            calls.nativeTimeline.push({ type: 'create-shader-module' })
            applyNativeFailure('createShaderModule')
            const shaderModule = {
                type: 'shaderModule',
                descriptor,
                getCompilationInfo() {
                    return issueCompilationInfo(this)
                },
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
            const invalid = issueNativeMethod('createBindGroup')
            const bindGroup = {
                type: 'bindGroup',
                descriptor,
                invalid,
            }
            calls.bindGroups.push(bindGroup)
            return bindGroup
        },
        createTexture(descriptor) {
            applyNativeFailure('createTexture')
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
            calls.nativeTimeline.push({ type: 'create-pipeline-layout' })
            applyNativeFailure('createPipelineLayout')
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
                getBindGroupLayout(index) {
                    return descriptor.layout?.descriptor?.bindGroupLayouts?.[index]
                },
            }
            calls.renderPipelines.push(pipeline)
            return pipeline
        },
        createComputePipeline(descriptor) {
            const pipeline = {
                type: 'computePipeline',
                descriptor,
                getBindGroupLayout(index) {
                    return descriptor.layout?.descriptor?.bindGroupLayouts?.[index]
                },
            }
            calls.computePipelines.push(pipeline)
            return pipeline
        },
        createRenderPipelineAsync(descriptor) {
            return issueAsyncPipeline('render', descriptor)
        },
        createComputePipelineAsync(descriptor) {
            return issueAsyncPipeline('compute', descriptor)
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
            const invalid = issueNativeMethod('createCommandEncoder')
            const encoder = createFakeCommandEncoder(
                calls,
                descriptor,
                issueNativeMethod,
                invalid
            )
            calls.commandEncoders.push(encoder)
            return encoder
        },
        destroy() {
            errors.loseDevice({ reason: 'destroyed', message: 'Fake GPUDevice was destroyed.' })
        },
    }

    const adapter = {
        features: new Set([ 'timestamp-query' ]),
        limits: {
            maxColorAttachments: 8,
            maxComputeWorkgroupsPerDimension: 65_535,
            maxTextureDimension2D: 8192,
            maxTextureArrayLayers: 256,
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

    return { gpu, adapter, device, queue, calls, errors, pipelines, readbacks }
}

function normalizeCompilationInfo(info) {

    if (!info || !Array.isArray(info.messages)) {
        throw new TypeError('Fake compilation info requires a messages array.')
    }
    return {
        messages: info.messages.map(message => ({ ...message })),
    }
}

function assertPipelineKind(kind) {

    if (kind !== 'render' && kind !== 'compute') {
        throw new TypeError(`Unsupported fake pipeline kind: ${kind}`)
    }
}

function pendingRequest(requests, index, name) {

    const request = requests[index]
    if (request === undefined) throw new RangeError(`No pending ${name} at index ${index}.`)
    if (request.settled) throw new Error(`${name} ${index} is already settled.`)
    return request
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

function createFakeCommandEncoder(calls, descriptor, issueNativeMethod, initiallyInvalid = false) {

    const commands = []
    const encoder = {
        descriptor,
        invalid: initiallyInvalid,
        pushDebugGroup(label) {
            calls.debugGroups.push({ action: 'push', encoder: 'command', label })
            calls.nativeTimeline.push({ type: 'push-debug-group', encoder: 'command', label })
        },
        popDebugGroup() {
            calls.debugGroups.push({ action: 'pop', encoder: 'command' })
            calls.nativeTimeline.push({ type: 'pop-debug-group', encoder: 'command' })
        },
        beginRenderPass(renderPassDescriptor) {
            const failed = issueEncoderMethod(this, issueNativeMethod, 'beginRenderPass')
            const passEncoder = createFakeRenderPassEncoder(
                calls,
                renderPassDescriptor,
                issueNativeMethod,
                () => { this.invalid = true },
                failed || this.invalid
            )
            calls.renderPasses.push(passEncoder)
            return passEncoder
        },
        beginComputePass(computePassDescriptor) {
            const failed = issueEncoderMethod(this, issueNativeMethod, 'beginComputePass')
            const passEncoder = createFakeComputePassEncoder(
                calls,
                computePassDescriptor,
                issueNativeMethod,
                () => { this.invalid = true },
                failed || this.invalid
            )
            calls.computePasses.push(passEncoder)
            return passEncoder
        },
        copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
            if (issueEncoderMethod(this, issueNativeMethod, 'copyBufferToBuffer')) return
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
            if (issueEncoderMethod(this, issueNativeMethod, 'copyTextureToTexture')) return
            calls.textureCopies.push({
                source,
                destination,
                size,
            })
        },
        copyBufferToTexture(source, destination, size) {
            if (issueEncoderMethod(this, issueNativeMethod, 'copyBufferToTexture')) return
            calls.bufferTextureCopies.push({
                source,
                destination,
                size,
            })
        },
        copyTextureToBuffer(source, destination, size) {
            if (issueEncoderMethod(this, issueNativeMethod, 'copyTextureToBuffer')) return
            calls.textureBufferCopies.push({
                source,
                destination,
                size,
            })
        },
        resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
            if (issueEncoderMethod(this, issueNativeMethod, 'resolveQuerySet')) return
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
            const failed = issueEncoderMethod(this, issueNativeMethod, 'finish')
            const invalid = failed || this.invalid
            const commandBuffer = {
                type: 'commandBuffer',
                descriptor,
                ...(invalid ? { invalid: true } : {}),
            }
            Object.defineProperty(commandBuffer, 'commands', {
                value: [ ...commands ],
                enumerable: false,
            })
            return commandBuffer
        },
    }

    return encoder
}

function issueEncoderMethod(encoder, issueNativeMethod, method) {

    const failed = issueNativeMethod(method)
    if (failed) encoder.invalid = true
    return failed
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

function createFakeRenderPassEncoder(
    calls,
    descriptor,
    issueNativeMethod,
    invalidateParent,
    initiallyInvalid = false
) {

    const pass = {
        descriptor,
        actions: [],
        invalid: initiallyInvalid,
        pushDebugGroup(label) {
            calls.debugGroups.push({ action: 'push', encoder: 'render-pass', label })
            calls.nativeTimeline.push({ type: 'push-debug-group', encoder: 'render-pass', label })
        },
        popDebugGroup() {
            calls.debugGroups.push({ action: 'pop', encoder: 'render-pass' })
            calls.nativeTimeline.push({ type: 'pop-debug-group', encoder: 'render-pass' })
        },
        setPipeline(pipeline) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'renderSetPipeline')) return
            this.actions.push({ type: 'setPipeline', pipeline })
        },
        setBindGroup(group, bindGroup, dynamicOffsets) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'renderSetBindGroup')) return
            const action = { type: 'setBindGroup', group, bindGroup }
            if (dynamicOffsets !== undefined) action.dynamicOffsets = [ ...dynamicOffsets ]
            this.actions.push(action)
        },
        setVertexBuffer(slot, buffer, offset, size) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'setVertexBuffer')) return
            this.actions.push({ type: 'setVertexBuffer', slot, buffer, offset, size })
        },
        setIndexBuffer(buffer, indexFormat, offset, size) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'setIndexBuffer')) return
            this.actions.push({ type: 'setIndexBuffer', buffer, indexFormat, offset, size })
        },
        draw(vertexCount, instanceCount, firstVertex, firstInstance) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'draw')) return
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
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'drawIndexed')) return
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
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'drawIndirect')) return
            const action = { type: 'drawIndirect', buffer, offset }
            this.actions.push(action)
            calls.drawCalls.push(action)
        },
        drawIndexedIndirect(buffer, offset) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'drawIndexedIndirect')) return
            const action = { type: 'drawIndexedIndirect', buffer, offset }
            this.actions.push(action)
            calls.drawCalls.push(action)
        },
        beginOcclusionQuery(queryIndex) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'beginOcclusionQuery')) return
            const call = { type: 'begin', queryIndex }
            this.actions.push({ type: 'beginOcclusionQuery', queryIndex })
            calls.occlusionQueries.push(call)
        },
        endOcclusionQuery() {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'endOcclusionQuery')) return
            const call = { type: 'end' }
            this.actions.push({ type: 'endOcclusionQuery' })
            calls.occlusionQueries.push(call)
        },
        end() {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'renderPassEnd')) return
            this.actions.push({ type: 'end' })
        },
    }

    return pass
}

function createFakeComputePassEncoder(
    calls,
    descriptor,
    issueNativeMethod,
    invalidateParent,
    initiallyInvalid = false
) {

    const pass = {
        descriptor,
        actions: [],
        invalid: initiallyInvalid,
        pushDebugGroup(label) {
            calls.debugGroups.push({ action: 'push', encoder: 'compute-pass', label })
            calls.nativeTimeline.push({ type: 'push-debug-group', encoder: 'compute-pass', label })
        },
        popDebugGroup() {
            calls.debugGroups.push({ action: 'pop', encoder: 'compute-pass' })
            calls.nativeTimeline.push({ type: 'pop-debug-group', encoder: 'compute-pass' })
        },
        setPipeline(pipeline) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'computeSetPipeline')) return
            this.actions.push({ type: 'setPipeline', pipeline })
        },
        setBindGroup(group, bindGroup, dynamicOffsets) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'computeSetBindGroup')) return
            const action = { type: 'setBindGroup', group, bindGroup }
            if (dynamicOffsets !== undefined) action.dynamicOffsets = [ ...dynamicOffsets ]
            this.actions.push(action)
        },
        dispatchWorkgroups(x, y, z) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'dispatchWorkgroups')) return
            const call = { x, y, z }
            this.actions.push({ type: 'dispatchWorkgroups', call })
            calls.dispatchCalls.push(call)
        },
        dispatchWorkgroupsIndirect(buffer, offset) {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'dispatchWorkgroupsIndirect')) return
            const action = { type: 'dispatchWorkgroupsIndirect', buffer, offset }
            this.actions.push(action)
            calls.dispatchCalls.push(action)
        },
        end() {
            if (issuePassMethod(this, issueNativeMethod, invalidateParent, 'computePassEnd')) return
            this.actions.push({ type: 'end' })
        },
    }

    return pass
}

function issuePassMethod(pass, issueNativeMethod, invalidateParent, method) {

    const failed = issueNativeMethod(method)
    if (failed) {
        pass.invalid = true
        invalidateParent()
    }
    return failed
}

function bytesFrom(data, dataOffset = 0, size) {

    if (data instanceof ArrayBuffer) {
        const byteLength = size ?? data.byteLength - dataOffset
        return new Uint8Array(data, dataOffset, byteLength)
    }

    const byteLength = size ?? data.byteLength - dataOffset
    return new Uint8Array(data.buffer, data.byteOffset + dataOffset, byteLength)
}
