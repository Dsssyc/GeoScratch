import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
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

export interface Surface {
    runtime: ScratchRuntime
    id: string
    label?: string
    canvas: ScratchCanvas
    context: GPUCanvasContext
    format: GPUTextureFormat
    alphaMode: GPUCanvasAlphaMode
    size: SurfaceSize
    isConfigured: boolean
    isDisposed: boolean
}

export class Surface {

    constructor(runtime: ScratchRuntime, canvas: ScratchCanvas, options: SurfaceOptions = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-surface-${UUID()}`
        this.label = options.label
        this.canvas = canvas
        this.context = createCanvasContext(this, canvas)
        this.format = resolveSurfaceFormat(runtime, options.format ?? 'preferred')
        this.alphaMode = options.alphaMode ?? 'opaque'
        this.size = normalizeSurfaceSize(options.size, canvas)
        this.isConfigured = false
        this.isDisposed = false

        this.configure()
        runtime._registerSurface(this)
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

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SURFACE_DISPOSED',
                severity: 'error',
                phase: 'runtime',
                subject: this.subject,
                message: 'Surface has been disposed.',
                hints: [ 'Create a replacement Surface from an active ScratchRuntime.' ],
            })
        }

        this.runtime.assertActive()
    }

    configure(options: SurfaceOptions = {}): void {

        this.assertUsable()

        if (options.format !== undefined) this.format = resolveSurfaceFormat(this.runtime, options.format)
        if (options.alphaMode !== undefined) this.alphaMode = options.alphaMode
        if (options.size !== undefined) this.size = normalizeSurfaceSize(options.size, this.canvas)

        applyCanvasSize(this.canvas, this.size)

        this.context.configure({
            device: this.runtime.device,
            format: this.format,
            alphaMode: this.alphaMode,
        })
        this.isConfigured = true
    }

    resize(sizeOrWidth: SurfaceSize | number, height?: number): void {

        const size = (typeof sizeOrWidth === 'number'
            ? { width: sizeOrWidth, height }
            : sizeOrWidth) as SurfaceSize

        this.configure({ size })
    }

    getCurrentTexture(): GPUTexture {

        this.assertUsable()
        return this.context.getCurrentTexture()
    }

    dispose(): void {

        if (this.isDisposed) return

        if (this.context && typeof this.context.unconfigure === 'function' && this.isConfigured) {
            this.context.unconfigure()
        }

        this.isConfigured = false
        this.isDisposed = true
        this.runtime._unregisterSurface(this)
    }
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

    if (!context || typeof context.configure !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SURFACE_CONTEXT_UNAVAILABLE',
            severity: 'error',
            phase: 'runtime',
            subject: surface.subject,
            message: 'Surface requires a WebGPU canvas context.',
            expected: { context: 'GPUCanvasContext' },
            actual: { context: context === undefined || context === null ? String(context) : typeof context },
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

function applyCanvasSize(canvas: ScratchCanvas, size: SurfaceSize): void {

    if (!canvas) return
    if ('width' in canvas) canvas.width = size.width
    if ('height' in canvas) canvas.height = size.height
}
