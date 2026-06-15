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

void startResult
void device
void screen
void createdScreen
void mercator
void planeGeometry
void sphereGeometry
