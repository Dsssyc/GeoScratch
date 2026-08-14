import { Pane } from 'tweakpane'
import { DEM_CACHE_POLICY_LIMITS } from './dem-cache-policy.ts'
import {
    UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY,
    UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY,
    removeUnderwaterTerrainCacheParameters,
    replaceUnderwaterTerrainCacheParameters,
    resolveUnderwaterTerrainCachePanelConfig,
    resolveUnderwaterTerrainRenderingPreference,
    serializeUnderwaterTerrainCachePanelConfig,
    serializeUnderwaterTerrainRenderingPreference,
} from './control-state.ts'
import type {
    UnderwaterTerrainCachePanelConfig,
    UnderwaterTerrainCachePanelPolicy,
    UnderwaterTerrainRenderingPreference,
} from './control-state.ts'

type UnderwaterTerrainControlPanelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type PreparedUnderwaterTerrainControlPanel = Readonly<{
    parameters: URLSearchParams
    config: UnderwaterTerrainCachePanelConfig
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    renderingPreference: UnderwaterTerrainRenderingPreference
    renderingStorageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    mount(options: UnderwaterTerrainControlPanelMountOptions): MountedUnderwaterTerrainControlPanel
}>

type UnderwaterTerrainControlPanelMountOptions = Readonly<{
    container: HTMLElement
    location: Pick<Location, 'href' | 'replace'>
    onTileWireframeChange(enabled: boolean): void
    compact?: boolean
}>

type MountedUnderwaterTerrainControlPanel = Readonly<{
    dispose(): void
}>

type PrepareOptions = Readonly<{
    parameters: URLSearchParams
    storage?: UnderwaterTerrainControlPanelStorage | null
}>

type MutablePanelConfig = {
    policy: UnderwaterTerrainCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: UnderwaterTerrainCachePanelConfig['persistence']
}

type StoredValues = Readonly<{
    available: boolean
    cache: string | null
    rendering: string | null
}>

const STORAGE_PROBE_KEY = `${UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY}.probe`
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

export function prepareUnderwaterTerrainControlPanel(options: PrepareOptions): PreparedUnderwaterTerrainControlPanel {

    const storage = options.storage === undefined ? browserStorage() : options.storage
    const stored = readStoredValues(storage)
    const cache = resolveUnderwaterTerrainCachePanelConfig(options.parameters, stored.cache)
    const rendering = resolveUnderwaterTerrainRenderingPreference(stored.rendering)
    removeInvalidPreference(
        storage,
        cache.storageStatus,
        UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY
    )
    removeInvalidPreference(
        storage,
        rendering.storageStatus,
        UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY
    )
    const storageStatus: PreparedUnderwaterTerrainControlPanel['storageStatus'] = stored.available
        ? cache.storageStatus
        : 'unavailable'
    const renderingStorageStatus: PreparedUnderwaterTerrainControlPanel['renderingStorageStatus'] =
        stored.available ? rendering.storageStatus : 'unavailable'
    return Object.freeze({
        parameters: cache.parameters,
        config: cache.config,
        source: cache.source,
        storageStatus,
        renderingPreference: rendering.preference,
        renderingStorageStatus,
        mount: (mountOptions: UnderwaterTerrainControlPanelMountOptions) => mountUnderwaterTerrainControlPanel({
            ...mountOptions,
            config: cache.config,
            source: cache.source,
            storage,
            storageStatus,
            renderingPreference: rendering.preference,
            renderingStorageStatus,
        }),
    })
}

