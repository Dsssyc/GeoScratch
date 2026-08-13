import { Pane } from 'tweakpane'
import type { PersistentCacheLifecycle } from 'geoscratch/scratch'
import type { DemCachePolicy } from './dem-tile-protocol.ts'

export type DemCachePanelPolicy =
    | 'disabled'
    | 'session'
    | 'durable'
    | 'clear-on-open'

export type DemCachePanelConfig = Readonly<{
    policy: DemCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: 'best-effort' | 'request'
}>

export type DemRenderingPreference = Readonly<{
    tileWireframe: boolean
}>

type DemCachePanelResolution = Readonly<{
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid'
    config: DemCachePanelConfig
    parameters: URLSearchParams
}>

type DemRenderingPreferenceResolution = Readonly<{
    preference: DemRenderingPreference
    storageStatus: 'missing' | 'valid' | 'invalid'
}>

type DemControlPanelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type PreparedDemControlPanel = Readonly<{
    parameters: URLSearchParams
    config: DemCachePanelConfig
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    renderingPreference: DemRenderingPreference
    renderingStorageStatus: 'missing' | 'valid' | 'invalid' | 'unavailable'
    mount(options: DemControlPanelMountOptions): MountedDemControlPanel
}>

type DemControlPanelMountOptions = Readonly<{
    container: HTMLElement
    location: Pick<Location, 'href' | 'replace'>
    onTileWireframeChange(enabled: boolean): void
    compact?: boolean
}>

type MountedDemControlPanel = Readonly<{
    dispose(): void
}>

type PrepareOptions = Readonly<{
    parameters: URLSearchParams
    storage?: DemControlPanelStorage | null
}>

type MutablePanelConfig = {
    policy: DemCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: DemCachePanelConfig['persistence']
}

type StoredValues = Readonly<{
    available: boolean
    cache: string | null
    rendering: string | null
}>

const MEBIBYTE = 1024 * 1024
export const DEM_CACHE_PANEL_STORAGE_KEY = 'geoscratch.examples.dem.cache-panel.v1'
export const DEM_RENDERING_PREFERENCE_STORAGE_KEY =
    'geoscratch.examples.demLayer.rendering.v1'
const STORAGE_PROBE_KEY = `${DEM_CACHE_PANEL_STORAGE_KEY}.probe`
export const DEM_CACHE_POLICY_DEFAULTS = Object.freeze({
    namespace: 'geoscratch-dem-webmercator-raw-v2',
    maxMiB: 128,
    maxEntries: 2048,
    persistence: 'best-effort' as const,
    lifecycle: 'session' as const,
})
export const DEM_CACHE_POLICY_LIMITS = Object.freeze({
    minMiB: 1,
    maxMiB: 4096,
    minEntries: 1,
    maxEntries: 65_536,
})
export const DEM_CACHE_PARAMETER_NAMES = Object.freeze([
    'cache',
    'cacheLifecycle',
    'cacheNamespace',
    'cacheMaxMiB',
    'cacheMaxEntries',
    'cachePersistence',
] as const)
export const DEM_CACHE_PANEL_DEFAULT_CONFIG: DemCachePanelConfig = Object.freeze({
    policy: 'disabled',
    namespace: DEM_CACHE_POLICY_DEFAULTS.namespace,
    maxMiB: DEM_CACHE_POLICY_DEFAULTS.maxMiB,
    maxEntries: DEM_CACHE_POLICY_DEFAULTS.maxEntries,
    persistence: DEM_CACHE_POLICY_DEFAULTS.persistence,
})
const DEFAULT_RENDERING_PREFERENCE: DemRenderingPreference = Object.freeze({
    tileWireframe: false,
})
const CACHE_PARAMETERS = Object.freeze(new Set<string>(DEM_CACHE_PARAMETER_NAMES))
const CONFIG_KEYS = Object.freeze([
    'policy',
    'namespace',
    'maxMiB',
    'maxEntries',
    'persistence',
] as const)
const POLICIES = Object.freeze(new Set<unknown>([
    'disabled',
    'session',
    'durable',
    'clear-on-open',
]))
const PERSISTENCE_VALUES = Object.freeze(new Set<unknown>([ 'best-effort', 'request' ]))
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

