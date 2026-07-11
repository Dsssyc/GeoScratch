import {
    ScratchRuntime,
} from 'geoscratch'

const canvas = document.getElementById('GPUFrame')

const uniformTriangleWgsl = `
struct TriangleUniforms {
    color: vec4f,
};

@group(0) @binding(0)
var<uniform> uniforms: TriangleUniforms;

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
    return uniforms.color;
}
`

void main().catch((error) => {
    console.error(error)
})

async function main() {

    const runtime = await ScratchRuntime.create({
        label: 'scratch uniform triangle runtime',
    })
    const surface = runtime.createSurface(canvas, {
        label: 'scratch uniform triangle surface',
        format: 'preferred',
        alphaMode: 'opaque',
    })
    const uniformBuffer = await runtime.createBuffer({
        label: 'scratch uniform triangle color',
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    const bindLayout = runtime.createBindLayout({
        label: 'scratch uniform triangle layout',
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
    const bindSet = runtime.createBindSet(bindLayout, {
        uniforms: uniformBuffer,
    }, {
        label: 'scratch uniform triangle bindings',
    })
    const program = runtime.createProgram({
        label: 'scratch uniform triangle program',
        modules: [ uniformTriangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = runtime.createRenderPipeline({
        label: 'scratch uniform triangle pipeline',
        program,
        bindLayouts: [ bindLayout ],
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        label: 'scratch uniform triangle pass',
        color: [
            {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0.03, 0.05, 0.08, 1 ],
            },
        ],
    })
    const upload = runtime.createUploadCommand({
        label: 'upload scratch uniform triangle color',
        target: uniformBuffer,
        data: new Float32Array([ 0.86, 0.28, 0.12, 1 ]),
        offset: 0,
    })
    const draw = runtime.createDrawCommand({
        label: 'draw scratch uniform triangle',
        pipeline,
        bindSets: [ bindSet ],
        count: { vertexCount: 3 },
        resources: {
            read: [
                { resource: uniformBuffer, contentEpoch: 1 },
            ],
            write: [],
        },
        whenMissing: 'throw',
    })

    let needsUpload = true

    function render() {

        resizeSurface(surface, canvas)

        const submission = runtime.createSubmission({ validation: 'throw' })
        if (needsUpload) {
            submission.upload(upload)
            needsUpload = false
        }

        const submitted = submission
            .render(pass, [ draw ])
            .submit()
        void submitted.done

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
