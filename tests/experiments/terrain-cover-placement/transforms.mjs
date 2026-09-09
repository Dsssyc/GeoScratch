import { writeFileSync } from 'node:fs'
function replace(source, from, to) {
    if (!source.includes(from))
        throw new Error('Experiment patch anchor missing: ' + from.slice(0, 90)); return source.replace(from, to)
}
export function transform(source, id, mode, { experimentDirectory: dir, outputDirectory, coordinateBits }) {
    if (!['gpu', 'shadow', 'cpu-cover', 'cpu-all'].includes(mode))
        throw new Error('Invalid experimental execution mode')
    if (coordinateBits === 52 && id.endsWith('/examples/underwaterTerrain/dem-source.ts'))
        source = replace(source, 'export const DEM_WEB_MERCATOR_COORDINATE_BITS = 40', 'export const DEM_WEB_MERCATOR_COORDINATE_BITS = 52')
    if (id.endsWith('/examples/underwaterTerrain/application.ts')) {
        source = replace(source, '    proof?.observeRuntime(runtime)', `    ;(globalThis as any).__terrainEval = { runtime, source, events: [], mode: '${mode}' }
    proof?.observeRuntime(runtime)`)
        source = replace(source, '    const initialized = await graph.initialize()', `    Object.assign((globalThis as any).__terrainEval, { graph, virtualRaster })
    const initialized = await graph.initialize()`)
        source = replace(source, '    function moveCamera(camera: CameraMoveOptions)', `    Object.assign((globalThis as any).__terrainEval, { frameController, map })
    function moveCamera(camera: CameraMoveOptions)`)
        source = replace(source, '            const startedAt = performance.now()', `            const timestampAudit = (globalThis as any).__coverTimestampAudit
            if (timestampAudit) timestampAudit.frameEpoch = frameNumber
            const startedAt = performance.now()`)
    }
    if (mode !== 'gpu' && id.endsWith('/geo/gpu-web-mercator-quad-cover.ts')) {
        source = `// Isolated experiment source substitution; no public API change.
import { CpuCover } from '${dir}/cpu-cover.ts'
const experimentalSelectors = new WeakMap<object, CpuCover>()
` + source
        source = replace(source, '        const metadata = mapMetaRecord(this.descriptor, view)', `        const metadata = mapMetaRecord(this.descriptor, view)
        let cpu = experimentalSelectors.get(this)
        if (!cpu) {
            const limits = this.descriptor.spatialProfile.coverage.limits
            const first = limits.find(limit => Number(limit.matrixId) === this.descriptor.policy.minimumMatrixLevel)!
            cpu = new CpuCover({ row: first.minTileRow, col: first.minTileCol,
                width: first.maxTileCol-first.minTileCol+1, height: first.maxTileRow-first.minTileRow+1,
                limits, coordinateBits: this.descriptor.spatialProfile.coordinateBits, verticalBounds: this.descriptor.verticalBounds,
                verticalRange: this.descriptor.verticalRangeMeters }, this.descriptor.policy, this.#lookupCapacity)
            experimentalSelectors.set(this, cpu)
        }
        const result = cpu.run(gpuWebMercatorQuadCoverMapMetaCodec.pack(metadata))
        const cpuProduct = { state: result.state.slice(), patches: result.patches.slice(), lookup: result.lookup.slice(),
            cameraFixedLow: metadata.cameraFixedLow, cameraFixedHigh: metadata.cameraFixedHigh,
            coordinateBits: this.descriptor.spatialProfile.coordinateBits }
        // Snapshot before any later view reuses CPU workspaces.
        decodeGpuWebMercatorQuadCoverFeedback(new Uint8Array(cpuProduct.state.buffer), {
            expectedFrameEpoch: view.frameEpoch, maximumPatches: this.descriptor.policy.maximumPatches })`)
        source = replace(source, '        let viewStamp: SubmissionAuthorityStamp', `        const cpuUploads = ${mode === 'shadow' ? '[]' : `[
            [template.resources.patches, cpuProduct.patches.length ? cpuProduct.patches : new Uint32Array(3)],
            [template.resources.lookup, cpuProduct.lookup], [template.resources.state, cpuProduct.state],
        ].map(([resource, data]: any) => this.runtime.createUploadCommand({
            label: 'Experimental CPU cover product ' + view.frameEpoch,
            target: resource.region({ size: data.byteLength }), data,
        }))`}
        if ((globalThis as any).__terrainEval) (globalThis as any).__terrainEval.cpuSelectionUploadCount = ((globalThis as any).__terrainEval.cpuSelectionUploadCount ?? 0) + cpuUploads.length
        let viewStamp: SubmissionAuthorityStamp`)
        source = replace(source, '            command,\n            viewStamp,', '            command,\n            cpuUploads, cpuProduct,\n            viewStamp,')
        source = replace(source, '                command.dispose()\n            },', '                command.dispose()\n                cpuUploads.forEach(command => command.dispose())\n            },')
        source = replace(source, '            view.command.dispose()\n        }', '            view.command.dispose()\n            ;(view as any).cpuUploads.forEach((command: any) => command.dispose())\n        }')
        source = replace(source, '        this.#disposed = true\n        for (const view', '        this.#disposed = true\n        experimentalSelectors.delete(this)\n        for (const view')
        source = replace(source, '            command.dispose()\n            throw error\n        }\n        const record: ViewRecord', '            command.dispose()\n            cpuUploads.forEach(command => command.dispose())\n            throw error\n        }\n        const record: ViewRecord')
        source = replace(source, '    templates(): readonly [', `    experimentalCpuProduct(frame: GpuWebMercatorQuadCoverFrame) {
        const record = frameRecords.get(frame)
        if (record?.owner !== this) throw new Error('Foreign CPU product frame')
        return (record.view as any).cpuProduct
    }

    templates(): readonly [`)
        if (mode !== 'shadow') {
            source = replace(source, `        builder.compute(this.#pass, [
            record.template.commands.evaluate, record.template.commands.generate,
        ])`, `        for (const command of (record.view as any).cpuUploads) builder.upload(command)`)
            source = replace(source, "selectionPath: 'gpu-camera-inverse-webmercatorquad-cover' as const,", "selectionPath: 'experimental-cpu-camera-cover' as const,")
            if (mode === 'cpu-all') {
                source = replace(source, "kind: 'gpu-web-mercator-quad-cover-feedback' as const,", "kind: 'experimental-cpu-cover-observation' as const,")
                source = replace(source, '        builder.readback(record.template.commands.stateFeedback)', '        // CPU selection observation needs no GPU readback.')
                const start = source.indexOf('        const commands = record.template.commands\n        if (!submitted.readbacks')
                const end = source.indexOf('        const decoded = decodeGpuWebMercatorQuadCoverFeedback(stateBytes, {', start)
                if (start < 0 || end < 0)
                    throw new Error('CPU feedback replacement anchors missing')
                source = source.slice(0, start) + `        const product = (record.view as any).cpuProduct
        const upload = (record.view as any).cpuUploads.at(-1)
        if(!submitted.producerEpochs.some(epoch => epoch.resourceId===record.template.resources.state.id && epoch.producedBy.commandId===upload.id))
            throw new Error('CPU cover product lacks its actual upload receipt')
        const stateBytes = new Uint8Array(product.state.buffer)
` + source.slice(end)
            }
        }
        else {
            source = source.replaceAll('usage: BUFFER_COPY_DST | BUFFER_STORAGE,', 'usage: BUFFER_COPY_DST | BUFFER_COPY_SRC | BUFFER_STORAGE,')
            source = replace(source, '                    const template = {', `                    const patchFeedback = own(await runtime.createReadbackCommand({
                        source: { region: resources.patches.region(), contentEpoch: 'current-at-step' }, whenMissing: 'throw' }))
                    const lookupFeedback = own(await runtime.createReadbackCommand({
                        source: { region: resources.lookup.region(), contentEpoch: 'current-at-step' }, whenMissing: 'throw' }))
                    const template = {`)
            source = replace(source, '                            stateFeedback,', '                            stateFeedback, patchFeedback, lookupFeedback,')
            source = replace(source, '        builder.readback(record.template.commands.stateFeedback)', `        builder.readback(record.template.commands.stateFeedback)
        builder.readback((record.template.commands as any).patchFeedback)
        builder.readback((record.template.commands as any).lookupFeedback)`)
            source = replace(source, '        const decoded = decodeGpuWebMercatorQuadCoverFeedback(stateBytes, {', `        const extra = record.template.commands as any
        const [patchBytes, lookupBytes] = await Promise.all([
            extra.patchFeedback.result({after:submitted}).toBytes(),extra.lookupFeedback.result({after:submitted}).toBytes()])
        const expected = (record.view as any).cpuProduct
        const gpuState = new Uint32Array(stateBytes.buffer, stateBytes.byteOffset, 11)
        const gpuPatches = new Uint32Array(patchBytes.buffer, patchBytes.byteOffset, gpuState[2]*3)
        const gpuLookup = new Uint32Array(lookupBytes.buffer, lookupBytes.byteOffset, expected.lookup.length)
        const stateEqual = expected.state.every((x:number,i:number)=>x===gpuState[i])
        const patchesEqual = expected.patches.length===gpuPatches.length && expected.patches.every((x:number,i:number)=>x===gpuPatches[i])
        let lookupEqual=true
        for(let i=0;i<gpuLookup.length;i+=5) {
            if(expected.lookup[i]!==gpuLookup[i])lookupEqual=false
            if(gpuLookup[i])for(let j=1;j<5;j++)if(expected.lookup[i+j]!==gpuLookup[i+j])lookupEqual=false
        }
        const audit = (globalThis as any).__terrainEval
        audit.events.push({frameEpoch:frame.frameEpoch,stateEqual,patchesEqual,lookupEqual,
            cpuState:Array.from(expected.state),gpuState:Array.from(gpuState)})
        if(!stateEqual||!patchesEqual||!lookupEqual) throw new Error('Experimental CPU terrain shadow mismatch: '+JSON.stringify(audit.events.at(-1)))
        const decoded = decodeGpuWebMercatorQuadCoverFeedback(stateBytes, {`)
        }
    }
    if ((mode === 'shadow' || mode === 'cpu-all') && id.endsWith('/geo/gpu-web-mercator-quad-demand.ts')) {
        source = `import { projectCpuDemand } from '${dir}/cpu-demand.ts'\n` + source
        if (mode === 'cpu-all') {
            source = replace(source, "kind: 'gpu-web-mercator-quad-demand-projection-feedback' as const,", "kind: 'experimental-cpu-source-intent' as const,")
            source = replace(source, '        builder.compute(this.#pass, [ record.template.commands.project ])', '        // Explicit source intent is computed on CPU for this experiment.')
            source = replace(source, '        builder.readback(record.template.commands.stateFeedback)\n        builder.readback(record.template.commands.demandFeedback)', '        // CPU source intent has no GPU observation dependency.')
            const start = source.indexOf('        for (const command of [\n            record.template.commands.stateFeedback,', source.indexOf('    async feedback('))
            const end = source.indexOf('        return Object.freeze({\n            kind:', start)
            if (start < 0 || end < 0)
                throw new Error('CPU demand feedback anchors missing')
            source = source.slice(0, start) + `        const product = (this.descriptor.cover as any).experimentalCpuProduct(record.coverFrame)
        const template = this.descriptor.cover.templates()[frame.parity]
        if(!submitted.producerEpochs.some(epoch => epoch.resourceId===template.state.id))
            throw new Error('CPU source intent lacks its cover publication receipt')
        const decoded = projectCpuDemand(product, this.descriptor.sourceCoverage.limits, this.descriptor.maximumDemands, frame)
` + source.slice(end)
        }
        else {
            source = replace(source, "        return Object.freeze({\n            kind: 'gpu-web-mercator-quad-demand-projection-feedback'", `        const expected = projectCpuDemand((this.descriptor.cover as any).experimentalCpuProduct(record.coverFrame),this.descriptor.sourceCoverage.limits,this.descriptor.maximumDemands,frame)
        if(JSON.stringify(expected.demands)!==JSON.stringify(decoded.demands))throw new Error('CPU terrain source demand mismatch')
        return Object.freeze({
            kind: 'gpu-web-mercator-quad-demand-projection-feedback'`)
        }
    }
    if (mode !== 'gpu' && mode !== 'shadow' && id.endsWith('/geo/web-mercator-terrain-renderer.ts')) {
        source = replace(source, "name: 'cover-map-meta-to-cover-compute',", "name: 'cpu-map-meta-to-terrain-draw',")
        source = replace(source, 'consumerCommandId: coverCommands.generate.id,', 'consumerCommandId: terrainCommand.id,')
        source = replace(source, "selectionPath: 'gpu-camera-inverse-webmercatorquad-cover',", "selectionPath: 'experimental-cpu-camera-cover',")
        source = replace(source, 'stageOrder: WEB_MERCATOR_TERRAIN_STAGE_ORDER,', `stageOrder: ${mode === 'cpu-all' ? "['cpu-cover-upload', 'cpu-source-intent', 'patch-draw-compute', 'terrain']" : "['cpu-cover-upload', 'source-demand-compute', 'patch-draw-compute', 'terrain']"},`)
        if (mode === 'cpu-all')
            source = source.replaceAll('ready.coverFrame.frameEpoch >= latestIssuedFrameEpoch', 'ready.coverFrame.frameEpoch > latestIssuedFrameEpoch')
    }
    if (mode !== 'gpu' && mode !== 'shadow' && id.endsWith('/tests/browser/support/underwater-terrain-proof.ts'))
        source = replace(source, "    canvas.dataset.frames = String(submittedFrames)", `    canvas.dataset.cpuSelectionUploadCount = String((globalThis as any).__terrainEval?.cpuSelectionUploadCount ?? 0)
    canvas.dataset.frames = String(submittedFrames)`)
    if (id.endsWith('/geo/virtual-raster-demand.ts'))
        source = replace(source, '                execution = this.executor.request(demand)', `                ;(globalThis as any).__terrainEval?.events.push({type:'request',time:performance.now(),page:demand.page.key,generation:demand.generation})
                execution = this.executor.request(demand)`)
    if (id.endsWith('/geo/virtual-raster-runtime.ts'))
        source = replace(source, '        const demandGeneration = ++generation\n        const normalized = Object.freeze({', `        if((globalThis as any).__terrainEval) (globalThis as any).__terrainEval.lastDemand = demandSet
        const demandGeneration = ++generation
        const normalized = Object.freeze({`)
    if (id.endsWith('/geo/gpu-web-mercator-quad-cover.ts') || id.endsWith('/geo/web-mercator-terrain-renderer.ts') || id.endsWith('/examples/underwaterTerrain/application.ts'))
        writeFileSync(outputDirectory + '/' + mode + '-' + id.split('/').at(-1), source)
    return source
}
