import type { VirtualRasterPageIdentity } from 'geoscratch/geo'
import type { FlowTemporalReadyCapture } from './flow-temporal-runtime-window.ts'
import type { FlowVelocitySampleRuntime } from './velocity-source.ts'

/** Holds a newly selected pair's particle history until its requested view pages are published. */
export function flowPairViewReady(
    capture: FlowTemporalReadyCapture<FlowVelocitySampleRuntime>,
    pages: readonly VirtualRasterPageIdentity[]
): boolean {
    if (pages.length === 0) return false
    const runtimes = new Set([capture.lower.runtime, capture.upper.runtime])
    return [...runtimes].every(runtime => pages.every(page => {
        const ownPage = runtime.addressSpace.pageFromTile(page.tile!)
        const availability = runtime.residency.availability(ownPage)
        if (availability === 'failed') {
            throw new Error(`Flow Field view page failed for ${runtime.source.sampleKey}`)
        }
        return availability === 'resident'
    }))
}
