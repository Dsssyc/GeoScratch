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
    alphaMode?: GPUCanvasAlphaMode
    size?: SurfaceSize
}

type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas

type SurfaceIdentity = Readonly<{
    runtime: ScratchRuntime
    id: string
    canvas: ScratchCanvas
    context: GPUCanvasContext
}>

const TEXTURE_USAGE_RENDER_ATTACHMENT = getGlobalConstant('GPUTextureUsage', 'RENDER_ATTACHMENT', 0x10)
const surfaceContextOwners = new WeakMap<GPUCanvasContext, Surface>()
const surfaceIdentities = new WeakMap<Surface, SurfaceIdentity>()
const disposedSurfaces = new WeakSet<Surface>()

export interface Surface {
    readonly runtime: ScratchRuntime
    readonly id: string
    label?: string
    readonly canvas: ScratchCanvas
    readonly context: GPUCanvasContext
    readonly format: GPUTextureFormat
    readonly alphaMode: GPUCanvasAlphaMode
    readonly size: Readonly<SurfaceSize>
    readonly isConfigured: boolean
    readonly isDisposed: boolean
}

export class Surface {

    constructor(runtime: ScratchRuntime, canvas: ScratchCanvas, options: SurfaceOptions = {}) {

        runtime.assertActive()

        Object.assign(this, {
            runtime,
            id: `scratch-surface-${UUID()}`,
            canvas,
        })
        if (options.label !== undefined) this.label = options.label
        Object.assign(this, {
            context: createCanvasContext(this, canvas),
            format: resolveSurfaceFormat(runtime, options.format ?? 'preferred'),
            alphaMode: options.alphaMode ?? 'opaque',
            size: normalizeSurfaceSize(options.size, canvas),
            isConfigured: false,
            isDisposed: false,
        })

        claimSurfaceContext(this)
        try {
            this.configure()
            runtime._registerSurface(this)
        } catch (error) {
            releaseSurfaceContext(this)
            throw error
        }
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Surface',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertUsable(): void {

        assertSurfaceUsable(this)
    }

    configure(options: SurfaceOptions = {}): void {

        assertSurfaceAlive(this)
        const identity = assertSurfaceContextOwner(this)
        identity.runtime.assertActive()

        const format = options.format === undefined
            ? this.format
            : resolveSurfaceFormat(identity.runtime, options.format)
        const alphaMode = options.alphaMode ?? this.alphaMode
        const size = options.size === undefined
            ? this.size
            : normalizeSurfaceSize(options.size, identity.canvas)
        const previousCanvasSize = currentCanvasSize(identity.canvas)

        try {
            applyCanvasSize(identity.canvas, size)
            identity.context.configure({
                device: identity.runtime.device,
                format,
                alphaMode,
            })
        } catch (cause) {
            let canvasRestored = true
            try {
                applyCanvasSize(identity.canvas, previousCanvasSize)
            } catch {
                canvasRestored = false
            }

            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_CONFIGURATION_FAILED',
                severity: 'error',
                phase: 'runtime',
                subject: this.subject,
                related: [ identity.runtime.subject ],
                message: 'Surface canvas context configuration failed synchronously.',
                expected: { configuration: 'accepted before logical configuration commit' },
                actual: {
                    reason: 'native-configure-threw',
                    nativeErrorName: errorName(cause),
                    canvasRestored,
                },
            }, { cause })
        }

        Object.assign(this, {
            format,
            alphaMode,
            size,
            isConfigured: true,
        })
    }

    resize(sizeOrWidth: SurfaceSize | number, height?: number): void {

        const size = (typeof sizeOrWidth === 'number'
            ? { width: sizeOrWidth, height }
            : sizeOrWidth) as SurfaceSize

        this.configure({ size })
    }

    getCurrentTexture(): GPUTexture {

        const identity = assertSurfaceUsable(this)
        return identity.context.getCurrentTexture()
    }

    dispose(): void {

        if (disposedSurfaces.has(this)) return
        const identity = surfaceIdentityForDisposal(this)

        let unconfigureFailed = false
        let unconfigureCause: unknown
        try {
            identity.context.unconfigure()
        } catch (cause) {
            unconfigureFailed = true
            unconfigureCause = cause
        } finally {
            disposedSurfaces.add(this)
            Object.assign(this, {
                isConfigured: false,
                isDisposed: true,
            })
            identity.runtime._unregisterSurface(this)
            releaseSurfaceContext(this)
        }

        if (unconfigureFailed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_UNCONFIGURE_FAILED',
                severity: 'error',
                phase: 'runtime',
                subject: this.subject,
                related: [ identity.runtime.subject ],
                message: 'Surface canvas context unconfigure failed during disposal.',
                expected: { lifecycle: 'logical disposal completes even if native unconfigure fails' },
                actual: {
                    reason: 'native-unconfigure-threw',
                    nativeErrorName: errorName(unconfigureCause),
                    isDisposed: this.isDisposed,
                    contextClaimReleased: true,
                },
            }, { cause: unconfigureCause })
        }
    }
}

