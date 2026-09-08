import type { FlowTimelineSnapshot } from './flow-timeline.ts'
import type { FlowTemporalFrameSnapshot } from './flow-frame-provenance.ts'

export type FlowFieldViewMode = 'particles' | 'speed' | 'direction' | 'u' | 'v' | 'status'
export type FlowFieldSampleView = 'interpolated' | 'lower' | 'upper' | 'delta'
export type FlowFieldBoundaryMode = 'hard' | 'sdf' | 'sdf-center-linear' | 'sdf-center-smooth'

/** Source-texel feather bounds shared by UI validation and history presentation. */
export const FLOW_FIELD_SDF_FEATHER = Object.freeze({ minimum: 0.05, maximum: 0.35, default: 0.25 })

export type FlowFieldPresentation = Readonly<{
    view: FlowFieldViewMode
    sample: FlowFieldSampleView
    trails: boolean
    contour: boolean
    boundary: FlowFieldBoundaryMode
    sdfFeatherTexels: number
}>

/** Display defaults are applied at the input boundary; normalized choices are complete. */
export type FlowFieldPresentationInput = Readonly<
    Omit<FlowFieldPresentation, 'boundary' | 'sdfFeatherTexels'> & {
        boundary?: FlowFieldBoundaryMode
        sdfFeatherTexels?: number
    }
>

/** Example-owned presentation choices, with the frozen Flow Layer particle view as default. */
export const FLOW_FIELD_PRESENTATION: FlowFieldPresentation = Object.freeze({
    view: 'particles', sample: 'interpolated', trails: true, contour: false, boundary: 'hard',
    sdfFeatherTexels: FLOW_FIELD_SDF_FEATHER.default,
})

export type FlowFieldControlSnapshot = Readonly<{
    dataset: Readonly<{
        id: string
        minimumTime: number
        maximumTime: number
        timeUnit: string
        velocityUnit: string
        sampleCount: number
        maximumMatrix: string
    }>
    timeline: FlowTimelineSnapshot
    presented: FlowTemporalFrameSnapshot | undefined
    state: 'loading' | 'ready' | 'gap' | 'failed' | 'stopped'
    runtimeCount: number
    presentation: FlowFieldPresentation
}>

/** Validates a whole presentation choice before changing the active rendering graph. */
export function flowFieldPresentation(value: FlowFieldPresentationInput): FlowFieldPresentation {
    const boundary = value?.boundary === undefined ? 'hard' : value.boundary
    const sdfFeatherTexels = flowFieldSdfFeatherTexels(value?.sdfFeatherTexels === undefined
        ? FLOW_FIELD_SDF_FEATHER.default : value.sdfFeatherTexels)
    if (!['particles', 'speed', 'direction', 'u', 'v', 'status'].includes(value?.view) ||
        !['interpolated', 'lower', 'upper', 'delta'].includes(value?.sample) ||
        typeof value.trails !== 'boolean' || typeof value.contour !== 'boolean' ||
        !['hard', 'sdf', 'sdf-center-linear', 'sdf-center-smooth'].includes(boundary)) {
        throw new TypeError('Flow Field presentation is invalid')
    }
    return Object.freeze({ ...value, boundary, sdfFeatherTexels })
}

/** Validates a source-texel display width without changing or quantizing the caller's value. */
export function flowFieldSdfFeatherTexels(value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        value < FLOW_FIELD_SDF_FEATHER.minimum || value > FLOW_FIELD_SDF_FEATHER.maximum) {
        throw new TypeError('Flow Field SDF feather must be finite and within [0.05, 0.35] source texels')
    }
    return value
}
