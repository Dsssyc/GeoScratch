import { throwGeoDiagnostic } from './diagnostics.js'

export type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumPatches: number
    maximumDemands: number
}>

/**
 * Validates immutable quality, source-ceiling, and capacity facts for one
 * camera-derived standard WebMercatorQuad cover.
 */
export function gpuWebMercatorQuadCoverPolicy(
    input: GpuWebMercatorQuadCoverPolicy
): GpuWebMercatorQuadCoverPolicy {

    if (!level(input?.minimumMatrixLevel) ||
        !level(input?.maximumMatrixLevel) ||
        !level(input?.sourceMaximumMatrixLevel) ||
        input.minimumMatrixLevel > input.sourceMaximumMatrixLevel ||
        input.sourceMaximumMatrixLevel > input.maximumMatrixLevel ||
        !positiveSafeInteger(input.maximumPatches) ||
        !positiveSafeInteger(input.maximumDemands)) {
        return throwGeoDiagnostic({
            code: 'GEO_WEB_MERCATOR_COVER_POLICY_INVALID',
            phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' },
            message: 'A WebMercatorQuad cover policy requires ordered levels and positive capacities.',
            expected: {
                levels: '0 <= minimum <= sourceMaximum <= maximum <= 24',
                capacities: 'positive safe integers',
            },
            actual: input,
        })
    }
    return Object.freeze({ ...input })
}

function level(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= 24
}

function positiveSafeInteger(value: number): boolean {

    return Number.isSafeInteger(value) && value > 0
}
