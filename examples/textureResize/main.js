import { ScratchRuntime } from 'geoscratch'

const canvas = document.getElementById('GPUFrame')
const statusElement = document.getElementById('proof-status')
const factsElement = document.getElementById('proof-facts')
const initialSurfaceSize = Object.freeze({ width: 4, height: 3 })
const resizedSurfaceSize = Object.freeze({ width: 8, height: 6 })
const paddedBytesPerRow = 256
const expectedTexel = Object.freeze([ 32, 160, 224, 255 ])
const clearColor = Object.freeze(expectedTexel.map(value => value / 255))

const sampleWgsl = `
@group(0) @binding(0)
var resizedTexture: texture_2d<f32>;

@group(0) @binding(1)
var resizedSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-0.86, -0.78),
        vec2f( 0.86, -0.78),
        vec2f(-0.86,  0.78),
        vec2f(-0.86,  0.78),
        vec2f( 0.86, -0.78),
        vec2f( 0.86,  0.78)
    );
    var uvs = array<vec2f, 6>(
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(0.0, 0.0),
        vec2f(0.0, 0.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, 0.0)
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4f {
    let sampled = textureSample(resizedTexture, resizedSampler, input.uv);
    let edge = max(abs(input.uv.x - 0.5), abs(input.uv.y - 0.5));
    let border = select(0.0, 1.0, edge > 0.46);
    return mix(sampled, vec4f(0.96, 0.96, 0.94, 1.0), border);
}
`

