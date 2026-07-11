import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')

const patternWgsl = `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0, -1.0),
        vec2f( 1.0,  1.0)
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
    let x = u32(floor(input.uv.x * 8.0));
    let y = u32(floor(input.uv.y * 8.0));
    let alternate = (x + y) % 2u == 0u;
    let first = vec3f(0.10, 0.68, 0.78);
    let second = vec3f(0.95, 0.67, 0.18);
    return vec4f(select(second, first, alternate), 1.0);
}
`

const sampleWgsl = `
@group(0) @binding(0)
var preservedTexture: texture_2d<f32>;

@group(0) @binding(1)
var preservedSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var positions = array<vec2f, 6>(
        vec2f(0.28, -0.72),
        vec2f(0.92, -0.72),
        vec2f(0.28,  0.72),
        vec2f(0.28,  0.72),
        vec2f(0.92, -0.72),
        vec2f(0.92,  0.72)
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
    return textureSample(preservedTexture, preservedSampler, input.uv);
}
`

await main().catch((error) => {
    canvas.dataset.status = 'error'
    console.error(error)
})

async function main() {

    canvas.dataset.status = 'loading'

    const runtime = await ScratchRuntime.create({
        label: 'readiness policies runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'readiness policies surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    resizeSurface(surface, canvas)

    const offscreenTexture = await runtime.createTexture({
        label: 'preserved offscreen content',
        size: { width: 320, height: 320 },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const missingResource = await runtime.createBuffer({
        label: 'intentionally empty readiness input',
        size: 16,
        usage: GPUBufferUsage.UNIFORM,
    })
    const sampler = runtime.createSampler({
        label: 'preserved content sampler',
        magFilter: 'nearest',
        minFilter: 'nearest',
    })
    const sampleLayout = runtime.createBindLayout({
        label: 'preserved content layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'preservedTexture',
                type: 'texture',
                sampleType: 'float',
                viewDimension: '2d',
                visibility: [ 'fragment' ],
            },
            {
                binding: 1,
                name: 'preservedSampler',
                type: 'sampler',
                samplerType: 'filtering',
                visibility: [ 'fragment' ],
            },
        ],
    })
    const sampleSet = runtime.createBindSet(sampleLayout, {
        preservedTexture: offscreenTexture,
        preservedSampler: sampler,
    })

    const seedProgram = runtime.createProgram({
        label: 'preserved checker program',
        modules: [ patternWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
    const fallbackProgram = createSolidProgram(runtime, {
        label: 'fallback green program',
        bounds: [ -0.92, -0.28, -0.72, 0.72 ],
        color: [ 0.16, 0.82, 0.52, 1 ],
    })
    const primaryProgram = createSolidProgram(runtime, {
        label: 'primary red program',
        bounds: [ -0.92, -0.28, -0.72, 0.72 ],
        color: [ 0.92, 0.16, 0.20, 1 ],
    })
    const optionalProgram = createSolidProgram(runtime, {
        label: 'optional magenta program',
        bounds: [ -0.16, 0.16, -0.72, 0.72 ],
        color: [ 0.84, 0.20, 0.72, 1 ],
    })
    const destructiveProgram = createSolidProgram(runtime, {
        label: 'destructive offscreen program',
        bounds: [ -1, 1, -1, 1 ],
        color: [ 0.90, 0.08, 0.10, 1 ],
    })
    const sampleProgram = runtime.createProgram({
        label: 'preserved texture sample program',
        modules: [ sampleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })

    const seedPipeline = runtime.createRenderPipeline({
        label: 'preserved checker pipeline',
        program: seedProgram,
        targets: [ { format: offscreenTexture.format } ],
    })
    const destructivePipeline = runtime.createRenderPipeline({
        label: 'destructive offscreen pipeline',
        program: destructiveProgram,
        targets: [ { format: offscreenTexture.format } ],
    })
    const fallbackPipeline = runtime.createRenderPipeline({
        label: 'fallback green pipeline',
        program: fallbackProgram,
        targets: [ { format: surface.format } ],
    })
    const primaryPipeline = runtime.createRenderPipeline({
        label: 'primary red pipeline',
        program: primaryProgram,
        targets: [ { format: surface.format } ],
    })
    const optionalPipeline = runtime.createRenderPipeline({
        label: 'optional magenta pipeline',
        program: optionalProgram,
        targets: [ { format: surface.format } ],
    })
    const samplePipeline = runtime.createRenderPipeline({
        label: 'preserved texture sample pipeline',
        program: sampleProgram,
        bindLayouts: [ sampleLayout ],
        targets: [ { format: surface.format } ],
    })

    const seedPass = runtime.createRenderPass({
        label: 'seed offscreen pass',
        color: [ {
            target: offscreenTexture,
            load: 'clear',
            store: 'store',
            clear: [ 0.04, 0.06, 0.08, 1 ],
        } ],
    })
    const skippedPass = runtime.createRenderPass({
        label: 'skipped destructive pass',
        color: [ {
            target: offscreenTexture,
            load: 'clear',
            store: 'store',
            clear: [ 0.90, 0.08, 0.10, 1 ],
        } ],
    })
    const surfacePass = runtime.createRenderPass({
        label: 'readiness result pass',
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: [ 0.035, 0.045, 0.06, 1 ],
        } ],
    })

    const seedDraw = runtime.createDrawCommand({
        label: 'seed preserved checker',
        pipeline: seedPipeline,
        count: { vertexCount: 6 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })
    const skipPassTrigger = runtime.createDrawCommand({
        label: 'skip destructive pass',
        pipeline: destructivePipeline,
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: missingResource, contentEpoch: 0 } ],
            write: [],
        },
        whenMissing: 'skip-pass',
    })
    const fallbackDraw = runtime.createDrawCommand({
        label: 'draw fallback green region',
        pipeline: fallbackPipeline,
        count: { vertexCount: 6 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })
    const primaryDraw = runtime.createDrawCommand({
        label: 'request primary red region',
        pipeline: primaryPipeline,
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: missingResource, contentEpoch: 0 } ],
            write: [],
        },
        whenMissing: 'use-fallback',
        fallback: fallbackDraw,
    })
    const optionalDraw = runtime.createDrawCommand({
        label: 'skip optional magenta region',
        pipeline: optionalPipeline,
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: missingResource, contentEpoch: 0 } ],
            write: [],
        },
        whenMissing: 'skip-command',
    })
    const sampleDraw = runtime.createDrawCommand({
        label: 'draw preserved checker region',
        pipeline: samplePipeline,
        bindSets: [ sampleSet ],
        count: { vertexCount: 6 },
        resources: {
            read: [ { resource: offscreenTexture, contentEpoch: 1 } ],
            write: [],
        },
        whenMissing: 'throw',
    })

    const submitted = runtime.createSubmission({ validation: 'throw' })
        .render(seedPass, [ seedDraw ])
        .render(skippedPass, [ skipPassTrigger ])
        .render(surfacePass, [ primaryDraw, optionalDraw, sampleDraw ])
        .submit()

    validateExecutionOutcomes(submitted.executionOutcomes, {
        seedPass,
        seedDraw,
        skippedPass,
        skipPassTrigger,
        surfacePass,
        primaryDraw,
        fallbackDraw,
        optionalDraw,
        sampleDraw,
    })

    await submitted.done
    canvas.dataset.status = 'ready'
}

