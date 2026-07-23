import {
    ScratchRuntime,
} from 'geoscratch'
import type { SubmittedWork, Surface } from 'geoscratch'

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
canvas.dataset.status = 'loading'

const triangleWgsl = `
@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(0.0, 0.58),
        vec2f(-0.58, -0.48),
        vec2f(0.58, -0.48)
    );
    let p = positions[vertexIndex];
    return vec4f(p, 0.0, 1.0);
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(0.12, 0.72, 0.58, 1.0);
}
`

main().catch((error) => {
    canvas.dataset.status = 'error'
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'scratch hello triangle runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'scratch hello triangle surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const shaderModule = await runtime.createShaderModule({
        label: 'scratch hello triangle shader',
        sourceParts: [ { code: triangleWgsl } ],
    })
    const program = runtime.createProgram({
        label: 'scratch hello triangle program',
        vertex: { module: shaderModule, entryPoint: 'vsMain' },
        fragment: { module: shaderModule, entryPoint: 'fsMain' },
    })
    const pipeline = await runtime.createRenderPipeline({
        label: 'scratch hello triangle pipeline',
        program,
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        label: 'scratch hello triangle pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const draw = runtime.createDrawCommand({
        label: 'draw scratch hello triangle',
        pipeline,
        count: { vertexCount: 3 },
        resources: {
            read: [],
            write: [],
        },
        whenMissing: 'throw',
    })
    let firstFrameSettled = false

    function render() {

        resizeSurface(surface, canvas)
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit()
        if (!firstFrameSettled) {
            firstFrameSettled = true
            void requireObservedSubmission(submitted).then(() => {
                canvas.dataset.status = 'ready'
            }).catch((error) => {
                canvas.dataset.status = 'error'
                console.error(error)
            })
        }

        requestAnimationFrame(render)
    }

    render()
}

function resizeSurface(surface: Surface, canvas: HTMLCanvasElement) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
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
