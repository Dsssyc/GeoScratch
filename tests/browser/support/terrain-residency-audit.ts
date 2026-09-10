import type { VirtualRasterResidency } from 'geoscratch/geo'

// Observe public residency boundaries without retaining or copying decoded bytes.
// A retired, previously valid staged page is different from a late invalid response.
export function observeTerrainResidency(residency: VirtualRasterResidency) {
    const staged = new Set<string>()
    let required = new Set<string>()
    let retiredStagedPageCount = 0
    let retiredStagingBytes = 0
    let rejectedStaleOperationCount = 0
    let unrequiredUploadCount = 0
    const original = {
        stage: residency.stage,
        fail: residency.fail,
        reconcileGeneration: residency.reconcileGeneration,
        publish: residency.publish,
    }
    residency.stage = (payload, options) => {
        const key = payload.page.key
        const result = original.stage.call(residency, payload, options)
        if (result.status === 'staged') staged.add(key)
        if (result.status === 'stale') rejectedStaleOperationCount++
        return result
    }
    residency.fail = (page, options) => {
        const result = original.fail.call(residency, page, options)
        if (result.status === 'stale') rejectedStaleOperationCount++
        if (residency.availability(page) !== 'staged') staged.delete(page.key)
        return result
    }
    residency.reconcileGeneration = (generation, pages = []) => {
        const next = new Set(pages.map(page => page.key))
        const retired = [...staged].filter(key => !next.has(key))
        const beforeBytes = retired.length ? residency.inspect().stagingBytes : 0
        original.reconcileGeneration.call(residency, generation, pages)
        required = next
        if (retired.length) {
            retiredStagedPageCount += retired.length
            retiredStagingBytes += beforeBytes - residency.inspect().stagingBytes
            for (const key of retired) staged.delete(key)
        }
    }
    residency.publish = () => {
        const publication = original.publish.call(residency)
        for (const upload of publication.uploads) {
            if (!required.has(upload.page.key)) unrequiredUploadCount++
        }
        staged.clear()
        return publication
    }
    return Object.freeze({
        facts: () => Object.freeze({ retiredStagedPageCount, retiredStagingBytes,
            rejectedStaleOperationCount, unrequiredUploadCount }),
        dispose() {
            Object.assign(residency, original)
            staged.clear()
            required.clear()
        },
    })
}
