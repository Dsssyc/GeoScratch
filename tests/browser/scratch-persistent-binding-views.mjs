import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.SCRATCH_BINDING_BROWSER_BASE_URL ?? 'http://127.0.0.1:4173'
const outputDirectory = resolve(
    process.env.SCRATCH_BINDING_BROWSER_OUTPUT ?? '/tmp/geoscratch-persistent-binding-browser'
)
const headless = process.env.SCRATCH_BINDING_BROWSER_HEADLESS === '1'
const timeout = Number(process.env.SCRATCH_BINDING_BROWSER_TIMEOUT_MS ?? 45_000)

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [ '--enable-unsafe-webgpu' ],
})

try {
    const adapter = await inspectAdapter(browser)
    let probe
    let probeError
    try {
        probe = await verifyPersistentBindings(browser)
    } catch (error) {
        probeError = error instanceof Error ? error.stack ?? error.message : String(error)
    }
    const failures = validateResult(adapter, probe, probeError)
    const result = {
        schemaVersion: 1,
        browserVersion: await browser.version(),
        headless,
        baseUrl,
        outputDirectory,
        adapter,
        probe,
        probeError,
        status: failures.length === 0 ? 'passed' : 'failed',
        failures,
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (failures.length > 0) process.exitCode = 1
} finally {
    await browser.close()
}

async function inspectAdapter(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${baseUrl}/helloTriangle/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    const facts = await page.evaluate(async () => {
        if (!navigator.gpu) return { available: false, adapterAvailable: false }
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!adapter) return { available: true, adapterAvailable: false }
        const info = adapter.info ?? {}
        return {
            available: true,
            adapterAvailable: true,
            info: {
                vendor: info.vendor ?? '',
                architecture: info.architecture ?? '',
                device: info.device ?? '',
                description: info.description ?? '',
            },
            features: [ ...adapter.features ].sort(),
            limits: {
                maxBufferSize: adapter.limits.maxBufferSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                minStorageBufferOffsetAlignment: adapter.limits.minStorageBufferOffsetAlignment,
            },
        }
    })
    await context.close()
    return facts
}

