import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { getGlobalConstant } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type SurfaceSize = {
    width: number
    height: number
}

export type SurfaceFormat = GPUTextureFormat | 'preferred'

export type SurfaceOptions = {
    label?: string
    format?: SurfaceFormat
    usage?: GPUTextureUsageFlags
    viewFormats?: Iterable<GPUTextureFormat>
    colorSpace?: PredefinedColorSpace
    toneMapping?: GPUCanvasToneMapping
    alphaMode?: GPUCanvasAlphaMode
    size?: SurfaceSize
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas

type SurfaceToneMapping = Readonly<{
    mode: GPUCanvasToneMappingMode
}>

type SurfaceConfigurationSnapshot = Readonly<{
    device: GPUDevice
    format: GPUTextureFormat
    usage: GPUTextureUsageFlags
    viewFormats: readonly GPUTextureFormat[]
    colorSpace: PredefinedColorSpace
    toneMapping?: SurfaceToneMapping
    alphaMode: GPUCanvasAlphaMode
}>

type SurfaceOptionsSnapshot = Readonly<{
    format: unknown
    usage: unknown
    viewFormats: unknown
    colorSpace: unknown
    toneMapping: unknown
    alphaMode: unknown
    size: unknown
}>

type SurfaceState = {
    runtime: ScratchRuntime
    id: string
    canvas: ScratchCanvas
    context: GPUCanvasContext
    configuration: SurfaceConfigurationSnapshot
    configurationVersion: number
    size: Readonly<SurfaceSize>
    isConfigured: boolean
    isDisposed: boolean
}

export type SurfaceFacts = Readonly<{
    runtime: ScratchRuntime
    id: string
    context: GPUCanvasContext
    subject: DiagnosticSubject
    format: GPUTextureFormat
    usage: GPUTextureUsageFlags
    viewFormats: readonly GPUTextureFormat[]
    colorSpace: PredefinedColorSpace
    toneMapping?: SurfaceToneMapping
    alphaMode: GPUCanvasAlphaMode
    size: Readonly<SurfaceSize>
}>

export type PreparedSurfaceAttachment = Readonly<{
    surface: Surface
}>

export type PreparedSurfaceAttachmentFacts = Readonly<{
    surfaceId: string
    format: GPUTextureFormat
    configurationVersion: number
}>

type PreparedSurfaceAttachmentState = Readonly<{
    surface: Surface
    state: SurfaceState
    format: GPUTextureFormat
    configurationVersion: number
}>

const TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const GPU_FLAGS_MAX = 0xffff_ffff
const COLOR_SPACES = new Set<PredefinedColorSpace>([ 'srgb', 'display-p3' ])
const TONE_MAPPING_MODES = new Set<GPUCanvasToneMappingMode>([ 'standard', 'extended' ])
const ALPHA_MODES = new Set<GPUCanvasAlphaMode>([ 'opaque', 'premultiplied' ])
const surfaceContextOwners = new WeakMap<GPUCanvasContext, Surface>()
const surfaceStates = new WeakMap<Surface, SurfaceState>()
const preparedSurfaceAttachments = new WeakMap<PreparedSurfaceAttachment, PreparedSurfaceAttachmentState>()

export interface Surface {
    readonly runtime: ScratchRuntime
    readonly id: string
    label?: string
    readonly canvas: ScratchCanvas
    readonly context: GPUCanvasContext
    readonly format: GPUTextureFormat
    readonly usage: GPUTextureUsageFlags
    readonly viewFormats: readonly GPUTextureFormat[]
    readonly colorSpace: PredefinedColorSpace
    readonly toneMapping?: Readonly<GPUCanvasToneMapping>
    readonly alphaMode: GPUCanvasAlphaMode
    readonly size: Readonly<SurfaceSize>
    readonly isConfigured: boolean
    readonly isDisposed: boolean
}

export class Surface {

    constructor(runtime: ScratchRuntime, canvas: ScratchCanvas, options: SurfaceOptions = {}) {

        runtime.assertActive()

        const id = `scratch-surface-${UUID()}`
        const subject = surfaceSubjectFromValues(id, options.label)
        const context = createCanvasContext(subject, canvas)
        const state: SurfaceState = {
            runtime,
            id,
            canvas,
            context,
            configuration: Object.freeze({
                device: runtime.device,
                format: resolveSurfaceFormat(runtime, 'preferred'),
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
                viewFormats: Object.freeze([]) as readonly GPUTextureFormat[],
                colorSpace: 'srgb',
                alphaMode: 'opaque',
            }),
            configurationVersion: 0,
            size: freezeSurfaceSize(normalizeSurfaceSize(undefined, canvas)),
            isConfigured: false,
            isDisposed: false,
        }
        surfaceStates.set(this, state)
        Object.defineProperty(this, 'label', {
            value: options.label,
            writable: true,
            enumerable: true,
            configurable: false,
        })
        installSurfaceObservations(this)

        claimSurfaceContext(this, state)
        try {
            this.configure(options)
            runtime._registerSurface(this)
            Object.preventExtensions(this)
        } catch (error) {
            releaseSurfaceContext(this, state)
            throw error
        }
    }

    get subject(): DiagnosticSubject {

        return surfaceSubject(this, surfaceStates.get(this))
    }

    assertUsable(): void {

        assertSurfaceUsable(this)
    }

    configure(options: SurfaceOptions = {}): void {

        const state = assertSurfaceAliveOwner(this)
        state.runtime.assertActive()

        const previousConfiguration = state.configuration
        const previousConfigurationVersion = state.configurationVersion
        const previousSize = state.size
        const previousConfigured = state.isConfigured
        const previousCanvasSize = currentCanvasSize(state.canvas)
        const input = snapshotSurfaceOptions(options)
        const candidate = normalizeSurfaceConfigurationCandidate(
            this,
            state,
            previousConfiguration,
            input
        )
        const candidateSize = input.size === undefined
            ? previousSize
            : normalizeRequestedSurfaceSize(this, state, input.size)
        const descriptor = nativeSurfaceConfiguration(candidate)
        assertSurfaceConfigurationCandidateCurrent(this, state, previousConfigurationVersion)

        let configureIssued = false
        try {
            applyCanvasSize(state.canvas, candidateSize)
            configureIssued = true
            state.context.configure(descriptor)
        } catch (cause) {
            const canvasRestored = restoreCanvasSize(state.canvas, previousCanvasSize)
            throwSurfaceConfigurationFailed(this, state, cause, {
                reason: configureIssued ? 'native-configure-threw' : 'canvas-resize-threw',
                nativeErrorName: errorName(cause),
                canvasRestored,
                nativeRollbackRequired: false,
            })
        }

        let observed: SurfaceConfigurationSnapshot
        try {
            observed = captureCurrentSurfaceConfiguration(state.context)
            assertSurfaceConfigurationAccepted(candidate, observed)
            assertSurfaceSizeAccepted(state.canvas, candidateSize)
        } catch (cause) {
            const rollback = rollbackSurfaceConfiguration(
                state,
                previousConfiguration,
                previousCanvasSize,
                previousConfigured
            )
            throwSurfaceConfigurationFailed(this, state, cause, {
                reason: 'native-configuration-observation-failed',
                nativeErrorName: errorName(cause),
                canvasRestored: rollback.canvasRestored,
                nativeConfigurationRestored: rollback.nativeConfigurationRestored,
                nativeRollbackRequired: true,
            })
        }

        state.configuration = observed
        state.configurationVersion++
        state.size = candidateSize
        state.isConfigured = true
    }

    resize(sizeOrWidth: SurfaceSize | number, height?: number): void {

        const size = (typeof sizeOrWidth === 'number'
            ? { width: sizeOrWidth, height }
            : sizeOrWidth) as SurfaceSize

        this.configure({ size })
    }

    getCurrentTexture(): GPUTexture {

        const state = assertSurfaceUsable(this)
        return state.context.getCurrentTexture()
    }

    dispose(): void {

        const currentState = surfaceStates.get(this)
        if (currentState?.isDisposed) return
        const state = assertSurfaceContextOwner(this)

        state.isDisposed = true
        state.isConfigured = false
        let unconfigureCause: unknown
        let unregisterCause: unknown
        try {
            state.context.unconfigure()
        } catch (cause) {
            unconfigureCause = cause
        }
        try {
            state.runtime._unregisterSurface(this)
        } catch (cause) {
            unregisterCause = cause
        } finally {
            releaseSurfaceContext(this, state)
        }

        if (unconfigureCause !== undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
                severity: 'error',
                phase: 'runtime',
                subject: surfaceSubject(this, state),
                related: [ state.runtime.subject ],
                message: 'Surface canvas context unconfigure failed during disposal.',
                expected: { lifecycle: 'logical disposal completes even if native unconfigure fails' },
                actual: {
                    reason: 'native-unconfigure-threw',
                    nativeErrorName: errorName(unconfigureCause),
                    isDisposed: true,
                    contextClaimReleased: true,
                },
            }, { cause: unconfigureCause })
        }
        if (unregisterCause !== undefined) throw unregisterCause
    }
}

