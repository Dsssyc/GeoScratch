export type FlowFieldRuntimeBudgetFacts = Readonly<{
    maxOwnedRuntimes: 4
    maxCreationSettleMs: number
    total: Readonly<{
        maxRequests: number
        maxPhysicalPages: number
        maxStagingBytes: number
        maxNetworkRequests: number
        maxDecodeTasks: number
    }>
    perRuntime: Readonly<{
        maxRequests: number
        maxPhysicalPages: number
        maxStagingBytes: number
        maxNetworkRequests: number
        maxDecodeTasks: number
    }>
}>

const FLOW_PAGE_BYTE_LENGTH = 256 * 256 * 2 * Float32Array.BYTES_PER_ELEMENT
const FLOW_MAX_OWNED_RUNTIMES = 4
const FLOW_TOTAL_PHYSICAL_PAGES = 192
const FLOW_PER_RUNTIME_PHYSICAL_PAGES =
    FLOW_TOTAL_PHYSICAL_PAGES / FLOW_MAX_OWNED_RUNTIMES

/** Freezes one aggregate budget and its exact four-way runtime partition. */
export const FLOW_FIELD_RUNTIME_BUDGETS: FlowFieldRuntimeBudgetFacts = Object.freeze({
    maxOwnedRuntimes: 4 as const,
    maxCreationSettleMs: 120_000,
    total: Object.freeze({
        maxRequests: FLOW_TOTAL_PHYSICAL_PAGES,
        maxPhysicalPages: FLOW_TOTAL_PHYSICAL_PAGES,
        maxStagingBytes: FLOW_TOTAL_PHYSICAL_PAGES * FLOW_PAGE_BYTE_LENGTH,
        maxNetworkRequests: 4,
        maxDecodeTasks: 4,
    }),
    perRuntime: Object.freeze({
        maxRequests: FLOW_PER_RUNTIME_PHYSICAL_PAGES,
        maxPhysicalPages: FLOW_PER_RUNTIME_PHYSICAL_PAGES,
        maxStagingBytes: FLOW_PER_RUNTIME_PHYSICAL_PAGES * FLOW_PAGE_BYTE_LENGTH,
        maxNetworkRequests: 1,
        maxDecodeTasks: 1,
    }),
})
