import type { FlowTimelineSnapshot } from './flow-timeline.ts'
import type { FlowTemporalFrameSnapshot } from './flow-frame-provenance.ts'

export type FlowFieldViewMode = 'particles' | 'speed' | 'direction' | 'u' | 'v' | 'status'
export type FlowFieldSampleView = 'interpolated' | 'lower' | 'upper' | 'delta'
export type FlowFieldBoundaryMode = 'hard' | 'sdf'

export type FlowFieldPresentation = Readonly<{
    view: FlowFieldViewMode
    sample: FlowFieldSampleView
    trails: boolean
    contour: boolean
    boundary: FlowFieldBoundaryMode
}>

/** Boundary defaults at the input boundary; normalized renderer choices are complete. */
export type FlowFieldPresentationInput = Readonly<
    Omit<FlowFieldPresentation, 'boundary'> & { boundary?: FlowFieldBoundaryMode }
>

/** Example-owned presentation choices, with the frozen Flow Layer particle view as default. */
export const FLOW_FIELD_PRESENTATION: FlowFieldPresentation = Object.freeze({
    view: 'particles', sample: 'interpolated', trails: true, contour: false, boundary: 'hard',
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
    if (!['particles', 'speed', 'direction', 'u', 'v', 'status'].includes(value?.view) ||
        !['interpolated', 'lower', 'upper', 'delta'].includes(value?.sample) ||
        typeof value.trails !== 'boolean' || typeof value.contour !== 'boolean' ||
        !['hard', 'sdf'].includes(boundary)) {
        throw new TypeError('Flow Field presentation is invalid')
    }
    return Object.freeze({ ...value, boundary })
}
