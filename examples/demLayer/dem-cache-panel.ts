import { Pane } from 'tweakpane'
import {
    DEM_CACHE_PANEL_STORAGE_KEY,
    removeDemCacheParameters,
    replaceDemCacheParameters,
    resolveDemCachePanelConfig,
    serializeDemCachePanelConfig,
} from './dem-cache-panel-state.ts'
import type {
    DemCachePanelConfig,
    DemCachePanelPolicy,
} from './dem-cache-panel-state.ts'
import { DEM_CACHE_POLICY_LIMITS } from './dem-cache-policy.ts'

export type DemCachePanelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type PreparedDemCachePanel = Readonly<{
    parameters: URLSearchParams
    config: DemCachePanelConfig
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    mount(options: DemCachePanelMountOptions): MountedDemCachePanel
}>

export type DemCachePanelMountOptions = Readonly<{
    container: HTMLElement
    location: Pick<Location, 'href' | 'replace'>
    compact?: boolean
}>

export type MountedDemCachePanel = Readonly<{
    dispose(): void
}>

type PrepareOptions = Readonly<{
    parameters: URLSearchParams
    storage?: DemCachePanelStorage | null
}>

type MutablePanelConfig = {
    policy: DemCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: DemCachePanelConfig['persistence']
}

const STORAGE_PROBE_KEY = `${DEM_CACHE_PANEL_STORAGE_KEY}.probe`
const POLICY_OPTIONS = Object.freeze({
    Disabled: 'disabled',
    Session: 'session',
    Durable: 'durable',
    'Clear on open': 'clear-on-open',
})
const PERSISTENCE_OPTIONS = Object.freeze({
    'Best effort': 'best-effort',
    Request: 'request',
})

export function prepareDemCachePanel(options: PrepareOptions): PreparedDemCachePanel {

    const storage = options.storage === undefined ? browserStorage() : options.storage
    const storageRead = readStorage(storage)
    const resolution = resolveDemCachePanelConfig(options.parameters, storageRead.value)
    if (resolution.storageStatus === 'invalid') {
        try {
            storage?.removeItem(DEM_CACHE_PANEL_STORAGE_KEY)
        } catch {
            // Invalid preferences are already excluded from effective configuration.
        }
    }
    const storageStatus: PreparedDemCachePanel['storageStatus'] = storageRead.available
        ? resolution.storageStatus
        : 'unavailable'
    const prepared = {
        parameters: resolution.parameters,
        config: resolution.config,
        source: resolution.source,
        storageStatus,
        mount: (mountOptions: DemCachePanelMountOptions) => mountDemCachePanel({
            ...mountOptions,
            config: resolution.config,
            source: resolution.source,
            storage,
            storageStatus,
        }),
    }
    return Object.freeze(prepared)
}

