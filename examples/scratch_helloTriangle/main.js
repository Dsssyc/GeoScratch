import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')

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
    const program = runtime.createProgram({
        label: 'scratch hello triangle program',
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
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
        whenMissing: 'throw',
    })

    function render() {

        resizeSurface(surface, canvas)
        runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit()

        requestAnimationFrame(render)
    }

    render()
}

function resizeSurface(surface, canvas) {

    const devicePixelRatio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio))

    if (surface.size.width !== width || surface.size.height !== height) {
        surface.resize({ width, height })
    }
}