function createSolidProgram(runtime, { label, bounds, color }) {

    const [ left, right, bottom, top ] = bounds
    const [ red, green, blue, alpha ] = color
    const source = `
        @vertex
        fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
            var positions = array<vec2f, 6>(
                vec2f(${left}, ${bottom}),
                vec2f(${right}, ${bottom}),
                vec2f(${left}, ${top}),
                vec2f(${left}, ${top}),
                vec2f(${right}, ${bottom}),
                vec2f(${right}, ${top})
            );
            return vec4f(positions[vertexIndex], 0.0, 1.0);
        }

        @fragment
        fn fsMain() -> @location(0) vec4f {
            return vec4f(${red}, ${green}, ${blue}, ${alpha});
        }
    `

    return runtime.createProgram({
        label,
        modules: [ source ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
}

function validateExecutionOutcomes(executionOutcomes, expected) {

    const passOutcomes = executionOutcomes.filter(outcome => outcome.outcomeKind === 'pass')
    const commandOutcomes = executionOutcomes.filter(outcome => outcome.outcomeKind === 'command')
    const seedPassOutcome = findBy(passOutcomes, 'passId', expected.seedPass.id)
    const skippedPassOutcome = findBy(passOutcomes, 'passId', expected.skippedPass.id)
    const surfacePassOutcome = findBy(passOutcomes, 'passId', expected.surfacePass.id)
    const primaryOutcome = findBy(commandOutcomes, 'requestedCommandId', expected.primaryDraw.id)
    const optionalOutcome = findBy(commandOutcomes, 'requestedCommandId', expected.optionalDraw.id)

    assertOutcome(seedPassOutcome.status === 'executed', 'seed pass must execute')
    assertIds(seedPassOutcome.encodedCommandIds, [ expected.seedDraw.id ], 'seed pass encoded ids')
    assertOutcome(skippedPassOutcome.status === 'skipped-pass', 'destructive pass must skip')
    assertOutcome(skippedPassOutcome.triggerCommandId === expected.skipPassTrigger.id, 'skip-pass trigger id')
    assertIds(skippedPassOutcome.encodedCommandIds, [], 'skipped pass encoded ids')
    assertOutcome(surfacePassOutcome.status === 'executed', 'surface pass must execute')
    assertIds(
        surfacePassOutcome.requestedCommandIds,
        [ expected.primaryDraw.id, expected.optionalDraw.id, expected.sampleDraw.id ],
        'surface requested ids'
    )
    assertIds(
        surfacePassOutcome.encodedCommandIds,
        [ expected.fallbackDraw.id, expected.sampleDraw.id ],
        'surface encoded ids'
    )
    assertOutcome(primaryOutcome.status === 'fallback-executed', 'primary must use fallback')
    assertOutcome(primaryOutcome.executedCommandId === expected.fallbackDraw.id, 'fallback executed id')
    assertOutcome(optionalOutcome.status === 'skipped-command', 'optional draw must skip')
    assertOutcome(optionalOutcome.executedCommandId === undefined, 'skipped command has no executed id')
}

function findBy(outcomes, key, value) {

    const outcome = outcomes.find(candidate => candidate[key] === value)
    assertOutcome(outcome !== undefined, `missing execution outcome for ${value}`)
    return outcome
}

function assertIds(actual, expected, label) {

    assertOutcome(
        actual.length === expected.length && actual.every((id, index) => id === expected[index]),
        `${label} mismatch`
    )
}

function assertOutcome(condition, message) {

    if (!condition) throw new Error(message)
}

function resizeSurface(surface, targetCanvas) {

    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(targetCanvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(targetCanvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}