export function isSurfaceReceiver(value: unknown): value is Surface {

    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
    const surface = value as Surface
    return surfaceStates.has(surface) || inheritedSurfaceState(surface) !== undefined
}

export function surfaceFactsFor(surface: Surface): SurfaceFacts {

    const state = assertSurfaceUsable(surface)
    return snapshotSurfaceFacts(surface, state)
}

export function prepareSurfaceAttachment(surface: Surface): PreparedSurfaceAttachment {

    const state = assertSurfaceUsable(surface)
    const prepared = Object.freeze({ surface })
    preparedSurfaceAttachments.set(prepared, Object.freeze({
        surface,
        state,
        format: state.configuration.format,
        configurationVersion: state.configurationVersion,
    }))
    return prepared
}

export function createPreparedSurfaceAttachmentView(
    prepared: PreparedSurfaceAttachment,
    descriptor?: GPUTextureViewDescriptor
): GPUTextureView {

    const preparedState = preparedSurfaceAttachments.get(prepared)
    if (preparedState === undefined) {
        throw new TypeError('Surface attachment preparation is not owned by Scratch.')
    }
    const { surface, state, configurationVersion } = preparedState
    const currentState = assertSurfaceAliveOwner(surface)
    if (currentState !== state || state.configurationVersion !== configurationVersion || !state.isConfigured) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
            severity: 'error',
            phase: 'runtime',
            subject: surfaceSubject(surface, state),
            related: [ state.runtime.subject ],
            message: 'Prepared Surface attachment no longer matches the committed configuration.',
            expected: { configurationVersion },
            actual: { configurationVersion: state.configurationVersion, isConfigured: state.isConfigured },
        })
    }

    return state.context.getCurrentTexture().createView(descriptor)
}