function assertSurfaceAlive(surface: Surface): void {

    if (!disposedSurfaces.has(surface)) return

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_DISPOSED',
        severity: 'error',
        phase: 'runtime',
        subject: surface.subject,
        message: 'Surface has been disposed.',
        hints: [ 'Create a replacement Surface from an active ScratchRuntime.' ],
    })
}

function assertSurfaceUsable(surface: Surface): SurfaceIdentity {

    assertSurfaceAlive(surface)
    const identity = assertSurfaceContextOwner(surface)
    identity.runtime.assertActive()
    assertSurfaceConfigurationCurrent(surface, identity)
    return identity
}

function claimSurfaceContext(surface: Surface): void {

    const owner = surfaceContextOwners.get(surface.context)
    if (owner === undefined) {
        surfaceContextOwners.set(surface.context, surface)
        surfaceIdentities.set(surface, Object.freeze({
            runtime: surface.runtime,
            id: surface.id,
            canvas: surface.canvas,
            context: surface.context,
        }))
        return
    }

    const ownerIdentity = surfaceIdentities.get(owner)
    const ownerRuntime = ownerIdentity?.runtime ?? owner.runtime

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONTEXT_IN_USE',
        severity: 'error',
        phase: 'runtime',
        subject: surface.subject,
        related: ownerRuntime === surface.runtime
            ? [ owner.subject, surface.runtime.subject ]
            : [ owner.subject, ownerRuntime.subject, surface.runtime.subject ],
        message: 'GPUCanvasContext is already owned by another live Surface.',
        expected: { canvasContextOwner: 'no live Surface' },
        actual: {
            ownerSurfaceId: ownerIdentity?.id ?? owner.id,
            ownerRuntimeId: ownerRuntime.id,
            requestedRuntimeId: surface.runtime.id,
        },
        hints: [ 'Dispose the owning Surface before creating a replacement for this canvas context.' ],
    })
}

function assertSurfaceContextOwner(surface: Surface): SurfaceIdentity {

    const identity = surfaceIdentities.get(surface)
    const claimedContext = identity?.context ?? surface.context
    const owner = surfaceContextOwners.get(claimedContext)
    const publicIdentityCurrent = identity !== undefined &&
        surface.runtime === identity.runtime &&
        surface.id === identity.id &&
        surface.canvas === identity.canvas &&
        surface.context === identity.context
    if (owner === surface && publicIdentityCurrent) return identity

    throwSurfaceContextNotOwned(surface, identity, owner)
}

function surfaceIdentityForDisposal(surface: Surface): SurfaceIdentity {

    const identity = surfaceIdentities.get(surface)
    if (identity !== undefined && surfaceContextOwners.get(identity.context) === surface) {
        return identity
    }

    const context = identity?.context ?? surface.context
    throwSurfaceContextNotOwned(surface, identity, surfaceContextOwners.get(context))
}

