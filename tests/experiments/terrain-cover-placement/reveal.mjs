export async function movingReveal() {
    const audit = window.__terrainEval
    const proof = window.__UNDERWATER_TERRAIN_PROOF__
    const canvas = document.querySelector('#GPUFrame')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const raf = () => new Promise(resolve => requestAnimationFrame(resolve))
    function ready(afterFrame = -1, camera) {
        const state = audit.graph.state(), vr = audit.virtualRaster.inspect()
        const demand = audit.lastDemand
        const observedCamera = JSON.parse(canvas.dataset.cameraView ?? 'null')
        if (camera && (!observedCamera || observedCamera.zoom !== camera.zoom ||
            observedCamera.pitch !== camera.pitch || observedCamera.bearing !== camera.bearing ||
            camera.center.some((value, axis) => Math.abs(value - observedCamera.center[axis]) > 1e-9))) return false
        return state.convergenceState === 'converged' && state.coverFrameEpoch > afterFrame &&
            demand && demand.generation > afterFrame &&
            demand.demands.every(value => audit.virtualRaster.residency.availability(value.page) === 'resident') &&
            vr.gpu.stagedSnapshotEpoch === undefined && vr.gpu.snapshotEpoch === vr.residency.snapshotEpoch &&
            vr.residency.stagedCount === 0 && vr.scheduler.activeRequestCount === 0 && vr.scheduler.queuedRequestCount === 0
    }
    async function wait(afterFrame, camera) {
        const deadline = performance.now() + 30_000
        while (!ready(afterFrame, camera)) {
            if (canvas.dataset.status === 'error') throw new Error(canvas.dataset.error)
            if (performance.now() > deadline) throw new Error('Moving reveal did not settle')
            await sleep(20)
        }
    }
    await wait(-1)
    const initialFrame = audit.graph.state().frame
    const initial = audit.virtualRaster.inspect()
    const started = performance.now()
    proof.resetFrameTiming()
    let firstExactDuringMotion = null
    let lastCamera
    for (let index = 0; index < 90; index++) {
        await raf()
        // Observe the already-issued camera before replacing it with the next pose.
        if (lastCamera && firstExactDuringMotion === null && ready(initialFrame, lastCamera)) firstExactDuringMotion = performance.now() - started
        lastCamera = { center: [120.980697 + index * .000003, 31.684162], zoom: 10.25, pitch: 70, bearing: 90 }
        proof.moveCamera(lastCamera)
        if (canvas.dataset.status === 'error') throw new Error(canvas.dataset.error)
    }
    const stopped = performance.now()
    const atStop = { state: audit.graph.state(), raster: audit.virtualRaster.inspect() }
    await wait(initialFrame, lastCamera)
    const settled = performance.now()
    const requests = audit.events.filter(event => event.type === 'request' && event.time >= started)
    const final = { state: audit.graph.state(), raster: audit.virtualRaster.inspect(), controller: audit.frameController.snapshot() }
    return {
        issuedCameraMoves: 90, motionMs: stopped - started,
        firstExecutorRequestMs: requests.length ? requests[0].time - started : null,
        requestsDuringMotion: requests.filter(event => event.time <= stopped).length,
        requestsAfterMotion: requests.filter(event => event.time > stopped).length,
        firstExactDuringMotionMs: firstExactDuringMotion,
        exactReadyAfterMotionMs: settled - stopped,
        initial, atStop, final, timing: proof.frameTiming(), requests,
    }
}