export function preparedSurfaceAttachmentFacts(
    prepared: PreparedSurfaceAttachment
): PreparedSurfaceAttachmentFacts {

    const preparedState = preparedSurfaceAttachments.get(prepared)
    if (preparedState === undefined) {
        throw new TypeError('Surface attachment preparation is not owned by Scratch.')
    }
    return Object.freeze({
        surfaceId: preparedState.state.id,
        format: preparedState.format,
        configurationVersion: preparedState.configurationVersion,
    })
}

function installSurfaceObservations(surface: Surface): void {

    Object.defineProperties(surface, {
        runtime: surfaceObservation(state => state.runtime),
        id: surfaceObservation(state => state.id),
        canvas: surfaceObservation(state => state.canvas),
        context: surfaceObservation(state => state.context),
        format: surfaceObservation(state => state.configuration.format),
        usage: surfaceObservation(state => state.configuration.usage),
        viewFormats: surfaceObservation(state => state.configuration.viewFormats),
        colorSpace: surfaceObservation(state => state.configuration.colorSpace),
        toneMapping: surfaceObservation(state => state.configuration.toneMapping),
        alphaMode: surfaceObservation(state => state.configuration.alphaMode),
        size: surfaceObservation(state => state.size),
        isConfigured: surfaceObservation(state => state.isConfigured),
        isDisposed: surfaceObservation(state => state.isDisposed),
    })
}

function surfaceObservation<Value>(read: (state: SurfaceState) => Value): PropertyDescriptor {

    return {
        get(this: Surface) {
            return read(assertSurfaceObservationState(this))
        },
        enumerable: true,
        configurable: false,
    }
}

function assertSurfaceObservationState(surface: Surface): SurfaceState {

    const state = surfaceStates.get(surface)
    if (state !== undefined) return state
    return throwSurfaceContextNotOwned(surface)
}

function assertSurfaceAliveOwner(surface: Surface): SurfaceState {

    const state = surfaceStates.get(surface)
    if (state?.isDisposed) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_DISPOSED',
            severity: 'error',
            phase: 'runtime',
            subject: surfaceSubject(surface, state),
            message: 'Surface has been disposed.',
            hints: [ 'Create a replacement Surface from an active ScratchRuntime.' ],
        })
    }

    return assertSurfaceContextOwner(surface)
}

function assertSurfaceUsable(surface: Surface): SurfaceState {

    const state = assertSurfaceAliveOwner(surface)
    state.runtime.assertActive()
    assertSurfaceConfigurationCurrent(surface, state)
    return state
}

