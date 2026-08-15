import {
    UNDERWATER_TERRAIN_CACHE_DEFAULTS,
    UNDERWATER_TERRAIN_CACHE_PARAMETER_NAMES,
    readUnderwaterTerrainCachePolicy,
} from './cache-policy.ts'
import type { UnderwaterTerrainCachePolicy } from './cache-policy.ts'

export type UnderwaterTerrainCachePanelPolicy =
    | 'disabled'
    | 'session'
    | 'durable'
    | 'clear-on-open'

export type UnderwaterTerrainCachePanelConfig = Readonly<{
    policy: UnderwaterTerrainCachePanelPolicy
    namespace: string
    maxMiB: number
    maxEntries: number
    persistence: 'best-effort' | 'request'
}>

export type UnderwaterTerrainRenderingPreference = Readonly<{
    tileWireframe: boolean
}>

type UnderwaterTerrainCachePanelResolution = Readonly<{
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid'
    config: UnderwaterTerrainCachePanelConfig
    parameters: URLSearchParams
}>

type UnderwaterTerrainRenderingPreferenceResolution = Readonly<{
    preference: UnderwaterTerrainRenderingPreference
    storageStatus: 'missing' | 'valid' | 'invalid'
}>

type StoredCacheConfigRead =
    | Readonly<{ status: 'valid'; config: UnderwaterTerrainCachePanelConfig }>
    | Readonly<{ status: 'missing' | 'invalid' }>

const MEBIBYTE = 1024 * 1024
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
const DEFAULT_RENDERING_PREFERENCE: UnderwaterTerrainRenderingPreference = Object.freeze({
    tileWireframe: false,
})

export const UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY =
    'geoscratch.examples.underwaterTerrain.cache-panel.v1'
export const UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY =
    'geoscratch.examples.underwaterTerrain.rendering.v1'
export const UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG:
    UnderwaterTerrainCachePanelConfig = Object.freeze({
        policy: 'disabled',
        namespace: UNDERWATER_TERRAIN_CACHE_DEFAULTS.namespace,
        maxMiB: UNDERWATER_TERRAIN_CACHE_DEFAULTS.maxMiB,
        maxEntries: UNDERWATER_TERRAIN_CACHE_DEFAULTS.maxEntries,
        persistence: UNDERWATER_TERRAIN_CACHE_DEFAULTS.persistence,
    })

export function resolveUnderwaterTerrainCachePanelConfig(
    current: URLSearchParams,
    stored: string | null
): UnderwaterTerrainCachePanelResolution {

    const storedRead = readStoredCacheConfig(stored)
    if (hasExplicitCacheParameters(current)) {
        return Object.freeze({
            source: 'url',
            storageStatus: storedRead.status,
            config: panelConfigFromPolicy(readUnderwaterTerrainCachePolicy(current)),
            parameters: new URLSearchParams(current),
        })
    }
    if (storedRead.status === 'valid') {
        return Object.freeze({
            source: 'storage',
            storageStatus: storedRead.status,
            config: storedRead.config,
            parameters: replaceUnderwaterTerrainCacheParameters(current, storedRead.config),
        })
    }
    return Object.freeze({
        source: 'default',
        storageStatus: storedRead.status,
        config: UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
        parameters: new URLSearchParams(current),
    })
}

export function serializeUnderwaterTerrainCachePanelConfig(config: UnderwaterTerrainCachePanelConfig): string {

    return JSON.stringify({ schemaVersion: 1, config: normalizeCacheConfig(config) })
}

export function replaceUnderwaterTerrainCacheParameters(
    current: URLSearchParams,
    config: UnderwaterTerrainCachePanelConfig
): URLSearchParams {

    const normalized = normalizeCacheConfig(config)
    const result = removeUnderwaterTerrainCacheParameters(current)
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
    readUnderwaterTerrainCachePolicy(result)
    return result
}

export function removeUnderwaterTerrainCacheParameters(current: URLSearchParams): URLSearchParams {

    const result = new URLSearchParams(current)
    for (const name of UNDERWATER_TERRAIN_CACHE_PARAMETER_NAMES) result.delete(name)
    return result
}

export function resolveUnderwaterTerrainRenderingPreference(
    serialized: string | null
): UnderwaterTerrainRenderingPreferenceResolution {

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
            throw new TypeError('Underwater Terrain rendering preference version is invalid')
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

export function serializeUnderwaterTerrainRenderingPreference(
    preference: UnderwaterTerrainRenderingPreference
): string {

    if (!plainObject(preference) || typeof preference.tileWireframe !== 'boolean' ||
        !exactKeys(preference, [ 'tileWireframe' ])) {
        throw new TypeError(
            'Underwater Terrain rendering preference tileWireframe must be boolean'
        )
    }
    return JSON.stringify({ version: 1, tileWireframe: preference.tileWireframe })
}

function readStoredCacheConfig(stored: string | null): StoredCacheConfigRead {

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

function normalizeCacheConfig(value: unknown): UnderwaterTerrainCachePanelConfig {

    if (!plainObject(value) || !exactKeys(value, CONFIG_KEYS) ||
        !POLICIES.has(value.policy) || typeof value.namespace !== 'string' ||
        !Number.isSafeInteger(value.maxMiB) || !Number.isSafeInteger(value.maxEntries) ||
        !PERSISTENCE_VALUES.has(value.persistence)) {
        throw new TypeError('Underwater Terrain cache panel configuration is invalid')
    }
    const normalized: UnderwaterTerrainCachePanelConfig = Object.freeze({
        policy: value.policy as UnderwaterTerrainCachePanelPolicy,
        namespace: value.namespace,
        maxMiB: value.maxMiB as number,
        maxEntries: value.maxEntries as number,
        persistence: value.persistence as UnderwaterTerrainCachePanelConfig['persistence'],
    })
    const parameters = new URLSearchParams([
        [ 'cache', 'persistent' ],
        [ 'cacheLifecycle', 'session' ],
        [ 'cacheNamespace', normalized.namespace ],
        [ 'cacheMaxMiB', String(normalized.maxMiB) ],
        [ 'cacheMaxEntries', String(normalized.maxEntries) ],
        [ 'cachePersistence', normalized.persistence ],
    ])
    readUnderwaterTerrainCachePolicy(parameters)
    return normalized
}

function panelConfigFromPolicy(
    policy: UnderwaterTerrainCachePolicy
): UnderwaterTerrainCachePanelConfig {

    if (policy.mode === 'none') return UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG
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

function lifecycleValue(policy: Exclude<UnderwaterTerrainCachePanelPolicy, 'disabled'>): string {

    switch (policy) {
        case 'session': return 'session'
        case 'durable': return 'durable-reuse'
        case 'clear-on-open': return 'durable-clear-before-open'
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