function mountDemCachePanel(options: DemCachePanelMountOptions & Readonly<{
    config: DemCachePanelConfig
    source: PreparedDemCachePanel['source']
    storage: DemCachePanelStorage | null
    storageStatus: PreparedDemCachePanel['storageStatus']
}>): MountedDemCachePanel {

    const draft: MutablePanelConfig = { ...options.config }
    const status = {
        state: 'Saved',
        preference: preferenceLabel(options.storageStatus),
    }
    let storageAvailable = options.storageStatus !== 'unavailable'
    let disposed = false
    const pane = new Pane({
        title: 'DEM Cache',
        container: options.container,
        expanded: !(options.compact ?? false),
    })
    pane.element.style.width = '100%'
    pane.element.dataset.demCachePane = 'ready'

    const policy = pane.addBinding(draft, 'policy', {
        label: 'Cache policy',
        options: POLICY_OPTIONS,
    })
    const state = pane.addBinding(status, 'state', {
        label: 'Status',
        readonly: true,
    })
    const preference = pane.addBinding(status, 'preference', {
        label: 'Preference',
        readonly: true,
    })
    const advanced = pane.addFolder({ title: 'Advanced', expanded: false })
    const namespace = advanced.addBinding(draft, 'namespace', { label: 'Namespace' })
    const maxMiB = advanced.addBinding(draft, 'maxMiB', {
        label: 'Maximum MiB',
        min: DEM_CACHE_POLICY_LIMITS.minMiB,
        max: DEM_CACHE_POLICY_LIMITS.maxMiB,
        step: 1,
    })
    const maxEntries = advanced.addBinding(draft, 'maxEntries', {
        label: 'Maximum entries',
        min: DEM_CACHE_POLICY_LIMITS.minEntries,
        max: DEM_CACHE_POLICY_LIMITS.maxEntries,
        step: 1,
    })
    const persistence = advanced.addBinding(draft, 'persistence', {
        label: 'Persistence',
        options: PERSISTENCE_OPTIONS,
    })
    const apply = pane.addButton({ title: 'Apply & Reload' })
    const reset = pane.addButton({ title: 'Restore defaults' })
    const advancedBindings = [ namespace, maxMiB, maxEntries, persistence ]

    tag(policy, 'policy')
    tag(state, 'status')
    tag(preference, 'preference')
    tag(advanced, 'advanced')
    tag(namespace, 'namespace')
    tag(maxMiB, 'max-mib')
    tag(maxEntries, 'max-entries')
    tag(persistence, 'persistence')
    tag(apply, 'apply')
    tag(reset, 'reset')

    policy.on('change', refreshState)
    namespace.on('change', refreshState)
    maxMiB.on('change', refreshState)
    maxEntries.on('change', refreshState)
    persistence.on('change', refreshState)
    apply.on('click', applyAndReload)
    reset.on('click', restoreDefaults)
    refreshState()

    function refreshState() {

        if (disposed) return
        const disabled = draft.policy === 'disabled'
        for (const binding of advancedBindings) binding.disabled = disabled
        let valid = true
        try {
            serializeDemCachePanelConfig(draft)
        } catch {
            valid = false
        }
        const dirty = valid && !sameConfig(draft, options.config)
        status.state = valid ? dirty ? 'Unsaved changes' : 'Saved' : 'Invalid configuration'
        status.preference = storageAvailable
            ? preferenceLabel(options.storageStatus)
            : 'Local preference unavailable'
        apply.disabled = !dirty
        options.container.dataset.cachePolicy = draft.policy
        options.container.dataset.cacheSource = options.source
        options.container.dataset.cacheStorageStatus = storageAvailable
            ? options.storageStatus
            : 'unavailable'
        options.container.dataset.cacheDirty = String(dirty)
        options.container.dataset.cacheValid = String(valid)
        state.refresh()
        preference.refresh()
    }

    function applyAndReload() {

        if (disposed) return
        let serialized: string
        let parameters: URLSearchParams
        try {
            serialized = serializeDemCachePanelConfig(draft)
            const url = new URL(options.location.href)
            parameters = replaceDemCacheParameters(url.searchParams, draft)
            url.search = parameters.toString()
            try {
                options.storage?.setItem(DEM_CACHE_PANEL_STORAGE_KEY, serialized)
            } catch {
                storageAvailable = false
                refreshState()
            }
            options.location.replace(url.href)
        } catch {
            refreshState()
        }
    }

    function restoreDefaults() {

        if (disposed) return
        try {
            options.storage?.removeItem(DEM_CACHE_PANEL_STORAGE_KEY)
        } catch {
            storageAvailable = false
        }
        const url = new URL(options.location.href)
        url.search = removeDemCacheParameters(url.searchParams).toString()
        options.location.replace(url.href)
    }

    return Object.freeze({
        dispose() {
            if (disposed) return
            disposed = true
            pane.dispose()
            options.container.replaceChildren()
            delete options.container.dataset.cachePolicy
            delete options.container.dataset.cacheSource
            delete options.container.dataset.cacheStorageStatus
            delete options.container.dataset.cacheDirty
            delete options.container.dataset.cacheValid
        },
    })
}

function browserStorage(): DemCachePanelStorage | null {

    if (typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStorage(storage: DemCachePanelStorage | null): Readonly<{
    available: boolean
    value: string | null
}> {

    if (storage === null) return Object.freeze({ available: false, value: null })
    try {
        storage.setItem(STORAGE_PROBE_KEY, '1')
        storage.removeItem(STORAGE_PROBE_KEY)
        return Object.freeze({
            available: true,
            value: storage.getItem(DEM_CACHE_PANEL_STORAGE_KEY),
        })
    } catch {
        return Object.freeze({ available: false, value: null })
    }
}

function preferenceLabel(status: PreparedDemCachePanel['storageStatus']): string {

    switch (status) {
        case 'missing': return 'Local preference ready'
        case 'valid': return 'Local preference loaded'
        case 'invalid': return 'Invalid preference removed'
        case 'unavailable': return 'Local preference unavailable'
    }
}

function sameConfig(left: MutablePanelConfig, right: DemCachePanelConfig): boolean {

    return left.policy === right.policy &&
        left.namespace === right.namespace &&
        left.maxMiB === right.maxMiB &&
        left.maxEntries === right.maxEntries &&
        left.persistence === right.persistence
}

function tag(api: { element: HTMLElement }, name: string): void {

    api.element.dataset.demCacheControl = name
}