function assertSurfaceConfigurationCandidateCurrent(
    surface: Surface,
    state: SurfaceState,
    configurationVersion: number
): void {

    const currentState = assertSurfaceAliveOwner(surface)
    currentState.runtime.assertActive()
    if (currentState === state && currentState.configurationVersion === configurationVersion) return

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, currentState),
        related: [ currentState.runtime.subject ],
        message: 'Surface configuration candidate became stale while materializing its input.',
        expected: {
            surfaceId: state.id,
            configurationVersion,
            owner: 'same exact live Surface',
        },
        actual: {
            reason: 'candidate-invalidated-before-native-issue',
            surfaceId: currentState.id,
            configurationVersion: currentState.configurationVersion,
            exactState: currentState === state,
        },
    })
}

function claimSurfaceContext(surface: Surface, state: SurfaceState): void {

    const owner = surfaceContextOwners.get(state.context)
    if (owner === undefined) {
        surfaceContextOwners.set(state.context, surface)
        return
    }

    const ownerState = surfaceStates.get(owner)
    const ownerRuntime = ownerState?.runtime
    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONTEXT_IN_USE',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, state),
        related: ownerRuntime === state.runtime
            ? [ surfaceSubject(owner, ownerState), state.runtime.subject ]
            : [ surfaceSubject(owner, ownerState), ownerRuntime!.subject, state.runtime.subject ],
        message: 'GPUCanvasContext is already owned by another live Surface.',
        expected: { canvasContextOwner: 'no live Surface' },
        actual: {
            ownerSurfaceId: ownerState?.id,
            ownerRuntimeId: ownerRuntime?.id,
            requestedRuntimeId: state.runtime.id,
        },
        hints: [ 'Dispose the owning Surface before creating a replacement for this canvas context.' ],
    })
}

function assertSurfaceContextOwner(surface: Surface): SurfaceState {

    const state = surfaceStates.get(surface)
    if (state !== undefined && surfaceContextOwners.get(state.context) === surface) return state
    return throwSurfaceContextNotOwned(surface, state)
}

function throwSurfaceContextNotOwned(
    surface: Surface,
    exactState: SurfaceState | undefined = surfaceStates.get(surface)
): never {

    const inheritedState = exactState === undefined ? inheritedSurfaceState(surface) : undefined
    const claimedState = exactState ?? inheritedState
    const owner = claimedState === undefined
        ? undefined
        : surfaceContextOwners.get(claimedState.context)
    const ownerState = owner === undefined ? undefined : surfaceStates.get(owner)
    const runtime = claimedState?.runtime

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, exactState, inheritedState),
        related: [
            ...(owner === undefined || owner === surface
                ? []
                : [ surfaceSubject(owner, ownerState), ownerState!.runtime.subject ]),
            ...(runtime === undefined ? [] : [ runtime.subject ]),
        ],
        message: 'Surface operation requires the exact live owner of this GPUCanvasContext.',
        expected: {
            ownerSurfaceId: claimedState?.id,
            ownerRuntimeId: runtime?.id,
            receiver: 'exact privately registered Surface',
        },
        actual: {
            ownerSurfaceId: ownerState?.id,
            ownerRuntimeId: ownerState?.runtime.id,
            hasExactPrivateState: exactState !== undefined,
            inheritsSurfaceState: inheritedState !== undefined,
            exactOwner: owner === surface,
        },
    })
}

function inheritedSurfaceState(surface: Surface): SurfaceState | undefined {

    let candidate: object | null
    try {
        candidate = Object.getPrototypeOf(surface)
    } catch {
        return undefined
    }

    while (candidate !== null) {
        const state = surfaceStates.get(candidate as Surface)
        if (state !== undefined) return state
        try {
            candidate = Object.getPrototypeOf(candidate)
        } catch {
            return undefined
        }
    }
    return undefined
}

function assertSurfaceConfigurationCurrent(surface: Surface, state: SurfaceState): void {

    let observed: SurfaceConfigurationSnapshot
    try {
        observed = captureCurrentSurfaceConfiguration(state.context)
    } catch (cause) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
            severity: 'error',
            phase: 'runtime',
            subject: surfaceSubject(surface, state),
            related: [ state.runtime.subject ],
            message: 'Surface could not inspect its current canvas context configuration.',
            expected: { configuration: 'readable current GPUCanvasConfiguration' },
            actual: {
                reason: 'native-get-configuration-failed',
                nativeErrorName: errorName(cause),
            },
        }, { cause })
    }

    const canvasSize = currentCanvasSize(state.canvas)
    if (
        state.isConfigured &&
        surfaceConfigurationsEqual(observed, state.configuration) &&
        canvasSize.width === state.size.width &&
        canvasSize.height === state.size.height
    ) return

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, state),
        related: [ state.runtime.subject ],
        message: 'Surface committed configuration does not match its current GPUCanvasContext.',
        expected: {
            isConfigured: true,
            configuration: describeSurfaceConfiguration(state.configuration, state.runtime.device),
            size: state.size,
        },
        actual: {
            isConfigured: state.isConfigured,
            configuration: describeSurfaceConfiguration(observed, state.runtime.device),
            size: canvasSize,
        },
        hints: [ 'Call Surface.configure() or Surface.resize() to restore the owned configuration.' ],
    })
}