function throwSurfaceContextNotOwned(
    surface: Surface,
    identity: SurfaceIdentity | undefined,
    owner: Surface | undefined
): never {

    const runtime = identity?.runtime ?? surface.runtime
    const ownerIdentity = owner === undefined ? undefined : surfaceIdentities.get(owner)
    const ownerRuntime = ownerIdentity?.runtime ?? owner?.runtime

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED',
        severity: 'error',
        phase: 'runtime',
        subject: surface.subject,
        related: [
            ...(owner === undefined || owner === surface ? [] : [ owner.subject, ownerRuntime!.subject ]),
            runtime.subject,
        ],
        message: 'Surface operation requires the live owner of this GPUCanvasContext.',
        expected: {
            ownerSurfaceId: identity?.id ?? surface.id,
            ownerRuntimeId: runtime.id,
            publicIdentity: 'matches privately claimed runtime, id, canvas, and context',
        },
        actual: {
            ownerSurfaceId: ownerIdentity?.id ?? owner?.id,
            ownerRuntimeId: ownerRuntime?.id,
            hasPrivateIdentity: identity !== undefined,
            publicRuntimeMatches: identity === undefined ? undefined : surface.runtime === identity.runtime,
            publicIdMatches: identity === undefined ? undefined : surface.id === identity.id,
            publicCanvasMatches: identity === undefined ? undefined : surface.canvas === identity.canvas,
            publicContextMatches: identity === undefined ? undefined : surface.context === identity.context,
        },
    })
}

function assertSurfaceConfigurationCurrent(surface: Surface, identity: SurfaceIdentity): void {

    let configuration: ReturnType<GPUCanvasContext['getConfiguration']>
    try {
        configuration = identity.context.getConfiguration()
    } catch (cause) {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
            severity: 'error',
            phase: 'runtime',
            subject: surface.subject,
            related: [ identity.runtime.subject ],
            message: 'Surface could not inspect its current canvas context configuration.',
            expected: { configuration: 'readable current GPUCanvasConfiguration' },
            actual: {
                reason: 'native-get-configuration-threw',
                nativeErrorName: errorName(cause),
            },
        }, { cause })
    }

    const canvasSize = currentCanvasSize(identity.canvas)
    const configurationCurrent = surface.isConfigured &&
        configuration !== null &&
        configuration.device === identity.runtime.device &&
        configuration.format === surface.format &&
        configuration.alphaMode === surface.alphaMode &&
        ((configuration.usage ?? TEXTURE_USAGE_RENDER_ATTACHMENT) & TEXTURE_USAGE_RENDER_ATTACHMENT) !== 0 &&
        canvasSize.width === surface.size.width &&
        canvasSize.height === surface.size.height
    if (configurationCurrent) return

    throwScratchDiagnostic({
        code: 'SCRATCH_SURFACE_CONFIGURATION_STALE',
        severity: 'error',
        phase: 'runtime',
        subject: surface.subject,
        related: [ identity.runtime.subject ],
        message: 'Surface logical configuration does not match its current GPUCanvasContext.',
        expected: {
            isConfigured: true,
            runtimeDevice: 'current Surface runtime device',
            format: surface.format,
            alphaMode: surface.alphaMode,
            usage: 'includes GPUTextureUsage.RENDER_ATTACHMENT',
            size: surface.size,
        },
        actual: {
            isConfigured: surface.isConfigured,
            contextConfigured: configuration !== null,
            runtimeDeviceMatches: configuration?.device === identity.runtime.device,
            format: configuration?.format,
            alphaMode: configuration?.alphaMode,
            usage: configuration === null
                ? undefined
                : configuration.usage ?? TEXTURE_USAGE_RENDER_ATTACHMENT,
            size: canvasSize,
        },
        hints: [ 'Call Surface.configure() or Surface.resize() to restore the owned configuration.' ],
    })
}

function releaseSurfaceContext(surface: Surface): void {

    const identity = surfaceIdentities.get(surface)
    if (identity === undefined) return

    if (surfaceContextOwners.get(identity.context) === surface) {
        surfaceContextOwners.delete(identity.context)
    }
    surfaceIdentities.delete(surface)
}

function createCanvasContext(surface: Surface, canvas: ScratchCanvas): GPUCanvasContext {

    if (!canvas || typeof canvas.getContext !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONTEXT_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject: surface.subject,
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
            subject: surface.subject,
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

function currentCanvasSize(canvas: ScratchCanvas): SurfaceSize {

    return {
        width: Number(canvas.width),
        height: Number(canvas.height),
    }
}

function applyCanvasSize(canvas: ScratchCanvas, size: SurfaceSize): void {

    if (!canvas) return
    if ('width' in canvas) canvas.width = size.width
    if ('height' in canvas) canvas.height = size.height
}

function errorName(error: unknown): string {

    return error instanceof Error ? error.name : typeof error
}
