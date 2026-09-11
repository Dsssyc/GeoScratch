import type { SurfaceSize } from 'geoscratch/scratch'
import type { FlowFieldTrailQuality } from './flow-presentation.ts'

const BALANCED_MAXIMUM_PIXELS = 1920 * 1080

/** Bounds only trail textures; the captured reference viewport and native Surface stay authoritative. */
export function flowTrailTextureSize(
    presentationSize: SurfaceSize,
    referenceViewport: readonly number[],
    quality: FlowFieldTrailQuality
): Readonly<{ width: number, height: number }> {
    const { width, height } = presentationSize
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
        referenceViewport.length !== 2 || referenceViewport.some(value => !Number.isFinite(value) || value <= 0) ||
        (quality !== 'balanced' && quality !== 'native')) {
        throw new TypeError('Flow trail resolution requires positive sizes and balanced or native quality')
    }
    if (quality === 'native') return Object.freeze({ width, height })
    // Preserve the presentation aspect ratio, never upscale, and cap both
    // density (one texel/reference pixel) and total trail pixels (1080p).
    const scale = Math.min(1, referenceViewport[0]! / width, referenceViewport[1]! / height,
        Math.sqrt(BALANCED_MAXIMUM_PIXELS / (width * height)))
    return Object.freeze({
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
    })
}