function releaseSurfaceContext(surface: Surface, state: SurfaceState): void {

    if (surfaceContextOwners.get(state.context) === surface) {
        surfaceContextOwners.delete(state.context)
    }
}

function normalizeSurfaceConfigurationCandidate(
    surface: Surface,
    state: SurfaceState,
    current: SurfaceConfigurationSnapshot,
    options: SurfaceOptionsSnapshot
): SurfaceConfigurationSnapshot {

    const format = options.format === undefined
        ? current.format
        : normalizeSurfaceFormat(surface, state, options.format)
    const usage = options.usage === undefined
        ? current.usage
        : normalizeSurfaceUsage(surface, state, options.usage)
    const viewFormats = options.viewFormats === undefined
        ? current.viewFormats
        : normalizeSurfaceViewFormats(surface, state, options.viewFormats)
    const colorSpace = options.colorSpace === undefined
        ? current.colorSpace
        : normalizeSurfaceColorSpace(surface, state, options.colorSpace)
    const toneMapping = options.toneMapping === undefined
        ? current.toneMapping
        : normalizeSurfaceToneMapping(surface, state, options.toneMapping)
    const alphaMode = options.alphaMode === undefined
        ? current.alphaMode
        : normalizeSurfaceAlphaMode(surface, state, options.alphaMode)

    return freezeSurfaceConfiguration({
        device: state.runtime.device,
        format,
        usage,
        viewFormats,
        colorSpace,
        ...(toneMapping === undefined ? {} : { toneMapping }),
        alphaMode,
    })
}

function snapshotSurfaceOptions(options: SurfaceOptions): SurfaceOptionsSnapshot {

    return Object.freeze({
        format: options.format,
        usage: options.usage,
        viewFormats: options.viewFormats,
        colorSpace: options.colorSpace,
        toneMapping: options.toneMapping,
        alphaMode: options.alphaMode,
        size: options.size,
    })
}

function normalizeSurfaceFormat(
    surface: Surface,
    state: SurfaceState,
    format: unknown
): GPUTextureFormat {

    if (format === 'preferred') return resolveSurfaceFormat(state.runtime, format)
    if (typeof format === 'string' && format.length > 0) return format as GPUTextureFormat
    return throwSurfaceConfigurationInputInvalid(surface, state, { format }, {
        format: 'GPUTextureFormat string or preferred',
    })
}

function normalizeRequestedSurfaceSize(
    surface: Surface,
    state: SurfaceState,
    value: unknown
): Readonly<SurfaceSize> {

    const width = value !== null && typeof value === 'object'
        ? (value as SurfaceSize).width
        : undefined
    const height = value !== null && typeof value === 'object'
        ? (value as SurfaceSize).height
        : undefined
    const valid = [ width, height ].every(dimension => (
        typeof dimension === 'number' &&
        Number.isInteger(dimension) &&
        dimension >= 0 &&
        dimension <= GPU_FLAGS_MAX
    ))
    if (valid) return freezeSurfaceSize({ width: width as number, height: height as number })

    return throwSurfaceConfigurationInputInvalid(surface, state, { size: value }, {
        size: {
            width: `integer in [0, ${GPU_FLAGS_MAX}]`,
            height: `integer in [0, ${GPU_FLAGS_MAX}]`,
        },
    })
}

function normalizeSurfaceUsage(surface: Surface, state: SurfaceState, usage: unknown): GPUTextureUsageFlags {

    if (
        typeof usage === 'number' &&
        Number.isInteger(usage) &&
        usage >= 0 &&
        usage <= GPU_FLAGS_MAX
    ) return usage

    return throwSurfaceConfigurationInputInvalid(surface, state, { usage }, {
        usage: `GPUTextureUsageFlags integer in [0, ${GPU_FLAGS_MAX}]`,
    })
}