export function prepareDemControlPanel(options: PrepareOptions): PreparedDemControlPanel {

    const storage = options.storage === undefined ? browserStorage() : options.storage
    const stored = readStoredValues(storage)
    const cache = resolveDemCachePanelConfig(options.parameters, stored.cache)
    const rendering = resolveDemRenderingPreference(stored.rendering)
    removeInvalidPreference(
        storage,
        cache.storageStatus,
        DEM_CACHE_PANEL_STORAGE_KEY
    )
    removeInvalidPreference(
        storage,
        rendering.storageStatus,
        DEM_RENDERING_PREFERENCE_STORAGE_KEY
    )
    const storageStatus: PreparedDemControlPanel['storageStatus'] = stored.available
        ? cache.storageStatus
        : 'unavailable'
    const renderingStorageStatus: PreparedDemControlPanel['renderingStorageStatus'] =
        stored.available ? rendering.storageStatus : 'unavailable'
    const prepared = {
        parameters: cache.parameters,
        config: cache.config,
        source: cache.source,
        storageStatus,
        renderingPreference: rendering.preference,
        renderingStorageStatus,
        mount: (mountOptions: DemControlPanelMountOptions) => mountDemControlPanel({
            ...mountOptions,
            config: cache.config,
            source: cache.source,
            storage,
            storageStatus,
            renderingPreference: rendering.preference,
            renderingStorageStatus,
        }),
    }
    return Object.freeze(prepared)
}

export function readDemCachePolicy(parameters: URLSearchParams): DemCachePolicy {

    assertKnownParameters(parameters)
    const mode = parameters.get('cache') ?? 'none'
    if (mode === 'none') {
        const ignored = [ ...CACHE_PARAMETERS ].filter(name =>
            name !== 'cache' && parameters.has(name)
        )
        if (ignored.length > 0) {
            throw new TypeError(`DEM cache=none cannot accept ${ignored.join(', ')}`)
        }
        return Object.freeze({ mode: 'none' })
    }
    if (mode !== 'persistent') throw new TypeError(`Unsupported DEM cache mode: ${mode}`)

    const namespace = parameters.get('cacheNamespace') ?? DEM_CACHE_POLICY_DEFAULTS.namespace
    if (namespace.length === 0) throw new TypeError('DEM cache namespace must not be empty')
    const maxMiB = boundedInteger(
        parameters.get('cacheMaxMiB'),
        DEM_CACHE_POLICY_DEFAULTS.maxMiB,
        DEM_CACHE_POLICY_LIMITS.minMiB,
        DEM_CACHE_POLICY_LIMITS.maxMiB,
        'cacheMaxMiB'
    )
    const maxEntries = boundedInteger(
        parameters.get('cacheMaxEntries'),
        DEM_CACHE_POLICY_DEFAULTS.maxEntries,
        DEM_CACHE_POLICY_LIMITS.minEntries,
        DEM_CACHE_POLICY_LIMITS.maxEntries,
        'cacheMaxEntries'
    )
    return Object.freeze({
        mode: 'persistent',
        namespace,
        maxPayloadBytes: maxMiB * MEBIBYTE,
        maxEntries,
        requestPersistence: readPersistence(parameters.get('cachePersistence')),
        lifecycle: readLifecycle(parameters.get('cacheLifecycle')),
    })
}

export function resolveDemCachePanelConfig(
    current: URLSearchParams,
    stored: string | null
): DemCachePanelResolution {

    const storedRead = readStoredCacheConfig(stored)
    if (hasExplicitCacheParameters(current)) {
        return Object.freeze({
            source: 'url',
            storageStatus: storedRead.status,
            config: panelConfigFromPolicy(readDemCachePolicy(current)),
            parameters: new URLSearchParams(current),
        })
    }
    if (storedRead.status === 'valid') {
        const parameters = replaceDemCacheParameters(current, storedRead.config!)
        return Object.freeze({
            source: 'storage',
            storageStatus: storedRead.status,
            config: storedRead.config!,
            parameters,
        })
    }
    return Object.freeze({
        source: 'default',
        storageStatus: storedRead.status,
        config: DEM_CACHE_PANEL_DEFAULT_CONFIG,
        parameters: new URLSearchParams(current),
    })
}

export function serializeDemCachePanelConfig(config: DemCachePanelConfig): string {

    return JSON.stringify({ schemaVersion: 1, config: normalizeCacheConfig(config) })
}

