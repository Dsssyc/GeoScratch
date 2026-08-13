import { throwGeoDiagnostic } from './diagnostics.js'

export type CoordinateDimension = 1 | 2 | 3

export type CoordinateAxis = Readonly<{
    name: string
    unit: string
}>

export type AuxiliaryAxis = Readonly<{
    name: string
    unit: string
}>

export type CoordinateDomain = Readonly<{
    kind: 'coordinate-domain'
    id: string
    intrinsicDimensions: CoordinateDimension
    embeddingDimensions: CoordinateDimension
    axes: readonly CoordinateAxis[]
    embeddingAxes: readonly CoordinateAxis[]
    auxiliaryAxes: readonly AuxiliaryAxis[]
}>

export type CoordinateDomainDescriptor = Readonly<{
    id: string
    intrinsicDimensions: CoordinateDimension
    embeddingDimensions: CoordinateDimension
    axes: readonly CoordinateAxis[]
    embeddingAxes?: readonly CoordinateAxis[]
    auxiliaryAxes?: readonly AuxiliaryAxis[]
}>

export type SurfaceDomainDescriptor = Readonly<{
    id: string
    axes: readonly [CoordinateAxis, CoordinateAxis]
    embeddingAxes: readonly [CoordinateAxis, CoordinateAxis, CoordinateAxis]
    auxiliaryAxes?: readonly AuxiliaryAxis[]
}>

export type LocalVector = Readonly<{
    kind: 'local-vector'
    domainId: string
    dimensions: CoordinateDimension
    values: readonly number[]
    unit: string
    basis: string
}>

export type LocalVectorOptions = Readonly<{
    unit: string
    basis: string
}>

/** Validates and freezes a coordinate domain independently from storage or projection policy. */
export function coordinateDomain(descriptor: CoordinateDomainDescriptor): CoordinateDomain {

    if (!isDimension(descriptor.intrinsicDimensions) ||
        !isDimension(descriptor.embeddingDimensions) ||
        !Array.isArray(descriptor.axes) ||
        descriptor.axes.length !== descriptor.intrinsicDimensions ||
        (descriptor.embeddingAxes !== undefined &&
            descriptor.embeddingAxes.length !== descriptor.embeddingDimensions)) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
            phase: 'coordinate',
            subject: { kind: 'coordinate-domain', id: descriptor.id },
            message: 'Coordinate axis counts must match intrinsic and embedding dimensions.',
            expected: {
                intrinsicAxes: descriptor.intrinsicDimensions,
                embeddingAxes: descriptor.embeddingDimensions,
            },
            actual: {
                intrinsicAxes: Array.isArray(descriptor.axes) ? descriptor.axes.length : undefined,
                embeddingAxes: descriptor.embeddingAxes?.length,
            },
        })
    }
    if (typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_INVALID_DOMAIN',
            phase: 'coordinate',
            subject: { kind: 'coordinate-domain' },
            message: 'Coordinate domains require a non-empty stable id.',
            expected: { id: 'non-empty string' },
            actual: { id: descriptor.id },
        })
    }

    const axes = freezeAxes(descriptor.axes, descriptor.id, 'intrinsic')
    const embeddingAxes = descriptor.embeddingAxes === undefined
        ? defaultEmbeddingAxes(descriptor.embeddingDimensions)
        : freezeAxes(descriptor.embeddingAxes, descriptor.id, 'embedding')
    const auxiliaryAxes = freezeAxes(descriptor.auxiliaryAxes ?? [], descriptor.id, 'auxiliary')

    return Object.freeze({
        kind: 'coordinate-domain',
        id: descriptor.id,
        intrinsicDimensions: descriptor.intrinsicDimensions,
        embeddingDimensions: descriptor.embeddingDimensions,
        axes,
        embeddingAxes,
        auxiliaryAxes,
    })
}

/** Creates a two-dimensional surface domain embedded in three-dimensional space. */
export function surfaceDomain(descriptor: SurfaceDomainDescriptor): CoordinateDomain {

    return coordinateDomain({
        id: descriptor.id,
        intrinsicDimensions: 2,
        embeddingDimensions: 3,
        axes: descriptor.axes,
        embeddingAxes: descriptor.embeddingAxes,
        auxiliaryAxes: descriptor.auxiliaryAxes ?? [],
    })
}

/** Creates a translation-invariant vector with explicit unit and basis in one domain. */
export function localVector(
    domain: CoordinateDomain,
    values: readonly number[],
    options: LocalVectorOptions
): LocalVector {

    if (values.length !== domain.intrinsicDimensions ||
        values.some(value => !Number.isFinite(value))) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
            phase: 'coordinate',
            subject: { kind: 'local-vector', id: domain.id },
            message: 'Local vector values must match the coordinate-domain dimension.',
            expected: { dimensions: domain.intrinsicDimensions },
            actual: { dimensions: values.length },
        })
    }
    return Object.freeze({
        kind: 'local-vector',
        domainId: domain.id,
        dimensions: domain.intrinsicDimensions,
        values: Object.freeze(values.map(value => Number(value))),
        unit: options.unit,
        basis: options.basis,
    })
}

function isDimension(value: unknown): value is CoordinateDimension {

    return value === 1 || value === 2 || value === 3
}

function freezeAxes(
    axes: readonly CoordinateAxis[],
    domainId: string,
    role: string
): readonly CoordinateAxis[] {

    const names = new Set<string>()
    const result = axes.map((axis, index) => {
        if (typeof axis?.name !== 'string' || axis.name.length === 0 ||
            typeof axis.unit !== 'string' || axis.unit.length === 0 ||
            names.has(axis.name)) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_INVALID_DOMAIN',
                phase: 'coordinate',
                subject: { kind: 'coordinate-domain', id: domainId },
                message: 'Coordinate axes require unique non-empty names and units.',
                expected: { role, axis: index, name: 'unique string', unit: 'non-empty string' },
                actual: axis,
            })
        }
        names.add(axis.name)
        return Object.freeze({ name: axis.name, unit: axis.unit })
    })
    return Object.freeze(result)
}

function defaultEmbeddingAxes(dimensions: CoordinateDimension): readonly CoordinateAxis[] {

    return Object.freeze(Array.from({ length: dimensions }, (_, index) =>
        Object.freeze({ name: `embedding-${index}`, unit: 'unknown' }),
    ))
}