function normalizeSurfaceViewFormats(
    surface: Surface,
    state: SurfaceState,
    value: unknown
): readonly GPUTextureFormat[] {

    if (
        typeof value === 'string' ||
        value === null ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        !(Symbol.iterator in value) ||
        typeof value[Symbol.iterator] !== 'function'
    ) {
        return throwSurfaceConfigurationInputInvalid(surface, state, { viewFormats: value }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }

    let formats: unknown[]
    try {
        formats = Array.from(value as Iterable<unknown>)
    } catch {
        return throwSurfaceConfigurationInputInvalid(surface, state, { viewFormats: value }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }
    if (formats.some(format => typeof format !== 'string' || format.length === 0)) {
        return throwSurfaceConfigurationInputInvalid(surface, state, { viewFormats: formats }, {
            viewFormats: 'iterable of GPUTextureFormat strings',
        })
    }

    return Object.freeze(formats as GPUTextureFormat[])
}

function normalizeSurfaceColorSpace(
    surface: Surface,
    state: SurfaceState,
    value: unknown
): PredefinedColorSpace {

    if (COLOR_SPACES.has(value as PredefinedColorSpace)) return value as PredefinedColorSpace
    return throwSurfaceConfigurationInputInvalid(surface, state, { colorSpace: value }, {
        colorSpace: [ 'srgb', 'display-p3' ],
    })
}

function normalizeSurfaceToneMapping(
    surface: Surface,
    state: SurfaceState,
    value: unknown
): SurfaceToneMapping {

    const mode = value !== null && typeof value === 'object'
        ? (value as GPUCanvasToneMapping).mode ?? 'standard'
        : undefined
    if (TONE_MAPPING_MODES.has(mode as GPUCanvasToneMappingMode)) {
        return Object.freeze({ mode: mode as GPUCanvasToneMappingMode })
    }
    return throwSurfaceConfigurationInputInvalid(surface, state, { toneMapping: value }, {
        toneMapping: { mode: [ 'standard', 'extended' ] },
    })
}

function normalizeSurfaceAlphaMode(
    surface: Surface,
    state: SurfaceState,
    value: unknown
): GPUCanvasAlphaMode {

    if (ALPHA_MODES.has(value as GPUCanvasAlphaMode)) return value as GPUCanvasAlphaMode
    return throwSurfaceConfigurationInputInvalid(surface, state, { alphaMode: value }, {
        alphaMode: [ 'opaque', 'premultiplied' ],
    })
}

function throwSurfaceConfigurationInputInvalid<Value>(
    surface: Surface,
    state: SurfaceState,
    actual: Readonly<Record<string, unknown>>,
    expected: Readonly<Record<string, unknown>>
): Value {

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONFIGURATION_FAILED',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, state),
        related: [ state.runtime.subject ],
        message: 'Surface configuration input is invalid.',
        expected,
        actual: { reason: 'descriptor-invalid', ...actual },
    })
}

function nativeSurfaceConfiguration(configuration: SurfaceConfigurationSnapshot): GPUCanvasConfiguration {

    return {
        device: configuration.device,
        format: configuration.format,
        usage: configuration.usage,
        viewFormats: [ ...configuration.viewFormats ],
        colorSpace: configuration.colorSpace,
        ...(configuration.toneMapping === undefined
            ? {}
            : { toneMapping: { mode: configuration.toneMapping.mode } }),
        alphaMode: configuration.alphaMode,
    }
}

function captureCurrentSurfaceConfiguration(context: GPUCanvasContext): SurfaceConfigurationSnapshot {

    const configuration = readCurrentSurfaceConfiguration(context)
    if (configuration === null) throw new TypeError('GPUCanvasContext is not configured.')

    const viewFormats = Array.from(configuration.viewFormats ?? []) as GPUTextureFormat[]
    if (viewFormats.some(format => typeof format !== 'string' || format.length === 0)) {
        throw new TypeError('GPUCanvasContext returned invalid viewFormats.')
    }
    const toneMapping = configuration.toneMapping === undefined
        ? undefined
        : Object.freeze({ mode: configuration.toneMapping.mode ?? 'standard' })
    if (toneMapping !== undefined && !TONE_MAPPING_MODES.has(toneMapping.mode)) {
        throw new TypeError('GPUCanvasContext returned an invalid tone mapping mode.')
    }

    return freezeSurfaceConfiguration({
        device: configuration.device,
        format: configuration.format,
        usage: configuration.usage ?? TEXTURE_USAGE_RENDER_ATTACHMENT,
        viewFormats: Object.freeze(viewFormats),
        colorSpace: configuration.colorSpace ?? 'srgb',
        ...(toneMapping === undefined ? {} : { toneMapping }),
        alphaMode: configuration.alphaMode ?? 'opaque',
    })
}