document.body.dataset.status = 'pending'

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    document.body.dataset.status = 'failed'
    document.body.dataset.error = message
    statusElement.textContent = `Failed: ${message}`
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'texture resize example runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'texture resize surface',
        format: 'preferred',
        alphaMode: 'opaque',
        size: initialSurfaceSize,
    })
    const texture = runtime.createTexture({
        label: 'texture resize offscreen color',
        size: surface.size,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.TEXTURE_BINDING,
    })
    const sampler = runtime.createSampler({
        label: 'texture resize sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const bindLayout = runtime.createBindLayout({
        label: 'texture resize sample layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'resizedTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'resizedSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const bindSet = runtime.createBindSet(bindLayout, {
        resizedTexture: texture,
        resizedSampler: sampler,
    }, {
        label: 'texture resize sample set',
    })
    const program = runtime.createProgram({
        label: 'texture resize sample program',
        modules: [ sampleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        label: 'texture resize sample pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const texturePass = runtime.createRenderPass({
        label: 'texture resize offscreen pass',
        color: [
            {
                target: texture,
                load: 'clear',
                store: 'store',
                clear: clearColor,
            },
        ],
    })
    const surfacePass = runtime.createRenderPass({
        label: 'texture resize presentation pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.025, 0.03, 0.04, 1 ],
            },
        ],
    })

    // Two offscreen renders produce epochs 1 and 2. The persistent presenter
    // declares the exact future epoch it will read after replacement.
    const draw = runtime.createDrawCommand({
        label: 'draw resized texture',
        pipeline,
        bindSets: [ bindSet ],
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: texture, contentEpoch: 2 } ],
            write: [],
        },
        whenMissing: 'throw',
    })

    const persistentReferences = { texture, texturePass, bindSet, draw }
    const initialResourceId = texture.id
    const initialTexture = texture.gpuTexture
    const initialView = texture.createView()
    const initialBindGroup = bindSet.getBindGroup()
    const wasInitialTextureDestroyed = observeDestroy(initialTexture)
    const initialAllocationVersion = texture.allocationVersion

    const initialWork = runtime.createSubmission({ validation: 'throw' })
        .render(texturePass, [])
        .submit()
    const initialContentEpoch = texture.contentEpoch

    surface.resize(resizedSurfaceSize)
    texture.resize(surface.size)

    const allocationVersionAfterResize = texture.allocationVersion
    const contentEpochAfterResize = texture.contentEpoch
    const stateAfterResize = texture.state
    const replacementTexture = texture.gpuTexture
    const replacementView = texture.createView()
    const readbackByteLength = paddedBytesPerRow * surface.size.height
    const readbackBuffer = runtime.createBuffer({
        label: 'texture resize padded readback buffer',
        size: readbackByteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })
    const copyToReadback = runtime.createCopyCommand({
        label: 'copy resized texture into padded rows',
        source: { resource: texture, contentEpoch: contentEpochAfterResize + 1 },
        target: readbackBuffer,
        targetLayout: {
            offset: 0,
            bytesPerRow: paddedBytesPerRow,
            rowsPerImage: surface.size.height,
        },
        size: surface.size,
        whenMissing: 'throw',
    })
    const readback = runtime.createReadbackCommand({
        label: 'read exact resized texture bytes',
        source: { resource: readbackBuffer, contentEpoch: 1 },
        sourceOffset: 0,
        byteLength: readbackByteLength,
        whenMissing: 'throw',
    })

    const replacementWork = runtime.createSubmission({ validation: 'throw' })
        .render(texturePass, [])
        .copy(copyToReadback)
        .readback(readback)
        .render(surfacePass, [ draw ])
        .submit()
    const bytes = await readback.result({ after: replacementWork }).toBytes()
    const contentEpochAfterRender = texture.contentEpoch
    const replacementBindGroup = bindSet.getBindGroup()

    const repeatedPresentation = runtime.createSubmission({ validation: 'throw' })
        .render(surfacePass, [ draw ])
        .submit()

    await Promise.all([ initialWork.done, replacementWork.done, repeatedPresentation.done ])

    const expectedBytes = createExpectedPaddedBytes(
        surface.size,
        paddedBytesPerRow,
        expectedTexel
    )
    const checks = {
        resourceIdUnchanged: texture.id === initialResourceId,
        gpuTextureChanged: replacementTexture !== initialTexture,
        allocationVersionAdvancedOnce:
            allocationVersionAfterResize === initialAllocationVersion + 1,
        contentEpochUnchangedByResize: contentEpochAfterResize === initialContentEpoch,
        stateBecameEmpty: stateAfterResize === 'empty',
        oldTextureDestroyed: wasInitialTextureDestroyed(),
        sameTextureObject: texture === persistentReferences.texture,
        sameBindSetObject: bindSet === persistentReferences.bindSet,
        samePassSpecObject: texturePass === persistentReferences.texturePass,
        sameDrawCommandObject: draw === persistentReferences.draw,
        viewChanged: replacementView !== initialView,
        bindGroupChanged: replacementBindGroup !== initialBindGroup,
        newRenderAdvancedOnce: contentEpochAfterRender === contentEpochAfterResize + 1,
        stateBecameReady: texture.state === 'ready',
        exactReadbackBytesMatched: bytesEqual(bytes, expectedBytes),
        initialLedgerUsesInitialAllocation: initialWork.resourceAccesses.some(access => (
            access.resourceId === texture.id &&
            access.allocationVersion === initialAllocationVersion
        )),
        replacementLedgerUsesCurrentAllocation: replacementWork.resourceAccesses
            .filter(access => access.resourceId === texture.id)
            .every(access => access.allocationVersion === allocationVersionAfterResize),
    }
    const failedChecks = Object.entries(checks)
        .filter(([, passed ]) => !passed)
        .map(([ name ]) => name)

    for (const [ name, passed ] of Object.entries(checks)) {
        document.body.dataset[name] = String(passed)
    }
    document.body.dataset.resourceId = texture.id
    document.body.dataset.initialAllocationVersion = String(initialAllocationVersion)
    document.body.dataset.allocationVersionAfterResize = String(allocationVersionAfterResize)
    document.body.dataset.initialContentEpoch = String(initialContentEpoch)
    document.body.dataset.contentEpochAfterResize = String(contentEpochAfterResize)
    document.body.dataset.contentEpochAfterRender = String(contentEpochAfterRender)
    document.body.dataset.stateAfterResize = stateAfterResize
    document.body.dataset.expectedBytes = JSON.stringify(Array.from(expectedBytes))
    document.body.dataset.actualBytes = JSON.stringify(Array.from(bytes))
    document.body.dataset.drawExecutionCount = '2'
    document.body.dataset.status = failedChecks.length === 0 ? 'passed' : 'failed'
    statusElement.textContent = failedChecks.length === 0 ? 'Passed' : 'Failed'
    factsElement.textContent = `${initialSurfaceSize.width}x${initialSurfaceSize.height} -> ${surface.size.width}x${surface.size.height}  |  allocation ${initialAllocationVersion} -> ${allocationVersionAfterResize}  |  epoch ${initialContentEpoch} -> ${contentEpochAfterRender}`

    if (failedChecks.length > 0) {
        throw new Error(`failed checks: ${failedChecks.join(', ')}`)
    }
}

function observeDestroy(texture) {

    let destroyed = false
    const nativeDestroy = texture.destroy

    Object.defineProperty(texture, 'destroy', {
        configurable: true,
        value() {
            destroyed = true
            return Reflect.apply(nativeDestroy, texture, [])
        },
    })

    return () => destroyed
}

function createExpectedPaddedBytes(size, bytesPerRow, texel) {

    const bytes = new Uint8Array(bytesPerRow * size.height)
    for (let y = 0; y < size.height; y++) {
        const rowOffset = y * bytesPerRow
        for (let x = 0; x < size.width; x++) {
            bytes.set(texel, rowOffset + x * texel.length)
        }
    }
    return bytes
}

function bytesEqual(actual, expected) {

    return actual.byteLength === expected.byteLength &&
        actual.every((value, index) => value === expected[index])
}
