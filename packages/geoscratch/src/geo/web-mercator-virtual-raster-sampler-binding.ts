import type { BufferRegion, BufferResource, TextureResource, TextureViewSpec } from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type { VirtualRasterGpuState } from './virtual-raster-gpu.js'
import type { WebMercatorVirtualRasterField } from './web-mercator-virtual-raster-field.js'
import { prepareWebMercatorVirtualRasterSampler } from './web-mercator-virtual-raster-sampler-metadata.js'

export type WebMercatorVirtualRasterSamplerBinding = Readonly<{
    kind: 'web-mercator-virtual-raster-sampler-binding'
    model: WebMercatorVirtualRasterField
    gpu: VirtualRasterGpuState
    metadata: BufferRegion
    pageTable: BufferRegion
    atlas: TextureViewSpec
    resources: readonly (BufferResource | TextureResource)[]
    /** Releases only owned metadata; the caller first settles all frames borrowing this binding. */
    dispose(): void
}>

/** Owns immutable uniform metadata and borrows one matching raster; replacement never mutates an older binding. */
export async function createWebMercatorVirtualRasterSamplerBinding(
    model: WebMercatorVirtualRasterField,
    gpu: VirtualRasterGpuState
): Promise<WebMercatorVirtualRasterSamplerBinding> {

    const prepared = prepareWebMercatorVirtualRasterSampler(model)
    assertRaster(model, gpu)
    const { buffer, lease } = await gpu.runtime.createMappedBuffer({
        label: model.id + ' sampler metadata', size: prepared.layout.byteLength(), usage: 0x40,
    })
    try {
        new Uint8Array(lease.view).set(prepared.pack())
        lease.dispose()
        assertRaster(model, gpu)
        return Object.freeze({
            kind: 'web-mercator-virtual-raster-sampler-binding', model, gpu,
            metadata: buffer.region(), pageTable: gpu.pageTable.region(), atlas: gpu.atlasView,
            resources: Object.freeze([buffer, gpu.pageTable, gpu.atlas]),
            dispose: () => buffer.dispose(),
        })
    } catch (error) {
        const failures: unknown[] = [error]
        try { lease.dispose() } catch (failure) { failures.push(failure) }
        try { buffer.dispose() } catch (failure) { failures.push(failure) }
        if (failures.length > 1) throw new AggregateError(failures, 'Raster sampler binding creation cleanup failed')
        throw error
    }
}

function assertRaster(model: WebMercatorVirtualRasterField, gpu: VirtualRasterGpuState): void {

    if (gpu?.runtime === undefined || gpu.pageTable === undefined || gpu.atlas === undefined ||
        gpu.addressSpace !== model.addressSpace || gpu.plane !== model.plane ||
        gpu.pageTable?.runtime !== gpu.runtime || gpu.atlas?.runtime !== gpu.runtime ||
        gpu.atlasView?.texture !== gpu.atlas || gpu.pageTable.isDisposed || gpu.atlas.isDisposed) {
        return throwGeoDiagnostic({
            code: 'GEO_RASTER_SAMPLER_BINDING_MISMATCH', phase: 'sampling',
            subject: { kind: 'web-mercator-raster-sampler', id: model.id },
            message: 'Sampler metadata, page table and atlas require one live matching raster owner.',
            expected: { addressSpace: model.addressSpace.id, plane: model.plane.id },
            actual: { addressSpace: gpu?.addressSpace?.id, plane: gpu?.plane?.id },
        })
    }
}
