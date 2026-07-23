import { ScratchRuntime } from 'geoscratch'
import type {
    ScratchRenderPipeline,
    SubmittedWork,
    Surface,
    SurfaceSize,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const initialSize = Object.freeze({ width: 64, height: 64 })
const sampleCount = 4

const renderWgsl = `
override colorMode: f32 = 0.0;

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f( 3.0, -1.0),
        vec2f(-1.0,  3.0)
    );
    return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fsMain(@builtin(position) position: vec4f) -> @location(1) vec4f {
    let detail = 0.04 * sin(position.x * 0.07) * cos(position.y * 0.06);
    if (colorMode < 0.5) {
        return vec4f(0.025 + detail, 0.04 + detail, 0.065 + detail, 1.0);
    }
    if (colorMode < 1.5) {
        return vec4f(0.08 + detail, 0.72 + detail, 0.62 + detail, 1.0);
    }
    return vec4f(0.94 + detail, 0.34 + detail, 0.22 + detail, 1.0);
}
`

void main().catch(reportFailure)

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'render pass features runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'render pass features surface',
        format: 'preferred',
        alphaMode: 'opaque',
        size: initialSize,
    })
    const multisampledColor = await runtime.createTexture({
        label: 'render pass features multisampled color',
        size: initialSize,
        sampleCount,
        format: surface.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const program = runtime.createProgram({
        label: 'render pass features program',
        modules: [ renderWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const backgroundPipeline = await createPipeline(
        runtime,
        program,
        surface,
        'render pass background pipeline',
        0
    )
    const leftPipeline = await createPipeline(
        runtime,
        program,
        surface,
        'render pass left pipeline',
        1
    )
    const rightPipeline = await createPipeline(
        runtime,
        program,
        surface,
        'render pass right pipeline',
        2
    )
    const pass = runtime.createRenderPass({
        label: 'render pass features sparse resolve pass',
        color: [
            null,
            {
                target: multisampledColor.view(),
                resolveTarget: surface,
                load: 'clear',
                store: 'discard',
                clear: [ 0.015, 0.02, 0.035, 1 ],
            },
        ],
        maxDrawCount: 3,
    })
    const fullDraw = runtime.createDrawCommand({
        label: 'render pass full attachment background',
        pipeline: backgroundPipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })

    const initialWork = runtime.submission()
        .render(pass, [ fullDraw ])
        .submit()
    await requireObservedSubmission(initialWork)
    canvas.dataset.initialExtent = `${surface.size.width}x${surface.size.height}`
    canvas.dataset.renderCount = '1'

    await renderCurrentSize()
    canvas.dataset.status = 'ready'
    window.addEventListener('resize', scheduleRender)

    let renderQueue = Promise.resolve()

    function scheduleRender() {

        canvas.dataset.status = 'loading'
        renderQueue = renderQueue
            .then(renderCurrentSize)
            .then(() => {
                canvas.dataset.status = 'ready'
            })
            .catch(reportFailure)
    }

    async function renderCurrentSize() {

        const size = canvasPixelSize(canvas)
        if (surface.size.width !== size.width || surface.size.height !== size.height) {
            surface.resize(size)
        }
        await multisampledColor.resize(size)

        const panels = panelRects(size)
        const leftDraw = runtime.createDrawCommand({
            label: 'render pass left panel',
            pipeline: leftPipeline,
            renderState: {
                viewport: panels.left,
                scissor: panels.left,
            },
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const rightDraw = runtime.createDrawCommand({
            label: 'render pass right panel',
            pipeline: rightPipeline,
            renderState: {
                viewport: panels.right,
                scissor: panels.right,
            },
            count: { vertexCount: 3 },
            resources: { read: [], write: [] },
            whenMissing: 'throw',
        })
        const submitted = runtime.submission()
            .render(pass, [ fullDraw, leftDraw, rightDraw ])
            .submit()
        await requireObservedSubmission(submitted)

        canvas.dataset.currentExtent = `${size.width}x${size.height}`
        canvas.dataset.renderCount = String(Number(canvas.dataset.renderCount ?? '0') + 1)
        canvas.dataset.multisampleResolve = 'true'
        canvas.dataset.sparseColorSlots = 'true'
        canvas.dataset.fullAttachmentResized = String(
            multisampledColor.allocationVersion > 1
        )
    }
}

async function createPipeline(
    runtime: ScratchRuntime,
    program: Parameters<ScratchRuntime['createRenderPipeline']>[0]['program'],
    surface: Surface,
    label: string,
    colorMode: number
): Promise<ScratchRenderPipeline> {

    return await runtime.createRenderPipeline({
        label,
        program,
        targets: [
            null,
            { format: surface.format },
        ],
        fragmentConstants: { colorMode },
        multisample: { count: sampleCount },
    })
}

function canvasPixelSize(target: HTMLCanvasElement): Readonly<SurfaceSize> {

    const scale = window.devicePixelRatio || 1
    return Object.freeze({
        width: Math.max(128, Math.floor(target.clientWidth * scale)),
        height: Math.max(96, Math.floor(target.clientHeight * scale)),
    })
}

function panelRects(size: Readonly<SurfaceSize>) {

    const gutter = Math.max(6, Math.floor(Math.min(size.width, size.height) * 0.06))
    const panelHeight = Math.max(1, size.height - gutter * 2)
    const availableWidth = Math.max(2, size.width - gutter * 3)
    const leftWidth = Math.max(1, Math.floor(availableWidth / 2))
    const rightX = gutter * 2 + leftWidth
    const rightWidth = Math.max(1, size.width - rightX - gutter)

    return Object.freeze({
        left: Object.freeze({
            x: gutter,
            y: gutter,
            width: leftWidth,
            height: panelHeight,
        }),
        right: Object.freeze({
            x: rightX,
            y: gutter,
            width: rightWidth,
            height: panelHeight,
        }),
    })
}

async function requireObservedSubmission(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([
        submitted.nativeOutcome,
        submitted.done,
    ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Submission native outcome was ${nativeOutcome.status}.`)
    }
}

function reportFailure(error: unknown) {

    canvas.dataset.status = 'error'
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    console.error(error)
}