export function replaceDemCacheParameters(
    current: URLSearchParams,
    config: DemCachePanelConfig
): URLSearchParams {

    const normalized = normalizeCacheConfig(config)
    const result = removeDemCacheParameters(current)
    if (normalized.policy === 'disabled') {
        result.append('cache', 'none')
        return result
    }
    result.append('cache', 'persistent')
    result.append('cacheLifecycle', lifecycleValue(normalized.policy))
    result.append('cacheNamespace', normalized.namespace)
    result.append('cacheMaxMiB', String(normalized.maxMiB))
    result.append('cacheMaxEntries', String(normalized.maxEntries))
    result.append('cachePersistence', normalized.persistence)
    readDemCachePolicy(result)
    return result
}

export function removeDemCacheParameters(current: URLSearchParams): URLSearchParams {

    const result = new URLSearchParams(current)
    for (const name of DEM_CACHE_PARAMETER_NAMES) result.delete(name)
    return result
}

export function resolveDemRenderingPreference(
    serialized: string | null
): DemRenderingPreferenceResolution {

    if (serialized === null) {
        return Object.freeze({
            preference: DEFAULT_RENDERING_PREFERENCE,
            storageStatus: 'missing',
        })
    }
    try {
        const value: unknown = JSON.parse(serialized)
        if (!plainObject(value) || value.version !== 1 ||
            typeof value.tileWireframe !== 'boolean' ||
            !exactKeys(value, [ 'version', 'tileWireframe' ])) {
            throw new TypeError('DEM rendering preference version is invalid')
        }
        return Object.freeze({
            preference: Object.freeze({ tileWireframe: value.tileWireframe }),
            storageStatus: 'valid',
        })
    } catch {
        return Object.freeze({
            preference: DEFAULT_RENDERING_PREFERENCE,
            storageStatus: 'invalid',
        })
    }
}

export function serializeDemRenderingPreference(
    preference: DemRenderingPreference
): string {

    if (!plainObject(preference) || typeof preference.tileWireframe !== 'boolean' ||
        !exactKeys(preference, [ 'tileWireframe' ])) {
        throw new TypeError('DEM rendering preference tileWireframe must be boolean')
    }
    return JSON.stringify({ version: 1, tileWireframe: preference.tileWireframe })
}

function mountDemControlPanel(options: DemControlPanelMountOptions & Readonly<{
    config: DemCachePanelConfig
    source: PreparedDemControlPanel['source']
    storage: DemControlPanelStorage | null
    storageStatus: PreparedDemControlPanel['storageStatus']
    renderingPreference: DemRenderingPreference
    renderingStorageStatus: PreparedDemControlPanel['renderingStorageStatus']
}>): MountedDemControlPanel {

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
        title: 'DEM Layer',
        container: options.container,
        expanded: !(options.compact ?? false),
    })
    pane.element.style.width = '100%'
    pane.element.dataset.demControlPane = 'ready'

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
                DEM_RENDERING_PREFERENCE_STORAGE_KEY,
                serializeDemRenderingPreference({ tileWireframe: enabled })
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
            serializeDemCachePanelConfig(cacheDraft)
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
            const serialized = serializeDemCachePanelConfig(cacheDraft)
            const url = new URL(options.location.href)
            url.search = replaceDemCacheParameters(url.searchParams, cacheDraft).toString()
            try {
                options.storage?.setItem(DEM_CACHE_PANEL_STORAGE_KEY, serialized)
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
            options.storage?.removeItem(DEM_CACHE_PANEL_STORAGE_KEY)
        } catch {
            storageAvailable = false
            renderingStorageStatus = 'unavailable'
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
            delete options.container.dataset.wireframeEnabled
            delete options.container.dataset.renderingStorageStatus
        },
    })
}

