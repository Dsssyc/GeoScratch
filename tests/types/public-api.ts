import * as scr from 'geoscratch'
import { MercatorCoordinate } from 'geoscratch/geo'
import { plane, sphere } from 'geoscratch/geometry'

const startResult: Promise<GPUDevice | undefined> = scr.StartDash()
const device: GPUDevice = scr.getDevice()

const screen = scr.screen({
    canvas: document.createElement('canvas'),
})
const createdScreen: scr.Screen = scr.Screen.create({
    canvas: document.createElement('canvas'),
})

const pass = scr.renderPass({
    name: 'typed render pass',
    colorAttachments: [ { colorResource: screen } ],
})

const shader = scr.shader({
    name: 'typed shader',
    codeFunc: () => '@vertex fn vMain() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fMain() -> @location(0) vec4f { return vec4f(); }',
})

const pipeline = scr.renderPipeline({
    name: 'typed pipeline',
    shader: { module: shader },
})

const binding = scr.binding({
    name: 'typed binding',
    range: () => [ 3 ],
})

pass.add(pipeline, binding)

const mercator = MercatorCoordinate.fromLonLat([ 0, 0 ])
const planeGeometry = plane(2)
const sphereGeometry = sphere(1, 8, 4)

async function useScratchFoundation(gpu: GPU, canvas: HTMLCanvasElement) {

    const runtime: scr.ScratchRuntime = await scr.ScratchRuntime.create({
        gpu,
        label: 'typed scratch runtime',
        requiredFeatures: [ 'timestamp-query' ],
        requiredLimits: { maxBufferSize: 1024 },
    })

    const surface: scr.Surface = runtime.createSurface(canvas, {
        format: 'preferred',
        alphaMode: 'opaque',
        size: { width: 2, height: 2 },
    })

    const buffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch buffer',
        size: 16,
        usage: 1,
    })
    const uniformBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch uniform buffer',
        size: 16,
        usage: 0x8 | 0x40,
    })
    const vertexBuffer: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch vertex buffer',
        size: 24,
        usage: 0x20 | 0x8,
    })
    const storageInput: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch storage input',
        size: 16,
        usage: 0x8 | 0x80,
    })
    const storageOutput: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch storage output',
        size: 16,
        usage: 0x4 | 0x80,
    })
    const queryDestination: scr.BufferResource = runtime.createBuffer({
        label: 'typed scratch query destination',
        size: 256,
        usage: 0x4 | 0x200,
    })
    const scratchTexture: scr.TextureResource = runtime.createTexture({
        label: 'typed scratch texture',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: 0x2 | 0x4 | 0x10,
    })
    const scratchSampler: scr.SamplerResource = runtime.createSampler({
        label: 'typed scratch sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const scratchTextureView: GPUTextureView = scratchTexture.createView()

    const diagnostic: scr.ScratchDiagnostic = scr.createScratchDiagnostic({
        code: 'SCRATCH_RESOURCE_WRONG_RUNTIME',
        severity: 'error',
        phase: 'resource',
        subject: { kind: 'Resource', id: buffer.id },
        message: 'typed diagnostic',
        hints: [ 'typed hint' ],
    })
    const report: scr.ScratchDiagnosticReport = scr.createScratchDiagnosticReport([ diagnostic ])
    const error = new scr.ScratchDiagnosticError(diagnostic, report)

    buffer.assertRuntime(runtime)

    const program: scr.Program = runtime.createProgram({
        label: 'typed program',
        modules: [
            '@vertex fn vsMain() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fsMain() -> @location(0) vec4f { return vec4f(); }',
        ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const bindLayout: scr.BindLayout = runtime.createBindLayout({
        label: 'typed bind layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'uniforms',
                type: 'uniform',
                visibility: [ 'vertex', 'fragment' ],
            },
        ],
    })
    const bindSet: scr.BindSet = runtime.createBindSet(bindLayout, {
        uniforms: uniformBuffer,
    }, {
        label: 'typed bind set',
    })
    const storageLayout: scr.BindLayout = runtime.createBindLayout({
        label: 'typed storage layout',
        group: 1,
        entries: [
            {
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                visibility: [ 'compute' ],
            },
            {
                binding: 1,
                name: 'outputValues',
                type: 'storage',
                visibility: [ 'compute' ],
            },
        ],
    })
    const storageSet: scr.BindSet = runtime.createBindSet(storageLayout, {
        inputValues: storageInput,
        outputValues: storageOutput,
    })
    const textureLayout: scr.BindLayout = runtime.createBindLayout({
        label: 'typed texture layout',
        group: 2,
        entries: [
            {
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const textureSet: scr.BindSet = runtime.createBindSet(textureLayout, {
        colorTexture: scratchTexture,
        colorSampler: scratchSampler,
    })
    const upload: scr.UploadCommand = runtime.createUploadCommand({
        target: uniformBuffer,
        data: new Float32Array([ 1, 0, 0, 1 ]),
        offset: 0,
    })
    const textureUpload: scr.TextureUploadCommand = runtime.createTextureUploadCommand({
        target: scratchTexture,
        data: new Uint8Array(16),
        layout: { bytesPerRow: 8, rowsPerImage: 2 },
        size: { width: 2, height: 2 },
    })
    const copy: scr.CopyCommand = runtime.createCopyCommand({
        label: 'typed scratch copy',
        source: storageOutput,
        sourceOffset: 0,
        target: storageInput,
        targetOffset: 0,
        byteLength: 16,
    })
    const copyAlias: scr.CopyCommand = runtime.copyCommand({
        source: storageOutput,
        target: storageInput,
        byteLength: 16,
    })
    const querySet: scr.QuerySetResource = runtime.createQuerySet({
        label: 'typed timestamp queries',
        type: 'timestamp',
        count: 2,
    })
    const querySetAlias: scr.QuerySetResource = runtime.querySet({
        type: 'occlusion',
        count: 1,
    })
    const resolveQueries: scr.ResolveQuerySetCommand = runtime.createResolveQuerySetCommand({
        label: 'typed query resolve',
        querySet,
        firstQuery: 0,
        queryCount: 2,
        destination: queryDestination,
        destinationOffset: 0,
    })
    const resolveAlias: scr.ResolveQuerySetCommand = runtime.resolveQuerySetCommand({
        querySet,
        queryCount: 1,
        destination: queryDestination,
    })
    const scratchPipeline: scr.ScratchRenderPipeline = runtime.createRenderPipeline({
        label: 'typed scratch pipeline',
        program,
        bindLayouts: [ bindLayout ],
        vertexBuffers: [
            {
                arrayStride: 8,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' },
                ],
            },
        ],
        targets: [ { format: surface.format } ],
    })
    const draw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
        bindSets: [ bindSet ],
        vertexBuffers: [
            { slot: 0, buffer: vertexBuffer, offset: 0, size: 24 },
        ],
        count: { vertexCount: 3 },
        whenMissing: 'throw',
    })
    const passSpec: scr.RenderPassSpec = runtime.createRenderPass({
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: { r: 0, g: 0, b: 0, a: 1 },
        } ],
        timestampWrites: {
            querySet,
            begin: 0,
            end: 1,
        },
    })
    const textureTargetPass: scr.RenderPassSpec = runtime.createRenderPass({
        color: [ {
            target: scratchTexture,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })
    const computeProgram: scr.Program = runtime.createProgram({
        modules: [
            '@group(1) @binding(0) var<storage, read> inputValues: array<f32>; @group(1) @binding(1) var<storage, read_write> outputValues: array<f32>; @compute @workgroup_size(4) fn csMain(@builtin(global_invocation_id) id: vec3u) { outputValues[id.x] = inputValues[id.x]; }',
        ],
        entryPoints: {
            compute: 'csMain',
        },
    })
    const computePipeline: scr.ScratchComputePipeline = runtime.createComputePipeline({
        program: computeProgram,
        bindLayouts: [ storageLayout ],
    })
    const dispatch: scr.DispatchCommand = runtime.createDispatchCommand({
        pipeline: computePipeline,
        bindSets: [ storageSet ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ storageInput ],
            write: [ storageOutput ],
        },
        whenMissing: 'throw',
    })
    const computePass: scr.ComputePassSpec = runtime.createComputePass({
        timestampWrites: {
            querySet,
            begin: 0,
        },
    })
    const builder: scr.SubmissionBuilder = runtime.createSubmission({ validation: 'throw' })
    const submitted: scr.SubmittedWork = builder.upload(upload).upload(textureUpload).compute(computePass, [ dispatch ]).copy(copy).copy(copyAlias).resolve(resolveQueries).resolve(resolveAlias).render(passSpec, [ draw ]).submit()
    const readback: scr.ReadbackOperation = runtime.createReadback({
        source: storageOutput,
        after: submitted,
        range: { offset: 0, byteLength: 16 },
    })
    const readbackBytes: Promise<Uint8Array> = readback.toBytes()
    const readbackValues: Promise<Float32Array> = readback.toArray(Float32Array)

    void surface
    void scratchTextureView
    void textureSet
    void textureTargetPass
    void copy
    void copyAlias
    void querySet
    void querySetAlias
    void resolveQueries
    void resolveAlias
    void error
    void submitted
    void readbackBytes
    void readbackValues
}

void startResult
void device
void screen
void createdScreen
void mercator
void planeGeometry
void sphereGeometry
void useScratchFoundation