function readCurrentSurfaceConfiguration(
    context: GPUCanvasContext
): ReturnType<GPUCanvasContext['getConfiguration']> {

    return context.getConfiguration()
}

function assertSurfaceConfigurationAccepted(
    candidate: SurfaceConfigurationSnapshot,
    observed: SurfaceConfigurationSnapshot
): void {

    const toneMappingAccepted = candidate.toneMapping === undefined
        ? observed.toneMapping === undefined || observed.toneMapping.mode === 'standard'
        : candidate.toneMapping.mode === observed.toneMapping?.mode
    if (
        candidate.device === observed.device &&
        candidate.format === observed.format &&
        candidate.usage === observed.usage &&
        equalStringArrays(candidate.viewFormats, observed.viewFormats) &&
        candidate.colorSpace === observed.colorSpace &&
        toneMappingAccepted &&
        candidate.alphaMode === observed.alphaMode
    ) return

    throw new TypeError('GPUCanvasContext did not retain the requested configuration.')
}

function assertSurfaceSizeAccepted(canvas: ScratchCanvas, candidate: Readonly<SurfaceSize>): void {

    const observed = currentCanvasSize(canvas)
    if (observed.width === candidate.width && observed.height === candidate.height) return
    throw new TypeError('Canvas did not retain the requested Surface size.')
}

function surfaceConfigurationsEqual(
    left: SurfaceConfigurationSnapshot,
    right: SurfaceConfigurationSnapshot
): boolean {

    return left.device === right.device &&
        left.format === right.format &&
        left.usage === right.usage &&
        equalStringArrays(left.viewFormats, right.viewFormats) &&
        left.colorSpace === right.colorSpace &&
        left.toneMapping?.mode === right.toneMapping?.mode &&
        left.alphaMode === right.alphaMode
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {

    return left.length === right.length && left.every((value, index) => value === right[index])
}

function rollbackSurfaceConfiguration(
    state: SurfaceState,
    previousConfiguration: SurfaceConfigurationSnapshot,
    previousCanvasSize: Readonly<SurfaceSize>,
    previousConfigured: boolean
): Readonly<{ canvasRestored: boolean, nativeConfigurationRestored: boolean }> {

    const canvasRestored = restoreCanvasSize(state.canvas, previousCanvasSize)
    let nativeConfigurationRestored = true
    try {
        if (previousConfigured) {
            state.context.configure(nativeSurfaceConfiguration(previousConfiguration))
            nativeConfigurationRestored = surfaceConfigurationsEqual(
                captureCurrentSurfaceConfiguration(state.context),
                previousConfiguration
            )
        } else {
            state.context.unconfigure()
            nativeConfigurationRestored = readCurrentSurfaceConfiguration(state.context) === null
        }
    } catch {
        nativeConfigurationRestored = false
    }

    return Object.freeze({ canvasRestored, nativeConfigurationRestored })
}

function throwSurfaceConfigurationFailed(
    surface: Surface,
    state: SurfaceState,
    cause: unknown,
    actual: Readonly<Record<string, unknown>>
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONFIGURATION_FAILED',
        severity: 'error',
        phase: 'runtime',
        subject: surfaceSubject(surface, state),
        related: [ state.runtime.subject ],
        message: 'Surface canvas context configuration failed synchronously.',
        expected: { configuration: 'fully observed native configuration before logical commit' },
        actual,
    }, { cause })
}

function snapshotSurfaceFacts(surface: Surface, state: SurfaceState): SurfaceFacts {

    const configuration = state.configuration
    return Object.freeze({
        runtime: state.runtime,
        id: state.id,
        context: state.context,
        subject: Object.freeze(surfaceSubject(surface, state)),
        format: configuration.format,
        usage: configuration.usage,
        viewFormats: configuration.viewFormats,
        colorSpace: configuration.colorSpace,
        ...(configuration.toneMapping === undefined ? {} : { toneMapping: configuration.toneMapping }),
        alphaMode: configuration.alphaMode,
        size: state.size,
    })
}

function freezeSurfaceConfiguration(
    configuration: SurfaceConfigurationSnapshot
): SurfaceConfigurationSnapshot {

    const viewFormats = Object.isFrozen(configuration.viewFormats)
        ? configuration.viewFormats
        : Object.freeze([ ...configuration.viewFormats ])
    const toneMapping = configuration.toneMapping === undefined
        ? undefined
        : Object.freeze({ mode: configuration.toneMapping.mode })
    return Object.freeze({
        ...configuration,
        viewFormats,
        ...(toneMapping === undefined ? {} : { toneMapping }),
    })
}