function mountUnderwaterTerrainControlPanel(options: UnderwaterTerrainControlPanelMountOptions & Readonly<{
    config: UnderwaterTerrainCachePanelConfig
    source: PreparedUnderwaterTerrainControlPanel['source']
    storage: UnderwaterTerrainControlPanelStorage | null
    storageStatus: PreparedUnderwaterTerrainControlPanel['storageStatus']
    renderingPreference: UnderwaterTerrainRenderingPreference
    renderingStorageStatus: PreparedUnderwaterTerrainControlPanel['renderingStorageStatus']
}>): MountedUnderwaterTerrainControlPanel {

    const cacheDraft: MutablePanelConfig = { ...options.config }
    const renderingDraft = { ...options.renderingPreference }
    const status = {
        state: 'Saved',
        preference: preferenceLabel(options.storageStatus),
    }
    let storageAvailable = options.storageStatus !== 'unavailable'
    let renderingStorageStatus = options.renderingStorageStatus
    let disposed = false
    const pane = new Pane({
        title: 'Underwater Terrain',
        container: options.container,
        expanded: !(options.compact ?? false),
    })
    pane.element.style.width = '100%'
    pane.element.dataset.underwaterTerrainControlPane = 'ready'

    const rendering = pane.addFolder({ title: 'Rendering', expanded: true })
    const tileWireframe = rendering.addBinding(renderingDraft, 'tileWireframe', {
        label: 'Tile wireframe',
    })
    const cache = pane.addFolder({ title: 'Cache', expanded: true })
    const policy = cache.addBinding(cacheDraft, 'policy', {
        label: 'Cache policy',
        options: POLICY_OPTIONS,
    })
    const state = cache.addBinding(status, 'state', {
        label: 'Status',
        readonly: true,
    })
    const preference = cache.addBinding(status, 'preference', {
        label: 'Preference',
        readonly: true,
    })
    const advanced = cache.addFolder({ title: 'Advanced', expanded: false })
    const namespace = advanced.addBinding(cacheDraft, 'namespace', { label: 'Namespace' })
    const maxMiB = advanced.addBinding(cacheDraft, 'maxMiB', {
        label: 'Maximum MiB',
        min: DEM_CACHE_POLICY_LIMITS.minMiB,
        max: DEM_CACHE_POLICY_LIMITS.maxMiB,
        step: 1,
    })
    const maxEntries = advanced.addBinding(cacheDraft, 'maxEntries', {
        label: 'Maximum entries',
        min: DEM_CACHE_POLICY_LIMITS.minEntries,
        max: DEM_CACHE_POLICY_LIMITS.maxEntries,
        step: 1,
    })
    const persistence = advanced.addBinding(cacheDraft, 'persistence', {
        label: 'Persistence',
        options: PERSISTENCE_OPTIONS,
    })
    const apply = cache.addButton({ title: 'Apply & Reload' })
    const reset = cache.addButton({ title: 'Restore defaults' })
    const advancedBindings = [ namespace, maxMiB, maxEntries, persistence ]

    tag(rendering, 'rendering')
    tag(tileWireframe, 'tile-wireframe')
    tag(cache, 'cache')
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

    tileWireframe.on('change', event => applyRenderingPreference(event.value))
    policy.on('change', refreshState)
    namespace.on('change', refreshState)
    maxMiB.on('change', refreshState)
    maxEntries.on('change', refreshState)
    persistence.on('change', refreshState)
    apply.on('click', applyAndReload)
    reset.on('click', restoreDefaults)
    refreshState()

    function applyRenderingPreference(enabled: boolean) {

        if (disposed) return
        try {
            if (options.storage === null) throw new Error('localStorage unavailable')
            options.storage.setItem(
                UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY,
                serializeUnderwaterTerrainRenderingPreference({ tileWireframe: enabled })
            )
            renderingStorageStatus = 'valid'
        } catch {
            storageAvailable = false
            renderingStorageStatus = 'unavailable'
        }
        refreshState()
        options.onTileWireframeChange(enabled)
    }

    function refreshState() {

        if (disposed) return
        const disabled = cacheDraft.policy === 'disabled'
        for (const binding of advancedBindings) binding.disabled = disabled
        let valid = true
        try {
            serializeUnderwaterTerrainCachePanelConfig(cacheDraft)
        } catch {
            valid = false
        }
        const dirty = valid && !sameConfig(cacheDraft, options.config)
        status.state = valid ? dirty ? 'Unsaved changes' : 'Saved' : 'Invalid configuration'
        status.preference = storageAvailable
            ? preferenceLabel(options.storageStatus)
            : 'Local preference unavailable'
        apply.disabled = !dirty
        options.container.dataset.cachePolicy = cacheDraft.policy
        options.container.dataset.cacheSource = options.source
        options.container.dataset.cacheStorageStatus = storageAvailable
            ? options.storageStatus
            : 'unavailable'
        options.container.dataset.cacheDirty = String(dirty)
        options.container.dataset.cacheValid = String(valid)
        options.container.dataset.wireframeEnabled = String(renderingDraft.tileWireframe)
        options.container.dataset.renderingStorageStatus = storageAvailable
            ? renderingStorageStatus
            : 'unavailable'
        state.refresh()
        preference.refresh()
    }

    function applyAndReload() {

        if (disposed) return
        try {
            const serialized = serializeUnderwaterTerrainCachePanelConfig(cacheDraft)
            const url = new URL(options.location.href)
            url.search = replaceUnderwaterTerrainCacheParameters(url.searchParams, cacheDraft).toString()
            try {
                options.storage?.setItem(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY, serialized)
            } catch {
                storageAvailable = false
                renderingStorageStatus = 'unavailable'
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
            options.storage?.removeItem(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY)
        } catch {
            storageAvailable = false
            renderingStorageStatus = 'unavailable'
        }
        const url = new URL(options.location.href)
        url.search = removeUnderwaterTerrainCacheParameters(url.searchParams).toString()
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
            delete options.container.dataset.wireframeEnabled
            delete options.container.dataset.renderingStorageStatus
        },
    })
}

function browserStorage(): UnderwaterTerrainControlPanelStorage | null {

    if (typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStoredValues(storage: UnderwaterTerrainControlPanelStorage | null): StoredValues {

    if (storage === null) {
        return Object.freeze({ available: false, cache: null, rendering: null })
    }
    try {
        storage.setItem(STORAGE_PROBE_KEY, '1')
        storage.removeItem(STORAGE_PROBE_KEY)
        return Object.freeze({
            available: true,
            cache: storage.getItem(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY),
            rendering: storage.getItem(UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY),
        })
    } catch {
        return Object.freeze({ available: false, cache: null, rendering: null })
    }
}

function removeInvalidPreference(
    storage: UnderwaterTerrainControlPanelStorage | null,
    status: 'missing' | 'valid' | 'invalid',
    key: string
) {

    if (status !== 'invalid') return
    try {
        storage?.removeItem(key)
    } catch {
        // Invalid preferences are already excluded from effective configuration.
    }
}

function preferenceLabel(status: PreparedUnderwaterTerrainControlPanel['storageStatus']): string {

    switch (status) {
        case 'missing': return 'Local preference ready'
        case 'valid': return 'Local preference loaded'
        case 'invalid': return 'Invalid preference removed'
        case 'unavailable': return 'Local preference unavailable'
    }
}

function sameConfig(left: MutablePanelConfig, right: UnderwaterTerrainCachePanelConfig): boolean {

    return left.policy === right.policy &&
        left.namespace === right.namespace &&
        left.maxMiB === right.maxMiB &&
        left.maxEntries === right.maxEntries &&
        left.persistence === right.persistence
}

function tag(api: { element: HTMLElement }, name: string): void {

    api.element.dataset.underwaterTerrainControl = name
}