function browserStorage(): DemControlPanelStorage | null {

    if (typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function readStoredValues(storage: DemControlPanelStorage | null): StoredValues {

    if (storage === null) {
        return Object.freeze({ available: false, cache: null, rendering: null })
    }
    try {
        storage.setItem(STORAGE_PROBE_KEY, '1')
        storage.removeItem(STORAGE_PROBE_KEY)
        return Object.freeze({
            available: true,
            cache: storage.getItem(DEM_CACHE_PANEL_STORAGE_KEY),
            rendering: storage.getItem(DEM_RENDERING_PREFERENCE_STORAGE_KEY),
        })
    } catch {
        return Object.freeze({ available: false, cache: null, rendering: null })
    }
}

function removeInvalidPreference(
    storage: DemControlPanelStorage | null,
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

function preferenceLabel(status: PreparedDemControlPanel['storageStatus']): string {

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

    api.element.dataset.demControl = name
}

function readStoredCacheConfig(stored: string | null): Readonly<{
    status: DemCachePanelResolution['storageStatus']
    config?: DemCachePanelConfig
}> {

    if (stored === null) return Object.freeze({ status: 'missing' })
    try {
        const value: unknown = JSON.parse(stored)
        if (!plainObject(value) || value.schemaVersion !== 1 ||
            !exactKeys(value, [ 'schemaVersion', 'config' ])) {
            return Object.freeze({ status: 'invalid' })
        }
        return Object.freeze({
            status: 'valid',
            config: normalizeCacheConfig(value.config),
        })
    } catch {
        return Object.freeze({ status: 'invalid' })
    }
}

function normalizeCacheConfig(value: unknown): DemCachePanelConfig {

    if (!plainObject(value) || !exactKeys(value, CONFIG_KEYS) ||
        !POLICIES.has(value.policy) || typeof value.namespace !== 'string' ||
        !Number.isSafeInteger(value.maxMiB) || !Number.isSafeInteger(value.maxEntries) ||
        !PERSISTENCE_VALUES.has(value.persistence)) {
        throw new TypeError('DEM cache panel configuration is invalid')
    }
    const normalized: DemCachePanelConfig = Object.freeze({
        policy: value.policy as DemCachePanelPolicy,
        namespace: value.namespace,
        maxMiB: value.maxMiB as number,
        maxEntries: value.maxEntries as number,
        persistence: value.persistence as DemCachePanelConfig['persistence'],
    })
    const parameters = new URLSearchParams([
        [ 'cache', 'persistent' ],
        [ 'cacheLifecycle', 'session' ],
        [ 'cacheNamespace', normalized.namespace ],
        [ 'cacheMaxMiB', String(normalized.maxMiB) ],
        [ 'cacheMaxEntries', String(normalized.maxEntries) ],
        [ 'cachePersistence', normalized.persistence ],
    ])
    readDemCachePolicy(parameters)
    return normalized
}

function panelConfigFromPolicy(policy: DemCachePolicy): DemCachePanelConfig {

    if (policy.mode === 'none') return DEM_CACHE_PANEL_DEFAULT_CONFIG
    return Object.freeze({
        policy: policy.lifecycle.kind === 'session'
            ? 'session'
            : policy.lifecycle.open === 'reuse'
                ? 'durable'
                : 'clear-on-open',
        namespace: policy.namespace,
        maxMiB: policy.maxPayloadBytes / MEBIBYTE,
        maxEntries: policy.maxEntries,
        persistence: policy.requestPersistence ? 'request' : 'best-effort',
    })
}

function lifecycleValue(policy: Exclude<DemCachePanelPolicy, 'disabled'>): string {

    switch (policy) {
        case 'session': return 'session'
        case 'durable': return 'durable-reuse'
        case 'clear-on-open': return 'durable-clear-before-open'
    }
}

function readLifecycle(value: string | null): PersistentCacheLifecycle {

    switch (value ?? 'session') {
        case 'session': return Object.freeze({ kind: 'session' })
        case 'durable-reuse': return Object.freeze({ kind: 'durable', open: 'reuse' })
        case 'durable-clear-before-open':
            return Object.freeze({ kind: 'durable', open: 'clear-before-open' })
        default: throw new TypeError(`Unsupported DEM cache lifecycle: ${value}`)
    }
}

function readPersistence(value: string | null): boolean {

    switch (value ?? 'best-effort') {
        case 'best-effort': return false
        case 'request': return true
        default: throw new TypeError(`Unsupported DEM cache persistence request: ${value}`)
    }
}

function boundedInteger(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number,
    name: string
): number {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
    }
    return parsed
}

function assertKnownParameters(parameters: URLSearchParams): void {

    const seen = new Set<string>()
    for (const name of parameters.keys()) {
        if (!name.startsWith('cache')) continue
        if (!CACHE_PARAMETERS.has(name)) {
            throw new TypeError(`Unsupported DEM cache option: ${name}`)
        }
        if (seen.has(name)) throw new TypeError(`Duplicate DEM cache option: ${name}`)
        seen.add(name)
    }
}

function hasExplicitCacheParameters(parameters: URLSearchParams): boolean {

    return [ ...parameters.keys() ].some(name => name.startsWith('cache'))
}

function plainObject(value: unknown): value is Record<string, unknown> {

    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {

    const actual = Object.keys(value)
    return actual.length === expected.length && expected.every(key => actual.includes(key))
}
