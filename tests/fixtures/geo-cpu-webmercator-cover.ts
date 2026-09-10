import {
    GeoDiagnosticError, GpuWebMercatorQuadDemandProjection,
    WebMercatorQuadCover, WebMercatorQuadDemandProjection,
    type GpuWebMercatorQuadDemandProjectionFrame,
} from 'geoscratch/geo'
import { runCameraCoverProof as runReferenceProof } from './geo-webmercator-camera-cover.js'

export async function runCameraCoverProof() {
    let matched = 0, failuresMatched = 0
    const result = await runReferenceProof(async(runtime, gpuCover) => {
        const cover = new WebMercatorQuadCover(gpuCover.descriptor)
        const descriptor = { sourceCoverage: gpuCover.descriptor.spatialProfile.coverage,
            maximumDemands: gpuCover.descriptor.policy.maximumPatches }
        const projection = new WebMercatorQuadDemandProjection({ cover, ...descriptor })
        const gpuProjection = await GpuWebMercatorQuadDemandProjection.create(runtime, { cover: gpuCover, ...descriptor })
        let demandFrame: GpuWebMercatorQuadDemandProjectionFrame
        return {
            initialize(builder) { gpuProjection.initialize(builder) },
            encode(builder, frame) {
                demandFrame = gpuProjection.frame(frame)
                gpuProjection.encode(builder, demandFrame)
                gpuProjection.capture(builder, demandFrame)
            },
            async check(view, words, submitted) {
                let selected, failure: unknown
                try { selected = cover.select(view) } catch (error) { failure = error }
                const failed = words[3]! > 0 || words[4]! > 0 || words[7]! > 1 || words[10] === 0xffff_ffff
                if (failed) {
                    const reason = words[3] ? 'descriptor-overflow' : words[4] ? 'lookup-overflow' :
                        words[7]! > 1 ? 'adjacency' : 'unbounded-quality'
                    if (!(failure instanceof GeoDiagnosticError) ||
                        (failure.diagnostic.actual as { reason?: string })?.reason !== reason)
                        throw new Error(`CPU/GPU failure mismatch: ${JSON.stringify({ reason, failure })}`)
                    try { await gpuProjection.feedback(demandFrame, submitted); throw new Error('Failed GPU cover emitted demands') }
                    catch (error) { if (!(error instanceof GeoDiagnosticError)) throw error }
                    failuresMatched++
                    return
                }
                if (!selected) throw new Error(`CPU rejected GPU-certified cut: ${String(failure)}`)
                const patches = Array.from({ length: words[2]! }, (_, i) => ({
                    matrixLevel: words[11 + i * 3]!, tileRow: words[12 + i * 3]!, tileCol: words[13 + i * 3]!,
                }))
                if (JSON.stringify(selected.patches) !== JSON.stringify(patches))
                    throw new Error(`CPU/GPU ordered cut mismatch: ${JSON.stringify({ view, cpu: selected.patches, gpu: patches })}`)
                if (selected.facts.maximumAdjacentLevelDelta !== words[7] || selected.facts.finestMatrixLevel !== words[8])
                    throw new Error('CPU/GPU geometry summary mismatch')
                if (words[2]! > 0) {
                    if (Math.abs(selected.facts.minimumCellSpanReferencePixels! - words[9]! / 256) > .02 ||
                        Math.abs(selected.facts.maximumCellSpanReferencePixels! - words[10]! / 256) > .02)
                        throw new Error('CPU/GPU conservative quality differs beyond the native observation tolerance')
                }
                const demand = projection.project(selected)
                const gpuDemand = await gpuProjection.feedback(demandFrame, submitted)
                if (JSON.stringify(demand.demands) !== JSON.stringify(gpuDemand.demands))
                    throw new Error('CPU/GPU source intent mismatch')
                matched++
            },
            dispose() { gpuProjection.dispose(); projection.dispose(); cover.dispose() },
        }
    })
    return { ...result, cpuConsistency: { matched, failuresMatched } }
}