function createCanvasContext(subject: DiagnosticSubject, canvas: ScratchCanvas): GPUCanvasContext {

    if (!canvas || typeof canvas.getContext !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONTEXT_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'Surface requires a canvas with getContext().',
            expected: { canvas: 'HTMLCanvasElement or OffscreenCanvas' },
            actual: { canvas: canvas === undefined || canvas === null ? String(canvas) : typeof canvas },
        })
    }

    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (
        !context ||
        typeof context.configure !== 'function' ||
        typeof context.unconfigure !== 'function' ||
        typeof context.getConfiguration !== 'function' ||
        typeof context.getCurrentTexture !== 'function'
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONTEXT_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject,
            message: 'Surface requires a WebGPU canvas context.',
            expected: {
                context: 'GPUCanvasContext with configure(), unconfigure(), getConfiguration(), and getCurrentTexture()',
            },
            actual: {
                context: context === undefined || context === null ? String(context) : typeof context,
                configure: typeof context?.configure,
                unconfigure: typeof context?.unconfigure,
                getConfiguration: typeof context?.getConfiguration,
                getCurrentTexture: typeof context?.getCurrentTexture,
            },
        })
    }

    return context
}

function resolveSurfaceFormat(runtime: ScratchRuntime, format: SurfaceFormat): GPUTextureFormat {

    if (format !== 'preferred') return format
    if (runtime.gpu && typeof runtime.gpu.getPreferredCanvasFormat === 'function') {
        return runtime.gpu.getPreferredCanvasFormat()
    }
    return 'bgra8unorm'
}

function normalizeSurfaceSize(size: SurfaceSize | undefined, canvas: ScratchCanvas): SurfaceSize {

    if (size === undefined) {
        return {
            width: Number(canvas?.width ?? 0),
            height: Number(canvas?.height ?? 0),
        }
    }
    return {
        width: Number(size.width),
        height: Number(size.height),
    }
}

function freezeSurfaceSize(size: SurfaceSize): Readonly<SurfaceSize> {

    return Object.freeze({ width: size.width, height: size.height })
}

function currentCanvasSize(canvas: ScratchCanvas): SurfaceSize {

    return {
        width: Number(canvas.width),
        height: Number(canvas.height),
    }
}

function applyCanvasSize(canvas: ScratchCanvas, size: Readonly<SurfaceSize>): void {

    if ('width' in canvas) canvas.width = size.width
    if ('height' in canvas) canvas.height = size.height
}

function restoreCanvasSize(canvas: ScratchCanvas, size: Readonly<SurfaceSize>): boolean {

    try {
        applyCanvasSize(canvas, size)
        const restored = currentCanvasSize(canvas)
        return restored.width === size.width && restored.height === size.height
    } catch {
        return false
    }
}

function surfaceSubject(
    surface: Surface,
    exactState: SurfaceState | undefined,
    inheritedState: SurfaceState | undefined = undefined
): DiagnosticSubject {

    const state = exactState ?? inheritedState
    const ownId = ownDataValue(surface, 'id')
    const ownLabel = ownDataValue(surface, 'label')
    return surfaceSubjectFromValues(
        typeof ownId === 'string' ? ownId : state?.id ?? 'unowned-surface',
        typeof ownLabel === 'string' ? ownLabel : undefined
    )
}

function surfaceSubjectFromValues(id: string, label: unknown): DiagnosticSubject {

    const subject: DiagnosticSubject = { kind: 'Surface', id }
    if (typeof label === 'string') subject.label = label
    return subject
}

function ownDataValue(surface: Surface, key: string): unknown {

    try {
        return Object.getOwnPropertyDescriptor(surface, key)?.value
    } catch {
        return undefined
    }
}

function describeSurfaceConfiguration(
    configuration: SurfaceConfigurationSnapshot,
    runtimeDevice: GPUDevice
): Readonly<Record<string, unknown>> {

    return Object.freeze({
        runtimeDeviceMatches: configuration.device === runtimeDevice,
        format: configuration.format,
        usage: configuration.usage,
        viewFormats: configuration.viewFormats,
        colorSpace: configuration.colorSpace,
        toneMapping: configuration.toneMapping,
        alphaMode: configuration.alphaMode,
    })
}

function errorName(error: unknown): string {

    return error instanceof Error ? error.name : typeof error
}
