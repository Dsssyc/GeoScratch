import type { PersistentCacheLifecycle } from 'geoscratch/scratch'

export type FlowFieldCachePolicy =
    | Readonly<{ mode: 'none' }>
    | Readonly<{
        mode: 'persistent'
        namespace: string
        maxPayloadBytes: number
        maxEntries: number
        requestPersistence: boolean
        lifecycle: PersistentCacheLifecycle
    }>

export const FLOW_FIELD_CACHE_DISABLED: FlowFieldCachePolicy = Object.freeze({
    mode: 'none',
})
