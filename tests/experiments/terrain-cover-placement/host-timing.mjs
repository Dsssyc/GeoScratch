import ts from 'typescript'

// Opt-in experiment instrumentation. Timings are inclusive and must not be added
// across parents/children. Production modules never import this file.
const targets = {
    '/geo/web-mercator-terrain-renderer.ts': [
        'submitFrame', 'stableIdentitySnapshot', 'persistentFactSnapshot',
        'verifyFrameProvenance', 'startFeedbackPump',
    ],
    '/geo/web-mercator-quad-cover.ts': ['WebMercatorQuadCover.select'],
    '/geo/web-mercator-quad-demand.ts': ['WebMercatorQuadDemandProjection.project'],
    '/geo/web-mercator-quad-cover-upload.ts': ['WebMercatorQuadCoverUpload.prepare', 'WebMercatorQuadCoverUpload.encode', 'WebMercatorQuadCoverUpload.receipt'],
    '/geo/gpu-web-mercator-quad-cover.ts': [ 'GpuWebMercatorQuadCover.writeView', 'mapMetaRecord' ],
    '/scratch/gpu/submission.ts': [
        'SubmissionBuilder.submit', 'resolveSubmissionBeforeEncoding',
        'createSubmissionNativeIssuePlan', 'createSubmittedWork',
        'restorePreparedContentState', 'applyPreparedQueueEffects',
    ],
    '/scratch/gpu/submission-native-observation.ts': [
        'beginSubmissionNativeObservation', 'assertObservationInput',
    ],
    '/scratch/gpu/runtime-diagnostics.ts': [
        'GPURuntimeDiagnosticsController.snapshot', 'resourceFact',
    ],
}

export function instrumentHostTiming(source, id) {
    const entry = Object.entries(targets).find(([suffix]) => id.endsWith(suffix))
    if (!entry) return source
    const [suffix, names] = entry
    const remaining = new Set(names.filter(name => name !== 'startFeedbackPump' || !source.includes('new WebMercatorQuadCover({'))), edits = []
    const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    function visit(node) {
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && node.name) {
            const owner = ts.isClassDeclaration(node.parent) ? `${node.parent.name.text}.` : ''
            const name = owner + node.name.getText(file)
            if (remaining.delete(name)) {
                const label = suffix.split('/').at(-1) + ':' + name
                edits.push({ at: node.body.getStart(file) + 1, text: '\nconst __hostTimingStart = performance.now(); try {\n' })
                edits.push({ at: node.body.end - 1, text: `\n} finally { (globalThis as any).__terrainHostTiming?.record(${JSON.stringify(label)}, performance.now() - __hostTimingStart) }\n` })
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    if (remaining.size) throw new Error(`Missing host timing anchors in ${id}: ${[...remaining]}`)
    for (const edit of edits.sort((a, b) => b.at - a.at))
        source = source.slice(0, edit.at) + edit.text + source.slice(edit.at)
    return source
}

export function installHostTiming() {
    let current
    const frames = []
    const record = (label, ms) => {
        if (!current) return
        const value = current.scopes[label] ??= { count: 0, ms: 0 }
        value.count++
        value.ms += ms
    }
    window.__terrainHostTiming = {
        frames,
        begin(frameNumber) {
            if (frames.length >= 1024) throw new Error('Host timing frame capacity exceeded')
            current = { frameNumber, started: performance.now(), scopes: {} }
            frames.push(current)
        },
        end() { current = undefined },
        record,
    }
    for (const [type, names] of [
        [GPUQueue, ['writeBuffer', 'writeTexture', 'submit']],
        [GPUDevice, ['createCommandEncoder', 'pushErrorScope', 'popErrorScope']],
        [GPUCommandEncoder, ['beginComputePass', 'beginRenderPass', 'finish']],
        [GPUComputePassEncoder, ['setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'end']],
        [GPURenderPassEncoder, ['setPipeline', 'setBindGroup', 'setIndexBuffer', 'drawIndexedIndirect', 'end']],
    ]) {
        for (const name of names) {
            const original = type.prototype[name]
            type.prototype[name] = function(...args) {
                const start = performance.now()
                try { return Reflect.apply(original, this, args) }
                finally { record(`native:${type.name}.${name}`, performance.now() - start) }
            }
        }
    }
}

export function summarizeHostTiming(frames) {
    const labels = [...new Set(frames.flatMap(frame => Object.keys(frame.scopes)))]
    return Object.fromEntries(labels.map(label => {
        const values = frames.map(frame => frame.scopes[label]?.ms ?? 0).sort((a, b) => a - b)
        return [label, {
            frames: values.length,
            calls: frames.reduce((sum, frame) => sum + (frame.scopes[label]?.count ?? 0), 0),
            meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
            p50Ms: values[Math.floor(values.length * .5)] ?? null,
            p95Ms: values[Math.floor(values.length * .95)] ?? null,
        }]
    }))
}
