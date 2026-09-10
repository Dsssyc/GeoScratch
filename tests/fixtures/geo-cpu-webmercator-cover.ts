import nearPlaneView from './terrain-near-plane-view.json'
import {
    GeoDiagnosticError, GpuWebMercatorQuadCover, GpuWebMercatorQuadDemandProjection,
    WebMercatorQuad, createGeoViewSnapshot, tileMatrixCoverage, webMercatorPlanarTileSpatialProfile, webMercatorQuadAddressCodec,
    WebMercatorQuadCover, WebMercatorQuadDemandProjection, WebMercatorQuadCoverUpload,
    type GpuWebMercatorQuadDemandProjectionFrame,
    type WebMercatorQuadCoverSelection, type WebMercatorQuadCoverUploadFrame,
} from 'geoscratch/geo'
import { runCameraCoverProof as runReferenceProof } from './geo-webmercator-camera-cover.js'
import { GPURuntime, type BufferResource, type SubmissionBuilder, type SubmittedWork } from 'geoscratch/scratch'

export async function runCameraCoverProof() {
    let matched = 0, failuresMatched = 0, uploadsMatched = 0
    const result = await runReferenceProof(async(runtime, gpuCover) => {
        const cover = new WebMercatorQuadCover(gpuCover.descriptor)
        const descriptor = { sourceCoverage: gpuCover.descriptor.spatialProfile.coverage,
            maximumDemands: gpuCover.descriptor.policy.maximumPatches }
        const projection = new WebMercatorQuadDemandProjection({ cover, ...descriptor })
        const gpuProjection = await GpuWebMercatorQuadDemandProjection.create(runtime, { cover: gpuCover, ...descriptor })
        const upload = await WebMercatorQuadCoverUpload.create(runtime, { cover })
        const cpuReadbacks = await Promise.all(upload.templates().map(async template => Promise.all(
            [template.mapMeta, template.patches, template.coverLookup].map(buffer => runtime.createReadbackCommand({
                source: { region: buffer.region(), contentEpoch: 'current-at-step' }, whenMissing: 'throw',
            })))))
        // The frozen reference intentionally omits COPY_SRC on these buffers.
        // Observe through their existing uniform/storage usage, without changing it.
        const gpuMirrors = await Promise.all(gpuCover.templates().map(async template => Promise.all([
            mirror(runtime, template.mapMeta, true), mirror(runtime, template.coverLookup, false),
        ])))
        let demandFrame: GpuWebMercatorQuadDemandProjectionFrame
        let selected: WebMercatorQuadCoverSelection | undefined, failure: unknown
        let uploadFrame: WebMercatorQuadCoverUploadFrame | undefined, gpuParity: 0 | 1
        return {
            initialize(builder) { gpuProjection.initialize(builder) },
            encode(builder, frame, view) {
                demandFrame = gpuProjection.frame(frame)
                gpuProjection.encode(builder, demandFrame)
                gpuProjection.capture(builder, demandFrame)
                selected = undefined
                uploadFrame = undefined
                failure = undefined
                gpuParity = frame.parity
                try { selected = cover.select(view) } catch (error) { failure = error }
                if (selected) {
                    uploadFrame = upload.prepare(selected)
                    upload.encode(builder, uploadFrame)
                    for (const readback of cpuReadbacks[uploadFrame.parity]!) builder.readback(readback)
                    for (const observer of gpuMirrors[gpuParity]!) observer.encode(builder)
                }
            },
            async check(view, words, submitted) {
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
                const receipt = upload.receipt(uploadFrame!, submitted)
                if (receipt.selectionId !== selected.id || receipt.selectionRevision !== selected.revision)
                    throw new Error('CPU upload receipt lost selection provenance')
                const cpuBytes = await Promise.all(cpuReadbacks[uploadFrame!.parity]!.map(command => command.result({ after: submitted }).toBytes()))
                const gpuBytes = await Promise.all(gpuMirrors[gpuParity]!.map(observer => observer.read(submitted)))
                // Camera/epoch ABI is identical. Candidate dispatch/window fields
                // are producer-private and may differ in the exhaustive controls.
                if (!cpuBytes[0]!.slice(0, 132).every((byte, i) => byte === gpuBytes[0]![i]))
                    throw new Error('CPU/GPU uploaded camera ABI mismatch')
                const uploadedPatches = new Uint32Array(cpuBytes[1]!.buffer, cpuBytes[1]!.byteOffset, cpuBytes[1]!.byteLength / 4)
                if (!uploadedPatches.slice(0, words[2]! * 3).every((word, i) => word === words[11 + i]))
                    throw new Error('CPU upload changed the certified patch list')
                const cpuLookup = new Uint32Array(cpuBytes[2]!.buffer, cpuBytes[2]!.byteOffset, cpuBytes[2]!.byteLength / 4)
                const gpuLookup = new Uint32Array(gpuBytes[1]!.buffer, gpuBytes[1]!.byteOffset, gpuBytes[1]!.byteLength / 4)
                if (cpuLookup.length !== gpuLookup.length) throw new Error('CPU/GPU lookup capacities differ')
                for (let offset = 0; offset < cpuLookup.length; offset += 5) {
                    if (cpuLookup[offset] !== gpuLookup[offset] || (cpuLookup[offset] &&
                        !cpuLookup.slice(offset + 1, offset + 5).every((word, i) => word === gpuLookup[offset + 1 + i])))
                        throw new Error('CPU/GPU effective neighbor lookup mismatch')
                }
                uploadsMatched++
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
            dispose() {
                for (const command of cpuReadbacks.flat()) command.dispose()
                for (const observer of gpuMirrors.flat()) observer.dispose()
                upload.dispose(); gpuProjection.dispose(); projection.dispose(); cover.dispose()
            },
        }
    })
    const nearPlaneCorrections = await verifyNearPlaneCorrection()
    return { ...result, nearPlaneCorrections, cpuConsistency: { matched, failuresMatched, uploadsMatched } }
}

async function mirror(runtime: GPURuntime, source: BufferResource, uniform: boolean) {
    const words = source.size / 4
    const output = await runtime.createBuffer({ label: 'Frozen reference byte mirror', size: source.size, usage: 0x80 | 0x04 | 0x08 })
    const clear = runtime.createClearBufferCommand({ target: output.region() })
    const shader = await runtime.createShaderModule({ sourceParts: [{ code: uniform ? `
struct RawWords { words: array<vec4u, ${words / 4}>, }
@group(0) @binding(0) var<uniform> source: RawWords;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64) fn mirror(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < ${words}u) { output[id.x] = source.words[id.x / 4u][id.x % 4u]; }
}` : `
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64) fn mirror(@builtin(global_invocation_id) id: vec3u) {
    if (id.x < ${words}u) { output[id.x] = source[id.x]; }
}` }] })
    const layout = await runtime.createBindLayout({ group: 0, entries: [
        { binding: 0, name: 'source', type: uniform ? 'uniform' : 'read-storage', visibility: ['compute'], minBindingSize: source.size },
        { binding: 1, name: 'output', type: 'storage', visibility: ['compute'], minBindingSize: output.size },
    ] })
    const bindings = await runtime.createBindSet(layout, { source: source.region(), output: output.region() })
    const program = runtime.createProgram({ compute: { module: shader, entryPoint: 'mirror' } })
    const pipeline = await runtime.createComputePipeline({ program, layout: { mode: 'explicit', bindLayouts: [layout] } })
    const command = runtime.createDispatchCommand({ pipeline, bindSets: [{ set: bindings }],
        count: { workgroups: [Math.ceil(words / 64), 1, 1] }, whenMissing: 'throw',
        resources: { read: [source, output].map(resource => ({ resource, contentEpoch: 'current-at-step' as const })), write: [output] } })
    const pass = runtime.createComputePass({ label: 'Observe frozen reference bytes' })
    const readback = await runtime.createReadbackCommand({ source: { region: output.region(), contentEpoch: 'current-at-step' }, whenMissing: 'throw' })
    return {
        encode(builder: SubmissionBuilder) { builder.clear(clear).compute(pass, [command]).readback(readback) },
        read(submitted: SubmittedWork) { return readback.result({ after: submitted }).toBytes() },
        dispose() { for (const value of [readback, command, clear, pass, pipeline, program, bindings, layout, shader, output]) value.dispose() },
    }
}

// The frozen guard is intentionally retained as a failing counterexample (ADR-130).
// Its previous successful samples above remain exact consistency checks.
async function verifyNearPlaneCorrection() {
    const runtime = await GPURuntime.create({ label: 'CPU visible near-plane correction' })
    const records = []
    try {
        for (const bits of [40, 52]) for (const flat of [false, true]) {
            const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: nearPlaneView.domain.limits })
            const descriptor = { spatialProfile: webMercatorPlanarTileSpatialProfile({
                addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: bits }),
            }), policy: nearPlaneView.policy,
                verticalRangeMeters: (flat ? [0, 0] : nearPlaneView.domain.verticalRange) as [number, number],
                ...(flat ? {} : { verticalBounds: nearPlaneView.domain.verticalBounds }) }
            const view = createGeoViewSnapshot({ ...nearPlaneView.view,
                cameraHigh: (flat ? [...nearPlaneView.view.cameraHigh.slice(0, 2), 3] : nearPlaneView.view.cameraHigh) as [number, number, number],
                cameraLow: (flat ? [...nearPlaneView.view.cameraLow.slice(0, 2), 0] : nearPlaneView.view.cameraLow) as [number, number, number],
                referenceViewport: nearPlaneView.view.referenceViewport as [number, number] })
            const cpu = new WebMercatorQuadCover(descriptor)
            let gpu: GpuWebMercatorQuadCover | undefined
            let token: ReturnType<GpuWebMercatorQuadCover['writeView']> | undefined
            try {
                const selection = cpu.select(view)
                if (!selection.patches.length || !Number.isFinite(selection.facts.maximumCellSpanReferencePixels) ||
                    selection.facts.maximumAdjacentLevelDelta > 1) throw new Error('CPU near-plane cut is uncertified')
                gpu = await GpuWebMercatorQuadCover.create(runtime, descriptor)
                token = gpu.writeView(view)
                const frame = gpu.frame(token), builder = runtime.createSubmission()
                gpu.initialize(builder); gpu.encode(builder, frame); gpu.capture(builder, frame)
                const submitted = builder.submit()
                if ((await submitted.nativeOutcome).status !== 'observed-succeeded') throw new Error('Frozen near-plane native work failed')
                let failure: unknown
                try { await gpu.feedback(frame, submitted) } catch (error) { failure = error }
                if (!(failure instanceof GeoDiagnosticError) ||
                    (failure.diagnostic.actual as { reason?: string })?.reason !== 'unbounded-quality')
                    throw new Error('Frozen near-plane counterexample changed')
                records.push({ bits, flat, cpuPatchCount: selection.patches.length,
                    maximumCellSpanReferencePixels: selection.facts.maximumCellSpanReferencePixels,
                    frozenGpuFailure: 'unbounded-quality', correction: 'visible-domain-depth' })
            } finally { token?.dispose(); gpu?.dispose(); cpu.dispose() }
        }
    } finally { runtime.dispose() }
    if (runtime.diagnostics.snapshot().resources.length || runtime.diagnostics.snapshot().readbacks.length)
        throw new Error('Near-plane comparison leaked resources')
    return records
}
