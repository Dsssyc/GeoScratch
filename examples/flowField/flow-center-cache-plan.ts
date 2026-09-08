import type { VirtualRasterAddressSpace, VirtualRasterPageIdentity } from 'geoscratch/geo'

/** Source-center cache sample edge, including the next page's shared center column/row. */
export const FLOW_CENTER_CACHE_EDGE = 257

/** Example-owned maximum number of cached center-distance pages. */
export const FLOW_CENTER_CACHE_MAX_PAGES = 48

/**
 * Selects deterministic same-level cache jobs without changing source demand.
 * The caller owns the new lookup/jobs arrays; zero lookup entries retain direct sampling.
 * Its key describes only the selected page-table indices and level, not content freshness.
 */
export function flowCenterCachePlan(
    space: VirtualRasterAddressSpace,
    capacity: number,
    pages: readonly VirtualRasterPageIdentity[],
    level: number
): Readonly<{ key: string; pageCount: number; lookup: Uint32Array; jobs: Uint32Array }> {
    if (space?.kind !== 'virtual-raster-address-space' || space.dimensions !== 2 ||
        space.pageSize.length !== 2 || space.pageSize[0] !== 256 || space.pageSize[1] !== 256) {
        throw new TypeError('Flow center cache requires a 2D address space with 256-texel square pages')
    }
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > FLOW_CENTER_CACHE_MAX_PAGES) {
        throw new RangeError('Flow center cache capacity must be an integer within [1, 48]')
    }
    if (!Number.isSafeInteger(level) || level < 0 || level >= space.levelCount) {
        throw new RangeError('Flow center cache level must belong to the address space')
    }
    if (!Array.isArray(pages)) throw new TypeError('Flow center cache pages must be an array')
    const candidates = new Map<number, VirtualRasterPageIdentity>()
    for (const page of pages) {
        space.assertPage(page)
        if (page.level === level) candidates.set(space.tableIndex(page), page)
    }
    // Cache capacity is not a source-demand budget: omitted pages keep lookup 0
    // and use the direct reconstruction. Never rewrite or discard source demand.
    const indices = [...candidates.keys()].sort((left, right) => left - right).slice(0, capacity)
    const lookup = new Uint32Array(space.pageTableEntryCount)
    const jobs = new Uint32Array(capacity * 4)
    for (const [slot, index] of indices.entries()) {
        const page = candidates.get(index)!
        lookup[index] = slot + 1
        jobs.set([page.coordinates[0]!, page.coordinates[1]!, slot, 0], slot * 4)
    }
    return Object.freeze({ key: `${level}:${indices.join(',')}`, pageCount: indices.length, lookup, jobs })
}
