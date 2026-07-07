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
    const scratchPipeline: scr.ScratchRenderPipeline = runtime.createRenderPipeline({
        label: 'typed scratch pipeline',
        program,
        targets: [ { format: surface.format } ],
    })
    const draw: scr.DrawCommand = runtime.createDrawCommand({
        pipeline: scratchPipeline,
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
    })
    const builder: scr.SubmissionBuilder = runtime.createSubmission({ validation: 'throw' })
    const submitted: scr.SubmittedWork = builder.render(passSpec, [ draw ]).submit()

    void surface
    void error
    void submitted
}

void startResult
void device
void screen
void createdScreen
void mercator
void planeGeometry
void sphereGeometry
void useScratchFoundation
