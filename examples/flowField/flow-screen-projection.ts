import { mat4 } from 'wgpu-matrix'
import type { GeoViewSnapshot, WebMercatorQuadAddressCodec } from 'geoscratch/geo'
import { flowRenderViewValues } from './flow-render-view.ts'

export type FlowScreenViewValues = Readonly<{
    relativeWorldFromClip: readonly number[]
    cameraX: readonly [number, number]
    cameraY: readonly [number, number]
    cameraZ: readonly [number, number]
}>

/** Inverts only the camera-relative transform; absolute XY remains a two-limb address. */
export function flowScreenViewValues(
    view: GeoViewSnapshot,
    addressCodec: WebMercatorQuadAddressCodec
): FlowScreenViewValues {
    const camera = flowRenderViewValues(view, addressCodec)
    const inverse = Array.from(mat4.inverse(Array.from(view.clipFromRelativeWorld), new Float64Array(16)))
    if (!inverse.every(Number.isFinite)) {
        throw new TypeError('Flow screen sampling requires an invertible camera-relative matrix')
    }
    return Object.freeze({
        relativeWorldFromClip: Object.freeze(inverse),
        cameraX: camera.cameraX,
        cameraY: camera.cameraY,
        cameraZ: camera.cameraZ,
    })
}

/** Shared example-local projection and wide-delta WGSL for a temporal sampler's address ABI. */
export function flowScreenProjectionWgsl(addressCodec: WebMercatorQuadAddressCodec): string {
    const bits = addressCodec?.coordinateBits
    if (!Number.isInteger(bits) || bits < 32 || bits > 52 ||
        !Number.isFinite(addressCodec.quantumMeters) || addressCodec.quantumMeters <= 0) {
        throw new TypeError('Flow screen projection requires a 32–52-bit WebMercator address codec')
    }
    const mask = 2 ** (bits - 32) - 1
    const worldMeters = Math.fround(addressCodec.quantumMeters * 2 ** bits)
    return `struct FlowScreenGroundPosition {
    position: FlowVelocityAddressFixedPosition,
    valid: u32,
}

// advance_meters in the standard address module accepts only an i32 quantum
// delta (about 19 m at 52 bits). Screen rays and amplified particle steps
// require the same canonical arithmetic with a two-limb delta instead.
fn FlowScreen_delta_axis(delta: f32) -> FlowVelocityAddressFixedAxis {
    let quanta = round(abs(delta) / FlowVelocityAddressFixed_quantum);
    let high = floor(quanta / 4294967296.0f);
    let low = quanta - high * 4294967296.0f;
    return FlowVelocityAddressFixedAxis(u32(low), u32(high));
}

fn FlowScreen_offset_axis(
    origin: FlowVelocityAddressFixedAxis,
    delta: f32,
) -> FlowVelocityAddressFixedAxis {
    let magnitude = FlowScreen_delta_axis(delta);
    if (delta < 0.0f) {
        return FlowVelocityAddressFixed_subtract_axis(origin, magnitude);
    }
    return FlowVelocityAddressFixed_add_axis(origin, magnitude);
}

// The caller supplies east-positive/south-positive canonical projected meters.
// Reject non-finite or more-than-one-world offsets before any integer cast.
fn FlowScreen_advance_meters(
    origin: FlowVelocityAddressFixedPosition,
    canonical_delta: vec2f,
) -> FlowVelocityAddressAdvance {
    if (!all(abs(canonical_delta) <= vec2f(${worldMeters}f))) {
        return FlowVelocityAddressAdvance(origin, 0u);
    }
    var position = FlowVelocityAddressFixedPosition(array<FlowVelocityAddressFixedAxis, 2>(
        FlowScreen_offset_axis(origin.axes[0], canonical_delta.x),
        FlowScreen_offset_axis(origin.axes[1], canonical_delta.y),
    ));
    position.axes[0].high &= ${mask}u;
    let valid = select(0u, 1u, position.axes[1].high <= ${mask}u);
    return FlowVelocityAddressAdvance(position, valid);
}

fn FlowScreen_ground_position(
    texcoords: vec2f,
    relative_world_from_clip: mat4x4f,
    camera_x: vec2u,
    camera_y: vec2u,
    camera_z: vec2f,
) -> FlowScreenGroundPosition {
    let camera = FlowVelocityAddressFixedPosition(array<FlowVelocityAddressFixedAxis, 2>(
        FlowVelocityAddressFixedAxis(camera_x.x, camera_x.y),
        FlowVelocityAddressFixedAxis(camera_y.x, camera_y.y),
    ));
    let ndc = vec2f(texcoords.x * 2.0f - 1.0f, 1.0f - texcoords.y * 2.0f);
    let near_h = relative_world_from_clip * vec4f(ndc, 0.0f, 1.0f);
    let far_h = relative_world_from_clip * vec4f(ndc, 1.0f, 1.0f);
    if (near_h.w == 0.0f || far_h.w == 0.0f) {
        return FlowScreenGroundPosition(camera, 0u);
    }
    let near_relative = near_h.xyz / near_h.w;
    let ray = far_h.xyz / far_h.w - near_relative;
    if (ray.z == 0.0f) {
        return FlowScreenGroundPosition(camera, 0u);
    }
    let ground_relative_z = -(camera_z.x + camera_z.y);
    let plane_t = (ground_relative_z - near_relative.z) / ray.z;
    if (!(plane_t >= 0.0f && plane_t <= 1.0f)) {
        return FlowScreenGroundPosition(camera, 0u);
    }
    let relative = near_relative.xy + ray.xy * plane_t;
    let advanced = FlowScreen_advance_meters(camera, vec2f(relative.x, -relative.y));
    return FlowScreenGroundPosition(advanced.position, advanced.north_south_valid);
}`
}
