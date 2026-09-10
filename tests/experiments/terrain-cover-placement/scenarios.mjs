export async function scenarios(options) {
    const audit = window.__terrainEval, proof = window.__UNDERWATER_TERRAIN_PROOF__, canvas = document.querySelector('#GPUFrame')
    const sleep = ms => new Promise(r => setTimeout(r, ms)), raf = () => new Promise(r => requestAnimationFrame(r))
    const stats = values => { const s = [...values].sort((a, b) => a - b); return { n: s.length, p50: s[Math.floor(s.length * .5)] ?? null, p95: s[Math.floor(s.length * .95)] ?? null, mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length) } }
    function snapshot() {
        const vr = audit.virtualRaster.inspect(), state = audit.graph.state(), demand = audit.lastDemand
        const selected = demand?.demands ?? [], exact = selected.every(d => audit.virtualRaster.residency.availability(d.page) === 'resident')
        return {
            state, vr, selectedCount: selected.length, selectedKeys: selected.map(d => d.page.key), selectedExact: !!demand && exact,
            acknowledged: vr.gpu.stagedSnapshotEpoch === undefined && vr.gpu.snapshotEpoch === vr.residency.snapshotEpoch,
            controller: audit.frameController.snapshot(), dataset: { ...canvas.dataset }
        }
    }
    async function settle(camera, label, minimumFrame = -1) {
        const start = performance.now(), oldFrame = Math.max(minimumFrame, audit.graph.state().frame), oldObserved = Number(canvas.dataset.observedFrames)
        if (camera)
            proof.moveCamera(camera)
        let firstObserved = null, firstCover = null, last
        for (let i = 0; i < 1200; i++) {
            if (canvas.dataset.status === 'error')
                throw new Error(canvas.dataset.error)
            last = snapshot()
            const now = performance.now() - start
            if (Number(canvas.dataset.observedFrames) > oldObserved && firstObserved === null)
                firstObserved = now
            if ((!camera || last.state.coverFrameEpoch > oldFrame) && firstCover === null)
                firstCover = now
            if (firstCover !== null && last.state.convergenceState === 'converged' && (!camera || last.state.coverFrameEpoch > oldFrame) && last.selectedExact && last.acknowledged && last.vr.residency.stagedCount === 0 && last.vr.scheduler.activeRequestCount === 0 && last.vr.scheduler.queuedRequestCount === 0) {
                const requests = audit.events.filter(e => e.type === 'request' && e.time >= start)
                return { label, settledMs: now, firstObservedFrameMs: firstObserved, firstCoverFeedbackMs: firstCover, firstExecutorRequestMs: requests[0] ? requests[0].time - start : null, requestCount: requests.length, ...last }
            }
            await sleep(20)
        }
        throw new Error('Resource convergence timeout ' + JSON.stringify({ label, last }))
    }
    const initial = await settle(null, 'initial')
    const base = { center: [120.980697, 31.684162], zoom: 10.25, pitch: 70, bearing: 90 }
    const cold = await settle(base, 'new-detail')
    const traces = []
    for (const presentation of ['shaded', 'tile-wireframe']) {
        audit.graph.setPresentation(presentation)
        audit.frameController.invalidate()
        await sleep(120)
        for (const timestamped of [false, true]) {
            if (timestamped && !window.__coverTimestampAudit)
                continue
            const ta = window.__coverTimestampAudit
            if (ta) {
                ta.enabled = timestamped
                ta.scenario = presentation
                ta.records = []
                ta.timedEncoders = 0
            }
            proof.resetFrameTiming()
            const startFrame = audit.graph.state().frame, intervals = []
            let previous
            const started = performance.now()
            for (let frame = 0; frame < 90; frame++) {
                const at = await raf()
                if (previous !== undefined)
                    intervals.push(at - previous)
                previous = at
                proof.moveCamera({ ...base, center: [base.center[0] + (frame % 90) * .000003, base.center[1] + (frame % 90) * .000001] })
                if (canvas.dataset.status === 'error')
                    throw new Error(canvas.dataset.error)
            }
            const elapsed = performance.now() - started
            await sleep(160)
            if (ta) {
                ta.enabled = false
                await ta.drain()
            }
            const timing = proof.frameTiming(), records = ta?.records ?? [], byPass = {}
            const adoptionRows = (audit.feedbackCpu ?? []).filter(row => row.started >= started)
            for (const r of records)
                for (const p of r.passes)
                    (byPass[p.label] ??= []).push(p.ms)
            traces.push({
                presentation, timestamped, started, finished: performance.now(), elapsedMs: elapsed, admittedFrames: audit.graph.state().frame - startFrame, hostFrameIntervalsMs: stats(intervals), timing,
                gpuPasses: Object.fromEntries(Object.entries(byPass).map(([label, v]) => [label, stats(v)])), gpuRecords: records,
                feedbackAdoptionCpuMs: stats(adoptionRows.map(row => row.ms)),
                state: audit.graph.state(), controller: audit.frameController.snapshot()
            })
        }
    }
    const beforeA = await settle({ ...base, pitch: 0, zoom: 10, bearing: 0 }, 'A')
    await settle({ ...base, center: [120.80, 31.68], zoom: 11 }, 'B')
    const afterA = await settle({ ...base, pitch: 0, zoom: 10, bearing: 0 }, 'A-return')
    const independent = { sameAState: JSON.stringify([beforeA.state.coverPatchCount, beforeA.state.coverLevelRange, beforeA.state.coverFeedback?.minimumCellSpanReferencePixels, beforeA.state.coverFeedback?.maximumCellSpanReferencePixels]) === JSON.stringify([afterA.state.coverPatchCount, afterA.state.coverLevelRange, afterA.state.coverFeedback?.minimumCellSpanReferencePixels, afterA.state.coverFeedback?.maximumCellSpanReferencePixels]), sameADemands: JSON.stringify(beforeA.selectedKeys) === JSON.stringify(afterA.selectedKeys) }
    return { initial, cold, traces, beforeA, afterA, independent, events: audit.events, timestamps: window.__coverTimestampAudit ? { errors: window.__coverTimestampAudit.errors, live: window.__coverTimestampAudit.liveCount(), pending: window.__coverTimestampAudit.pendingCount() } : null }
}
