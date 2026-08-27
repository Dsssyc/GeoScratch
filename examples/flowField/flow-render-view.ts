import { layoutCodec } from 'geoscratch/scratch'
import type {
    BindLayout,
    BindSet,
    BufferResource,
    GPURuntime,
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    SubmissionBuilder,
    UploadCommand,
} from 'geoscratch/scratch'
import type {
    GeoViewSnapshot,
    WebMercatorQuadAddressCodec,
} from 'geoscratch/geo'

export const FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH = 112

export type FlowRenderViewValues = Readonly<{
    clipFromRelativeWorld: readonly number[]
    cameraX: readonly [number, number]
    cameraY: readonly [number, number]
    cameraZ: readonly [number, number]
    metersPerQuantum: number
    reserved: readonly [number, number, number]
}>

export type FlowRenderViewBinding = Readonly<{
    bindLayout: BindLayout
    bindSet: BindSet
    resources: readonly [BufferResource]
}>

export type FlowRenderView = FlowRenderViewBinding & Readonly<{
    encode(builder: SubmissionBuilder, view: GeoViewSnapshot): void
    dispose(): void
}>

export type FlowRenderViewOptions = Readonly<{
    runtime: GPURuntime
    addressCodec: WebMercatorQuadAddressCodec
}>

/** Converts one authoritative Geo snapshot into camera-relative wide-fixed draw facts. */
export function flowRenderViewValues(
    view: GeoViewSnapshot,
    addressCodec: WebMercatorQuadAddressCodec
): FlowRenderViewValues {

    if (view?.kind !== 'geo-view-snapshot' || view.clipFromRelativeWorld.length !== 16 ||
        !Array.from(view.clipFromRelativeWorld).every(Number.isFinite) ||
        !Array.from(view.cameraHigh).every(Number.isFinite) ||
        !Array.from(view.cameraLow).every(Number.isFinite) ||
        typeof addressCodec?.fromProjected !== 'function' ||
        !Number.isFinite(addressCodec.quantumMeters) || addressCodec.quantumMeters <= 0) {
        throw new TypeError('Flow render view requires one finite Geo snapshot and address codec')
    }
    const camera = addressCodec.fromProjected([
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
    ])
    const [ x, y ] = camera.fixed.limbs
    return Object.freeze({
        clipFromRelativeWorld: Object.freeze([ ...view.clipFromRelativeWorld ]),
        cameraX: Object.freeze([ x!.low, x!.high ]) as readonly [number, number],
        cameraY: Object.freeze([ y!.low, y!.high ]) as readonly [number, number],
        cameraZ: Object.freeze([
            view.cameraHigh[2], view.cameraLow[2],
        ]) as readonly [number, number],
        metersPerQuantum: addressCodec.quantumMeters,
        reserved: Object.freeze([ 0, 0, 0 ]) as readonly [number, number, number],
    })
}

/** Creates the shared group-1 camera uniform consumed by contour and particle draws. */
export async function createFlowRenderView(options: FlowRenderViewOptions): Promise<FlowRenderView> {

    const runtime = options?.runtime
    if (runtime === undefined || typeof runtime.createBuffer !== 'function') {
        throw new TypeError('Flow render view requires a public GPURuntime')
    }
    const codec = renderViewCodec()
    if (codec.byteLength() !== FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH) {
        throw new Error('Flow render view uniform ABI is inconsistent')
    }
    const initial = flowRenderViewValues({
        kind: 'geo-view-snapshot',
        id: 'flow-render-view-initial',
        clipFromRelativeWorld: [
            1, 0, 0, 0, 0, 1, 0, 0,
            0, 0, 1, 0, 0, 0, 0, 1,
        ],
        cameraHigh: [ 0, 0, 0 ],
        cameraLow: [ 0, 0, 0 ],
        referenceViewport: [ 1, 1 ],
        verticalFovRadians: 1,
        cameraLatitudeRadians: 0,
        cameraPitchRadians: 0,
        zoomHint: 0,
        frameEpoch: 0,
        residencySnapshotEpoch: 0,
    }, options.addressCodec)
    const bytes = codec.pack(initial)
    const buffer = await runtime.createBuffer({
        label: 'Flow Field shared render view uniform',
        size: FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH,
        usage: 0x08 | 0x40,
    })
    const region = buffer.region({ layout: codec.artifact })
    const upload: UploadCommand = runtime.createUploadCommand({
        label: 'Upload Flow Field shared render view',
        target: region,
        data: bytes,
    })
    const bindLayout = await runtime.createBindLayout({
        label: 'Flow Field shared render view layout',
        group: 1,
        entries: [ {
            binding: 0,
            name: 'contourView',
            type: 'uniform',
            visibility: [ 'vertex' ],
            minBindingSize: FLOW_RENDER_VIEW_UNIFORM_BYTE_LENGTH,
        } ],
    })
    const bindSet = await runtime.createBindSet(bindLayout, {
        contourView: region,
    }, { label: 'Flow Field shared render view binding' })
    const resources = Object.freeze([ buffer ]) as readonly [BufferResource]
    let disposed = false

    function encode(builder: SubmissionBuilder, view: GeoViewSnapshot): void {

        if (disposed) throw new Error('Flow render view is disposed')
        if (builder?.runtime !== runtime) {
            throw new TypeError('Flow render view requires a same-runtime SubmissionBuilder')
        }
        codec.write(bytes, flowRenderViewValues(view, options.addressCodec))
        builder.upload(upload)
    }

    function dispose(): void {

        if (disposed) return
        disposed = true
        upload.dispose()
        bindSet.dispose()
        bindLayout.dispose()
        buffer.dispose()
    }

    return Object.freeze({ bindLayout, bindSet, resources, encode, dispose })
}

function renderViewCodec(): LayoutCodec {

    const fields: LayoutFixedFieldDescriptor[] = [
        { name: 'clipFromRelativeWorld', type: 'mat4x4f' },
        { name: 'cameraX', type: 'vec2u' },
        { name: 'cameraY', type: 'vec2u' },
        { name: 'cameraZ', type: 'vec2f' },
        { name: 'metersPerQuantum', type: 'f32' },
        { name: 'reserved', type: 'vec3f' },
    ]
    return layoutCodec({ name: 'FlowContourViewUniform', fields }, { usage: [ 'uniform' ] })
}
