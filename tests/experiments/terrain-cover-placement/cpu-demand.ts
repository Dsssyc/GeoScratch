// Experimental source lowering. Geometry and residency retain separate authority.
export function projectCpuDemand(product: any, limits: readonly any[], maximumDemands: number, frame: any) {
    const first = Number(limits[0].matrixId), ceiling = Number(limits.at(-1).matrixId)
    const entries: any[] = [], byIdentity = new Map<string, any>()
    const camera = product.cameraFixedLow.map((low: number, axis: number) => low + product.cameraFixedHigh[axis] * 2 ** 32)
    for (let i = 0; i < product.patches.length; i += 3) {
        const desired = product.patches[i]
        let level = Math.min(desired, ceiling), row = 0, col = 0, found = false
        while (level >= first) {
            const scale = 2 ** (desired - level), limit = limits[level - first]
            row = Math.floor(product.patches[i + 1] / scale)
            col = Math.floor(product.patches[i + 2] / scale)
            if (row >= limit.minTileRow && row <= limit.maxTileRow && col >= limit.minTileCol && col <= limit.maxTileCol) {
                found = true
                break
            }
            level--
        }
        if (!found)
            continue
        const scale = 2 ** (product.coordinateBits - level)
        const cameraCol = Math.floor(camera[0] / scale), cameraRow = Math.floor(camera[1] / scale)
        const dc = Math.abs(col - cameraCol), distance = Math.abs(row - cameraRow) + Math.min(dc, 2 ** level - dc)
        const priority = desired * 1000000 + 999999 - Math.min(distance, 999999)
        const key = `${level}/${row}/${col}`, previous = byIdentity.get(key)
        if (previous) {
            previous.desiredSampleLevel = Math.max(previous.desiredSampleLevel, desired)
            previous.priority = Math.max(previous.priority, priority)
            continue
        }
        if (entries.length >= maximumDemands)
            throw new Error('Experimental CPU source-demand overflow')
        const value = {
            desiredSampleLevel: desired, sourceLevelCeiling: ceiling, requestMatrixLevel: level,
            tileRow: row, tileCol: col, priority, decisionFrameEpoch: frame.frameEpoch, residencySnapshotEpoch: frame.residencySnapshotEpoch
        }
        entries.push(value)
        byIdentity.set(key, value)
    }
    return Object.freeze({
        frameEpoch: frame.frameEpoch, demandCount: entries.length, overflowCount: 0,
        sourceLevelCeiling: ceiling, demands: Object.freeze(entries.map(Object.freeze))
    })
}
