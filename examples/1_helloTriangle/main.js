import * as scr from 'geoscratch'

scr.StartDash().then(() => main(document.getElementById('GPUFrame')))

const main = function (canvas) {
    
    const screen = scr.screen({ canvas })

    const shaderCode = `
    const pos = array<vec2f, 3>(
        vec2f(-0.5, -0.5),
        vec2f(0.0, 0.5),
        vec2f(0.5, -0.5),
    );

    @vertex
    fn vMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    
        return vec4f(pos[vertexIndex], 0.0, 1.0);
    }
    
    @fragment
    fn fMain() -> @location(0) vec4f {
    
        return vec4f(128., 218., 197., 255.) / 255.;
    }
    `
    
    function init() {
    
        // Triangle Binding
        const tBinding = scr.binding({ 
            range: () => [ 3 ] // Draw 3 points of a triangle (1 instance as default)
        })
    
        // Triangle Pipeline
        const tPipeline = scr.renderPipeline({
            shader: {
                module: scr.shader({ codeFunc: () => shaderCode })
            },
        })
    
        // Triangle Pass
        const tPass = scr.renderPass({
            colorAttachments: [ { colorResource: screen } ]
        }).add(tPipeline, tBinding)
    
        // Stage
        scr.director.addStage({
            name: 'HelloTriangle',
            items: [ tPass ],
        })
    }
    
    function animate() {
    
        scr.director.tick()
        requestAnimationFrame(() => animate())
    }

    init()
    animate()
}
