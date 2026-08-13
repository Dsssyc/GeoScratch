import { throwGeoDiagnostic } from './diagnostics.js'

export type GeoViewSnapshotDescriptor = Readonly<{
    id: string
    clipFromRelativeWorld: ArrayLike<number>
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    viewport: readonly [number, number]
    verticalFovRadians: number
    cameraLatitudeRadians: number
    cameraPitchRadians: number
    zoomHint: number
    frameEpoch: number
    residencySnapshotEpoch: number
}>

export type GeoViewSnapshot = Readonly<{
    kind: 'geo-view-snapshot'
    id: string
    clipFromRelativeWorld: readonly number[]
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    viewport: readonly [number, number]
    verticalFovRadians: number
    cameraLatitudeRadians: number
    cameraPitchRadians: number
    zoomHint: number
    frameEpoch: number
    residencySnapshotEpoch: number
}>

export type GeoViewReadContext = Readonly<{
    frameEpoch: number
    residencySnapshotEpoch: number
}>

export type GeoViewAdapterDescriptor<Input> = Readonly<{
    id: string
    read(input: Input, context: GeoViewReadContext): GeoViewSnapshot
}>

export type GeoViewAdapter<Input = unknown> = Readonly<{
    kind: 'geo-view-adapter'
    id: string
    read(input: Input, context: GeoViewReadContext): GeoViewSnapshot
}>

const U32_MAX = 0xffff_ffff
const geoViewSnapshots = new WeakSet<object>()

/** Freezes one revisioned camera and viewport observation in a relative-world frame. */
export function createGeoViewSnapshot(
    descriptor: GeoViewSnapshotDescriptor
): GeoViewSnapshot {

    const matrix = descriptor?.clipFromRelativeWorld === undefined
        ? []
        : Array.from(descriptor.clipFromRelativeWorld)
    const cameraHigh = descriptor?.cameraHigh === undefined
        ? []
        : Array.from(descriptor.cameraHigh)
    const cameraLow = descriptor?.cameraLow === undefined
        ? []
        : Array.from(descriptor.cameraLow)
    const viewport = descriptor?.viewport === undefined
        ? []
        : Array.from(descriptor.viewport)
    const values = [
        ...matrix,
        ...cameraHigh,
        ...cameraLow,
        ...viewport,
        descriptor?.verticalFovRadians,
        descriptor?.cameraLatitudeRadians,
        descriptor?.cameraPitchRadians,
        descriptor?.zoomHint,
        descriptor?.frameEpoch,
        descriptor?.residencySnapshotEpoch,
    ]
    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        matrix.length !== 16 || cameraHigh.length !== 3 || cameraLow.length !== 3 ||
        viewport.length !== 2 || values.some(value => !Number.isFinite(value)) ||
        viewport.some(value => value <= 0) ||
        descriptor.verticalFovRadians <= 0 || descriptor.verticalFovRadians >= Math.PI ||
        Math.abs(descriptor.cameraLatitudeRadians) > Math.PI / 2 ||
        descriptor.cameraPitchRadians < 0 || descriptor.cameraPitchRadians > Math.PI / 2 ||
        !u32(descriptor.frameEpoch) || !u32(descriptor.residencySnapshotEpoch)) {
        return invalidView(
            'A Geo view snapshot requires finite camera, matrix, viewport, and epoch facts.',
            {
                id: 'non-empty string',
                matrixLength: 16,
                cameraLength: 3,
                viewport: 'positive finite pair',
                verticalFovRadians: '(0, PI)',
                cameraLatitudeRadians: '[-PI/2, PI/2]',
                cameraPitchRadians: '[0, PI/2]',
                epochs: 'u32',
            },
            descriptor
        )
    }
    const snapshot = Object.freeze({
        kind: 'geo-view-snapshot' as const,
        id: descriptor.id,
        clipFromRelativeWorld: Object.freeze(matrix),
        cameraHigh: Object.freeze(cameraHigh) as unknown as readonly [number, number, number],
        cameraLow: Object.freeze(cameraLow) as unknown as readonly [number, number, number],
        viewport: Object.freeze(viewport) as unknown as readonly [number, number],
        verticalFovRadians: descriptor.verticalFovRadians,
        cameraLatitudeRadians: descriptor.cameraLatitudeRadians,
        cameraPitchRadians: descriptor.cameraPitchRadians,
        zoomHint: descriptor.zoomHint,
        frameEpoch: descriptor.frameEpoch,
        residencySnapshotEpoch: descriptor.residencySnapshotEpoch,
    })
    geoViewSnapshots.add(snapshot)
    return snapshot
}

/** Wraps an external camera reader as a stable Geo view-snapshot producer. */
export function createGeoViewAdapter<Input>(
    descriptor: GeoViewAdapterDescriptor<Input>
): GeoViewAdapter<Input> {

    if (typeof descriptor?.id !== 'string' || descriptor.id.length === 0 ||
        typeof descriptor.read !== 'function') {
        return invalidView(
            'A Geo view adapter requires an id and one read function.',
            { id: 'non-empty string', read: 'function' },
            descriptor
        )
    }
    const read = descriptor.read
    return Object.freeze({
        kind: 'geo-view-adapter' as const,
        id: descriptor.id,
        read(input: Input, context: GeoViewReadContext) {

            if (!u32(context?.frameEpoch) || !u32(context?.residencySnapshotEpoch)) {
                return invalidView(
                    'A Geo view adapter read requires explicit frame and residency provenance.',
                    { frameEpoch: 'u32', residencySnapshotEpoch: 'u32' },
                    context
                )
            }
            const immutableContext = Object.freeze({
                frameEpoch: context.frameEpoch,
                residencySnapshotEpoch: context.residencySnapshotEpoch,
            })
            const snapshot = read(input, immutableContext)
            if (!geoViewSnapshots.has(snapshot) ||
                snapshot.frameEpoch !== immutableContext.frameEpoch ||
                snapshot.residencySnapshotEpoch !== immutableContext.residencySnapshotEpoch) {
                return invalidView(
                    'A Geo view adapter must return a library snapshot with the supplied provenance.',
                    {
                        kind: 'geo-view-snapshot',
                        frameEpoch: immutableContext.frameEpoch,
                        residencySnapshotEpoch: immutableContext.residencySnapshotEpoch,
                    },
                    snapshot
                )
            }
            return snapshot
        },
    })
}

function u32(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= U32_MAX
}

function invalidView(message: string, expected: unknown, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIEW_INVALID',
        phase: 'selection',
        subject: { kind: 'geo-view' },
        message,
        expected,
        actual,
    })
}