async function verifyPersistentBindings(browser) {

    const context = await browser.newContext()
    const page = await context.newPage()
    const consoleFailures = []
    const pageErrors = []
    const requestFailures = []
    attachFailureListeners(page, consoleFailures, pageErrors, requestFailures)
    await page.goto(`${baseUrl}/helloTriangle/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })

    const moduleUrl = `${baseUrl}/@fs${resolve('packages/geoscratch/dist/index.js')}`
    const probe = await page.evaluate(async ({ moduleUrl }) => {
        const {
            ScratchDiagnosticError,
            ScratchRuntime,
            layoutCodec,
        } = await import(moduleUrl)
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!adapter) throw new Error('WebGPU adapter unavailable inside binding probe')
        const optionalFeatures = [
            'timestamp-query',
            'core-features-and-limits',
            'texture-formats-tier1',
            'texture-formats-tier2',
        ].filter(feature => adapter.features.has(feature))
        const runtime = await ScratchRuntime.create({
            label: 'browser persistent binding views probe',
            requiredFeatures: optionalFeatures,
            diagnostics: {
                submissionScopes: 'summary',
                operationCapacity: 256,
                incidentCapacity: 32,
                evidenceByteCapacity: 512 * 1024,
            },
        })
        const uncaptured = []
        const onUncaptured = event => uncaptured.push(serializeGpuError(event.error))
        runtime.device.addEventListener('uncapturederror', onUncaptured)

        try {
            const main = await dynamicRegionAndReplacementProbe(runtime, layoutCodec)
            const readOnlyStorage = await readOnlyStorageTextureProbe(runtime)
            const readWriteStorage = await readWriteStorageTextureProbe(runtime)
            const occlusion = await occlusionQueryProbe(runtime)
            const timestamp = runtime.deviceFeatures.has('timestamp-query')
                ? await timestampQueryProbe(runtime)
                : {
                    status: 'skipped',
                    reason: 'runtime.deviceFeatures lacks timestamp-query',
                }
            const nativeFailure = await controlledNativeFailureProbe(
                runtime,
                ScratchDiagnosticError
            )
            await new Promise(resolve => setTimeout(resolve, 100))
            const evidence = runtime.diagnostics.exportEvidence()
            const snapshot = runtime.diagnostics.snapshot()

            return {
                requestedFeatures: optionalFeatures,
                deviceFeatures: [ ...runtime.deviceFeatures ].sort(),
                main,
                readOnlyStorage,
                readWriteStorage,
                occlusion,
                timestamp,
                nativeFailure,
                diagnostics: {
                    version: evidence.version,
                    jsonRoundTrip: JSON.stringify(JSON.parse(JSON.stringify(evidence))) ===
                        JSON.stringify(evidence),
                    pendingOperationCount: snapshot.pendingOperations.length,
                    bindSetPreparationOperations: evidence.operations.filter(
                        operation => operation.kind === 'bind-set-preparation'
                    ).length,
                    incidentCount: evidence.incidents.length,
                },
                uncaptured,
            }
        } finally {
            runtime.device.removeEventListener('uncapturederror', onUncaptured)
            runtime.dispose()
        }

        async function dynamicRegionAndReplacementProbe(runtime, layoutCodec) {
            const valueCodec = layoutCodec({
                label: 'browser region value',
                name: 'RegionValue',
                fields: [ { name: 'value', type: 'u32' } ],
            }, {
                usage: [ 'storage', 'readback' ],
            })
            const input = await runtime.createBuffer({
                label: 'browser large typed input',
                size: 512,
                usage: GPUBufferUsage.COPY_DST |
                    GPUBufferUsage.COPY_SRC |
                    GPUBufferUsage.STORAGE,
            })
            const output = await runtime.createBuffer({
                label: 'browser dynamic output',
                size: 512,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
            })
            const inputA = input.region({
                offset: 0,
                size: valueCodec.artifact.stride,
                layout: valueCodec.artifact,
            })
            const inputB = input.region({
                offset: 256,
                size: valueCodec.artifact.stride,
                layout: valueCodec.artifact,
            })
            const rawOverlap = input.region({ offset: 256, size: 4 })
            const outputA = output.region({
                offset: 0,
                size: valueCodec.artifact.stride,
                layout: valueCodec.artifact,
            })
            const outputB = output.region({
                offset: 256,
                size: valueCodec.artifact.stride,
                layout: valueCodec.artifact,
            })
            const sampledTexture = await runtime.createTexture({
                label: 'browser sampled texture',
                size: [ 1, 1 ],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
            })
            const storageTexture = await runtime.createTexture({
                label: 'browser write storage texture',
                size: [ 1, 1 ],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
            })
            const sampledView = sampledTexture.view()
            const storageView = storageTexture.view()
            const sampler = await runtime.createSampler({
                label: 'browser nearest sampler',
                magFilter: 'nearest',
                minFilter: 'nearest',
            })
            const layout = await runtime.createBindLayout({
                label: 'browser persistent binding matrix layout',
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'inputValue',
                        type: 'read-storage',
                        visibility: [ 'compute' ],
                        hasDynamicOffset: true,
                        minBindingSize: valueCodec.artifact.byteLength,
                    },
                    {
                        binding: 1,
                        name: 'outputValue',
                        type: 'storage',
                        visibility: [ 'compute' ],
                        hasDynamicOffset: true,
                        minBindingSize: valueCodec.artifact.byteLength,
                    },
                    {
                        binding: 2,
                        name: 'sampledImage',
                        type: 'texture',
                        visibility: [ 'compute' ],
                        sampleType: 'float',
                        viewDimension: '2d',
                    },
                    {
                        binding: 3,
                        name: 'sampledImageSampler',
                        type: 'sampler',
                        visibility: [ 'compute' ],
                        samplerType: 'filtering',
                    },
                    {
                        binding: 4,
                        name: 'storageImage',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d',
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(layout, {
                inputValue: inputA,
                outputValue: outputA,
                sampledImage: sampledView,
                sampledImageSampler: sampler,
                storageImage: storageView,
            }, {
                label: 'browser persistent binding matrix set',
            })
            const source = `
                struct RegionValue {
                    value: u32,
                };

                @group(0) @binding(0) var<storage, read> inputValue: RegionValue;
                @group(0) @binding(1) var<storage, read_write> outputValue: RegionValue;
                @group(0) @binding(2) var sampledImage: texture_2d<f32>;
                @group(0) @binding(3) var sampledImageSampler: sampler;
                @group(0) @binding(4) var storageImage: texture_storage_2d<rgba8unorm, write>;

                @compute @workgroup_size(1)
                fn main() {
                    let sampled = u32(round(textureSampleLevel(
                        sampledImage,
                        sampledImageSampler,
                        vec2f(0.5),
                        0.0
                    ).r * 255.0));
                    let result = inputValue.value + sampled;
                    outputValue.value = result;
                    textureStore(
                        storageImage,
                        vec2i(0, 0),
                        vec4f(f32(result) / 255.0, 0.0, 0.0, 1.0)
                    );
                }
            `
            const program = runtime.createProgram({
                label: 'browser persistent binding matrix program',
                modules: [ source ],
                entryPoints: { compute: 'main' },
                layoutRequirements: [
                    {
                        group: 0,
                        binding: 0,
                        name: 'inputValue',
                        type: 'read-storage',
                        visibility: [ 'compute' ],
                        hasDynamicOffset: true,
                        layout: valueCodec.artifact,
                    },
                    {
                        group: 0,
                        binding: 1,
                        name: 'outputValue',
                        type: 'storage',
                        visibility: [ 'compute' ],
                        hasDynamicOffset: true,
                        layout: valueCodec.artifact,
                    },
                ],
            })
            const pipeline = await runtime.createComputePipeline({
                label: 'browser persistent binding matrix pipeline',
                program,
                bindLayouts: [ layout ],
            })
            const pass = runtime.createComputePass({
                label: 'browser persistent binding matrix pass',
            })
            const commands = [
                { inputOffset: 0, outputOffset: 0 },
                { inputOffset: 256, outputOffset: 256 },
            ].map(({ inputOffset, outputOffset }, index) =>
                runtime.createDispatchCommand({
                    label: `browser dynamic region dispatch ${index}`,
                    pipeline,
                    bindSets: [ {
                        set: bindSet,
                        dynamicOffsets: {
                            inputValue: inputOffset,
                            outputValue: outputOffset,
                        },
                    } ],
                    count: { workgroups: [ 1 ] },
                    resources: {
                        read: [
                            { resource: input, contentEpoch: 2 },
                            { resource: sampledTexture, contentEpoch: 1 },
                        ],
                        write: [ output, storageTexture ],
                    },
                    whenMissing: 'throw',
                })
            )
            const uploads = [
                runtime.createUploadCommand({
                    label: 'browser typed input A',
                    target: inputA,
                    data: new Uint32Array([ 7 ]),
                }),
                runtime.createUploadCommand({
                    label: 'browser typed input B',
                    target: inputB,
                    data: new Uint32Array([ 23 ]),
                }),
                runtime.createTextureUploadCommand({
                    label: 'browser sampled texel',
                    target: sampledTexture,
                    data: new Uint8Array([ 10, 0, 0, 255 ]),
                    layout: { bytesPerRow: 4, rowsPerImage: 1 },
                    size: { width: 1, height: 1 },
                }),
            ]
            const initialWork = runtime.createSubmission({ validation: 'throw' })
                .upload(uploads[0])
                .upload(uploads[1])
                .upload(uploads[2])
                .compute(pass, commands)
                .submit()
            await initialWork.done
            const initialValues = await Promise.all([
                readUint32(runtime, outputA, initialWork),
                readUint32(runtime, outputB, initialWork),
            ])

            const storageResourceId = storageTexture.id
            const storageViewHash = storageView.hash
            const initialAllocationVersion = storageTexture.allocationVersion
            const initialGeneration = bindSet.prepareGeneration
            const initialSnapshotHash = bindSet.preparedSnapshotHash
            await storageTexture.resize([ 2, 2 ])
            const staleState = bindSet.preparationState
            const staleFailure = captureFailure(() => runtime.createSubmission({ validation: 'throw' })
                .compute(pass, [ commands[0] ])
                .submit(), ScratchDiagnosticError)
            await bindSet.prepare()
            const replacementGeneration = bindSet.prepareGeneration
            const replacementSnapshotHash = bindSet.preparedSnapshotHash
            const storageReadback = await runtime.createBuffer({
                label: 'browser storage texture readback',
                size: 256,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            })
            const copyStorage = runtime.createCopyCommand({
                label: 'browser copy write storage output',
                source: { resource: storageTexture, contentEpoch: 3 },
                target: storageReadback.region(),
                targetLayout: { bytesPerRow: 256, rowsPerImage: 1 },
                size: { width: 1, height: 1 },
                whenMissing: 'throw',
            })
            const replacementWork = runtime.createSubmission({ validation: 'throw' })
                .compute(pass, [ commands[0] ])
                .copy(copyStorage)
                .submit()
            await replacementWork.done
            const replacementOutput = await readUint32(runtime, outputA, replacementWork)
            const storageBytes = await readBytes(runtime, storageReadback.region(), replacementWork)

            return {
                regions: {
                    oneParent: inputA.buffer === inputB.buffer && inputB.buffer === rawOverlap.buffer,
                    typedOffsets: [ inputA.offset, inputB.offset ],
                    typedSizes: [ inputA.size, inputB.size ],
                    rawOverlapOffset: rawOverlap.offset,
                    rawOverlapHasNoLayout: rawOverlap.layout === undefined,
                    abiHash: inputA.layout?.abiHash,
                    schemaHash: inputA.layout?.schemaHash,
                    secondTypedSharesLayout: inputB.layout === inputA.layout,
                },
                commands: {
                    sharedBindSet: commands.every(command => command.bindSets[0].set === bindSet),
                    dynamicOffsets: commands.map(command => command.bindSets[0].dynamicOffsets),
                    frozen: commands.every(command => (
                        Object.isFrozen(command.bindSets[0]) &&
                        Object.isFrozen(command.bindSets[0].dynamicOffsets)
                    )),
                },
                initial: {
                    values: initialValues,
                    bindSetState: bindSet.preparationState,
                    prepareGeneration: initialGeneration,
                },
                replacement: {
                    resourceIdentityStable: storageTexture.id === storageResourceId,
                    logicalViewStable:
                        bindSet.bindings.get('storageImage')?.resource === storageView &&
                        storageView.hash === storageViewHash,
                    allocationVersionBefore: initialAllocationVersion,
                    allocationVersionAfter: storageTexture.allocationVersion,
                    staleState,
                    staleFailure: serializeFailure(staleFailure),
                    preparedState: bindSet.preparationState,
                    generationBefore: initialGeneration,
                    generationAfter: replacementGeneration,
                    snapshotChanged: replacementSnapshotHash !== initialSnapshotHash,
                    reusedCommand: commands[0].bindSets[0].set === bindSet,
                    outputValue: replacementOutput,
                    storagePixel: Array.from(storageBytes.slice(0, 4)),
                },
            }
        }

        async function readOnlyStorageTextureProbe(runtime) {
            const sourceTexture = await runtime.createTexture({
                label: 'browser read-only storage texture',
                size: [ 1, 1 ],
                format: 'r32uint',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
            })
            const output = await runtime.createBuffer({
                label: 'browser read-only storage output',
                size: 4,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
            })
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'sourceImage',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'read-only',
                        format: 'r32uint',
                        viewDimension: '2d',
                    },
                    {
                        binding: 1,
                        name: 'outputValue',
                        type: 'storage',
                        visibility: [ 'compute' ],
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(layout, {
                sourceImage: sourceTexture.view(),
                outputValue: output.region(),
            })
            const program = runtime.createProgram({
                modules: [ `
                    @group(0) @binding(0)
                    var sourceImage: texture_storage_2d<r32uint, read>;
                    @group(0) @binding(1)
                    var<storage, read_write> outputValue: array<u32>;

                    @compute @workgroup_size(1)
                    fn main() {
                        outputValue[0] = textureLoad(sourceImage, vec2i(0, 0)).r;
                    }
                ` ],
                entryPoints: { compute: 'main' },
            })
            const pipeline = await runtime.createComputePipeline({ program, bindLayouts: [ layout ] })
            const pass = runtime.createComputePass()
            const initializer = await createUintStorageTextureInitializer(
                runtime,
                sourceTexture,
                41,
                'browser initialize read-only storage texture'
            )
            const dispatch = runtime.createDispatchCommand({
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ { resource: sourceTexture, contentEpoch: 1 } ],
                    write: [ output ],
                },
                whenMissing: 'throw',
            })
            const work = runtime.createSubmission({ validation: 'throw' })
                .compute(initializer.pass, [ initializer.dispatch ])
                .compute(pass, [ dispatch ])
                .submit()
            await work.done
            return {
                status: 'passed',
                value: await readUint32(runtime, output.region(), work),
                bindSetState: bindSet.preparationState,
                contentEpoch: output.contentEpoch,
            }
        }

        async function readWriteStorageTextureProbe(runtime) {
            const texture = await runtime.createTexture({
                label: 'browser read-write storage texture',
                size: [ 1, 1 ],
                format: 'r32uint',
                usage: GPUTextureUsage.STORAGE_BINDING,
            })
            const output = await runtime.createBuffer({
                label: 'browser read-write storage output',
                size: 4,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
            })
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'image',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'read-write',
                        format: 'r32uint',
                        viewDimension: '2d',
                    },
                    {
                        binding: 1,
                        name: 'outputValue',
                        type: 'storage',
                        visibility: [ 'compute' ],
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(layout, {
                image: texture.view(),
                outputValue: output.region(),
            })
            const program = runtime.createProgram({
                modules: [ `
                    @group(0) @binding(0)
                    var image: texture_storage_2d<r32uint, read_write>;
                    @group(0) @binding(1)
                    var<storage, read_write> outputValue: array<u32>;

                    @compute @workgroup_size(1)
                    fn main() {
                        let value = textureLoad(image, vec2i(0, 0)).r;
                        let nextValue = value + 1u;
                        textureStore(image, vec2i(0, 0), vec4u(nextValue, 0u, 0u, 0u));
                        outputValue[0] = nextValue;
                    }
                ` ],
                entryPoints: { compute: 'main' },
            })
            const pipeline = await runtime.createComputePipeline({ program, bindLayouts: [ layout ] })
            const pass = runtime.createComputePass()
            const initializer = await createUintStorageTextureInitializer(
                runtime,
                texture,
                5,
                'browser initialize read-write storage texture'
            )
            const dispatch = runtime.createDispatchCommand({
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [ { resource: texture, contentEpoch: 1 } ],
                    write: [ texture, output ],
                },
                whenMissing: 'throw',
            })
            const work = runtime.createSubmission({ validation: 'throw' })
                .compute(initializer.pass, [ initializer.dispatch ])
                .compute(pass, [ dispatch ])
                .submit()
            await work.done
            return {
                status: 'passed',
                value: await readUint32(runtime, output.region(), work),
                bindSetState: bindSet.preparationState,
                contentEpoch: texture.contentEpoch,
            }
        }

        async function createUintStorageTextureInitializer(runtime, texture, value, label) {
            const layout = await runtime.createBindLayout({
                group: 0,
                entries: [ {
                    binding: 0,
                    name: 'targetImage',
                    type: 'storage-texture',
                    visibility: [ 'compute' ],
                    access: 'write-only',
                    format: 'r32uint',
                    viewDimension: '2d',
                } ],
            })
            const bindSet = await runtime.createBindSet(layout, {
                targetImage: texture.view(),
            })
            const program = runtime.createProgram({
                modules: [ `
                    @group(0) @binding(0)
                    var targetImage: texture_storage_2d<r32uint, write>;

                    @compute @workgroup_size(1)
                    fn main() {
                        textureStore(targetImage, vec2i(0, 0), vec4u(${value}u, 0u, 0u, 0u));
                    }
                ` ],
                entryPoints: { compute: 'main' },
            })
            const pipeline = await runtime.createComputePipeline({
                program,
                bindLayouts: [ layout ],
            })
            return {
                pass: runtime.createComputePass(),
                dispatch: runtime.createDispatchCommand({
                    label,
                    pipeline,
                    bindSets: [ { set: bindSet } ],
                    count: { workgroups: [ 1 ] },
                    resources: { read: [], write: [ texture ] },
                    whenMissing: 'throw',
                }),
            }
        }

        async function occlusionQueryProbe(runtime) {
            const querySet = await runtime.createQuerySet({
                label: 'browser occlusion query',
                type: 'occlusion',
                count: 1,
            })
            const target = await runtime.createTexture({
                label: 'browser occlusion target',
                size: [ 4, 4 ],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
            const destination = await runtime.createBuffer({
                size: 8,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            })
            const pass = runtime.createRenderPass({
                color: [ {
                    target: target.view(),
                    load: 'clear',
                    store: 'store',
                    clear: [ 0, 0, 0, 1 ],
                } ],
                occlusionQuerySet: querySet,
            })
            const program = runtime.createProgram({
                modules: [ `
                    @vertex
                    fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
                        let positions = array(
                            vec2f(0.0, 0.8),
                            vec2f(-0.8, -0.8),
                            vec2f(0.8, -0.8)
                        );
                        return vec4f(positions[index], 0.0, 1.0);
                    }

                    @fragment
                    fn fsMain() -> @location(0) vec4f {
                        return vec4f(1.0);
                    }
                ` ],
                entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
            })
            const pipeline = await runtime.createRenderPipeline({
                program,
                targets: [ { format: 'rgba8unorm' } ],
            })
            const begin = runtime.createBeginOcclusionQueryCommand({ querySet, index: 0 })
            const draw = runtime.createDrawCommand({
                pipeline,
                count: { vertexCount: 3 },
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            })
            const end = runtime.createEndOcclusionQueryCommand()
            const resolve = runtime.createResolveQuerySetCommand({
                source: { querySet, slots: [ { index: 0, contentEpoch: 1 } ] },
                destination: destination.region(),
                whenMissing: 'throw',
            })
            const work = runtime.createSubmission({ validation: 'throw' })
                .render(pass, [ begin, draw, end ])
                .resolve(resolve)
                .submit()
            await work.done
            const bytes = await readBytes(runtime, destination.region(), work)
            const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                .getBigUint64(0, true)
            return {
                status: 'passed',
                value: value.toString(),
                positive: value > 0n,
                slot: querySet.slot(0),
            }
        }

        async function timestampQueryProbe(runtime) {
            const querySet = await runtime.createQuerySet({
                label: 'browser timestamp query',
                type: 'timestamp',
                count: 2,
            })
            const destination = await runtime.createBuffer({
                size: 16,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            })
            const pass = runtime.createComputePass({
                timestampWrites: { querySet, begin: 0, end: 1 },
            })
            const resolve = runtime.createResolveQuerySetCommand({
                source: {
                    querySet,
                    slots: [
                        { index: 0, contentEpoch: 1 },
                        { index: 1, contentEpoch: 1 },
                    ],
                },
                destination: destination.region(),
                whenMissing: 'throw',
            })
            const work = runtime.createSubmission({ validation: 'throw' })
                .compute(pass, [])
                .resolve(resolve)
                .submit()
            await work.done
            const bytes = await readBytes(runtime, destination.region(), work)
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            const begin = view.getBigUint64(0, true)
            const end = view.getBigUint64(8, true)
            return {
                status: 'passed',
                begin: begin.toString(),
                end: end.toString(),
                monotonic: end >= begin,
                slots: querySet.slots(),
            }
        }

        async function controlledNativeFailureProbe(runtime, ErrorType) {
            const program = runtime.createProgram({
                label: 'browser controlled invalid WGSL program',
                modules: [ `
                    @compute @workgroup_size(1)
                    fn broken(
                ` ],
                entryPoints: { compute: 'broken' },
            })
            let failure = { rejected: false }
            try {
                await runtime.createComputePipeline({
                    label: 'browser controlled invalid WGSL pipeline',
                    program,
                })
            } catch (error) {
                failure = {
                    rejected: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    diagnostic: error?.diagnostic,
                    incident: error?.incident,
                }
            }
            const pipelineId = failure?.incident?.target?.pipelineId
            const operation = pipelineId === undefined
                ? undefined
                : runtime.diagnostics.operations({
                    targetKind: 'pipeline',
                    pipelineId,
                })[0]
            return {
                ...serializeFailure(failure),
                operation: operation === undefined ? undefined : {
                    id: operation.id,
                    kind: operation.kind,
                    status: operation.status,
                    target: operation.target,
                    incidentId: operation.incidentId,
                },
            }
        }

        async function readUint32(runtime, region, after) {
            const bytes = await readBytes(runtime, region, after)
            return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                .getUint32(0, true)
        }

        async function readBytes(runtime, region, after) {
            return await runtime.createReadback({
                source: region,
                after,
                retain: 'consume-on-read',
            }).toBytes()
        }

        function captureFailure(action, ErrorType) {
            try {
                action()
                return { rejected: false }
            } catch (error) {
                return {
                    rejected: true,
                    scratchDiagnostic: error instanceof ErrorType,
                    diagnostic: error?.diagnostic,
                    incident: error?.incident,
                }
            }
        }

        function serializeFailure(failure) {
            return {
                rejected: failure?.rejected === true,
                scratchDiagnostic: failure?.scratchDiagnostic === true,
                diagnostic: failure?.diagnostic,
                incident: failure?.incident,
            }
        }

        function serializeGpuError(error) {
            return {
                name: error?.constructor?.name ?? error?.name ?? 'unknown',
                message: error?.message ?? String(error),
            }
        }
    }, { moduleUrl })

    await page.screenshot({ path: resolve(outputDirectory, 'binding-probe-host.png'), fullPage: true })
    await context.close()
    return {
        ...probe,
        moduleUrl,
        consoleFailures,
        pageErrors,
        requestFailures,
    }
}

function validateResult(adapter, probe, probeError) {

    const failures = []
    if (!adapter.available || !adapter.adapterAvailable) failures.push('WebGPU adapter is unavailable')
    if (probeError !== undefined) failures.push(`binding probe threw: ${probeError}`)
    if (probe === undefined) return failures
    if (probe.consoleFailures.length > 0) failures.push(`${probe.consoleFailures.length} console failures`)
    if (probe.pageErrors.length > 0) failures.push(`${probe.pageErrors.length} page errors`)
    if (probe.requestFailures.length > 0) failures.push(`${probe.requestFailures.length} request failures`)
    if (probe.uncaptured.length > 0) failures.push(`${probe.uncaptured.length} uncaptured WebGPU errors`)

    const main = probe.main
    if (!main.regions.oneParent) failures.push('typed/raw regions do not share one parent buffer')
    if (!equalNumbers(main.regions.typedOffsets, [ 0, 256 ])) failures.push('typed region offsets drifted')
    if (!equalNumbers(main.regions.typedSizes, [ 4, 4 ])) failures.push('typed region sizes drifted')
    if (main.regions.rawOverlapOffset !== 256 || !main.regions.rawOverlapHasNoLayout) {
        failures.push('raw overlapping region facts drifted')
    }
    if (!main.regions.abiHash?.startsWith('layout-abi-')) failures.push('typed region ABI hash missing')
    if (!main.regions.schemaHash?.startsWith('layout-schema-')) failures.push('typed region schema hash missing')
    if (!main.regions.secondTypedSharesLayout) failures.push('typed regions do not share one LayoutArtifact')
    if (!main.commands.sharedBindSet || !main.commands.frozen) {
        failures.push('preconstructed dynamic-offset Commands do not share one immutable BindSet invocation')
    }
    if (JSON.stringify(main.commands.dynamicOffsets) !== JSON.stringify([
        { inputValue: 0, outputValue: 0 },
        { inputValue: 256, outputValue: 256 },
    ])) failures.push('command-owned dynamic offsets drifted')
    if (!equalNumbers(main.initial.values, [ 17, 33 ])) failures.push('dynamic region GPU output drifted')
    if (main.initial.prepareGeneration !== 1) failures.push('initial prepare generation drifted')

    const replacement = main.replacement
    if (!replacement.resourceIdentityStable || !replacement.logicalViewStable) {
        failures.push('logical storage texture/view identity changed across replacement')
    }
    if (replacement.allocationVersionAfter !== replacement.allocationVersionBefore + 1) {
        failures.push('replacement allocationVersion did not advance once')
    }
    if (replacement.staleState !== 'stale') failures.push('replacement did not mark BindSet stale')
    if (replacement.staleFailure?.diagnostic?.code !== 'SCRATCH_BIND_SET_STALE') {
        failures.push('stale reuse did not produce SCRATCH_BIND_SET_STALE')
    }
    if (!replacement.staleFailure?.scratchDiagnostic) failures.push('stale failure was not structured')
    if (replacement.preparedState !== 'prepared') failures.push('explicit prepare did not restore prepared state')
    if (replacement.generationAfter !== replacement.generationBefore + 1) {
        failures.push('replacement prepare generation did not advance once')
    }
    if (!replacement.snapshotChanged || !replacement.reusedCommand) {
        failures.push('replacement did not commit a new snapshot for the existing Command')
    }
    if (replacement.outputValue !== 17) failures.push('replacement Command GPU output drifted')
    if (!equalNumbers(replacement.storagePixel, [ 17, 0, 0, 255 ])) {
        failures.push('write-only storage texture pixel drifted')
    }

    if (probe.readOnlyStorage.status !== 'passed' || probe.readOnlyStorage.value !== 41) {
        failures.push('read-only storage texture path failed exact GPU proof')
    }
    if (probe.readWriteStorage.status !== 'passed' || probe.readWriteStorage.value !== 6) {
        failures.push('read-write storage texture path failed exact GPU proof')
    }
    if (probe.occlusion.status !== 'passed' || !probe.occlusion.positive) {
        failures.push('occlusion query did not report visible samples')
    }
    if (probe.occlusion.slot?.state !== 'ready' || probe.occlusion.slot?.contentEpoch !== 1) {
        failures.push('occlusion query slot facts drifted')
    }
    if (probe.timestamp.status === 'passed') {
        if (!probe.timestamp.monotonic) failures.push('timestamp query results are not monotonic')
        if (probe.timestamp.slots.some(slot => slot.state !== 'ready' || slot.contentEpoch !== 1)) {
            failures.push('timestamp query slot facts drifted')
        }
    } else if (
        probe.timestamp.status !== 'skipped' ||
        probe.timestamp.reason !== 'runtime.deviceFeatures lacks timestamp-query'
    ) {
        failures.push('timestamp capability was neither proved nor factually skipped')
    }

    const nativeFailure = probe.nativeFailure
    if (!nativeFailure.rejected || !nativeFailure.scratchDiagnostic) {
        failures.push('controlled native failure was not a ScratchDiagnosticError')
    }
    const nativeFailureCodes = new Set([
        nativeFailure.diagnostic?.code,
        ...(nativeFailure.diagnostic?.actual?.diagnosticCodes ?? []),
        ...(nativeFailure.incident?.outcomes ?? []).map(outcome => outcome.diagnosticCode),
    ])
    if (!nativeFailureCodes.has('SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')) {
        failures.push('controlled native failure lacks shader compilation diagnosis')
    }
    if (nativeFailure.incident?.kind !== 'pipeline-failure') {
        failures.push('controlled native failure incident kind drifted')
    }
    if (
        nativeFailure.operation?.kind !== 'compute-pipeline-creation' ||
        nativeFailure.operation?.status !== 'failed' ||
        nativeFailure.operation?.target?.kind !== 'pipeline'
    ) failures.push('controlled native failure operation/subject attribution drifted')
    if (nativeFailure.operation?.incidentId !== nativeFailure.incident?.id) {
        failures.push('controlled native failure operation is not linked to its incident')
    }

    if (probe.diagnostics.version !== 5) failures.push('browser evidence is not diagnostics schema v5')
    if (!probe.diagnostics.jsonRoundTrip) failures.push('browser evidence failed JSON round trip')
    if (probe.diagnostics.pendingOperationCount !== 0) failures.push('browser probe retained pending operations')
    return failures
}

function equalNumbers(actual, expected) {

    return actual.length === expected.length &&
        actual.every((value, index) => value === expected[index])
}

function attachFailureListeners(page, consoleFailures, pageErrors, requestFailures) {

    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') {
            consoleFailures.push({ type: message.type(), text: message.text() })
        }
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('requestfailed', request => {
        requestFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText ?? 'unknown',
        })
    })
}
