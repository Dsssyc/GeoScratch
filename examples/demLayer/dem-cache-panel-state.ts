import {
    DEM_CACHE_PARAMETER_NAMES,
    DEM_CACHE_POLICY_DEFAULTS,
    readDemCachePolicy,
} from './dem-cache-policy.ts'
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

export type DemCachePanelResolution = Readonly<{
    source: 'url' | 'storage' | 'default'
    storageStatus: 'missing' | 'valid' | 'invalid'
    config: DemCachePanelConfig
    parameters: URLSearchParams
}>

type StoredDemCachePanelConfig = Readonly<{
    schemaVersion: 1
    config: DemCachePanelConfig
}>

type StoredRead = Readonly<{
    status: DemCachePanelResolution['storageStatus']
    config?: DemCachePanelConfig
}>

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

export const DEM_CACHE_PANEL_STORAGE_KEY = 'geoscratch.examples.dem.cache-panel.v1'
export const DEM_CACHE_PANEL_DEFAULT_CONFIG: DemCachePanelConfig = Object.freeze({
    policy: 'disabled',
    namespace: DEM_CACHE_POLICY_DEFAULTS.namespace,
    maxMiB: DEM_CACHE_POLICY_DEFAULTS.maxMiB,
    maxEntries: DEM_CACHE_POLICY_DEFAULTS.maxEntries,
    persistence: DEM_CACHE_POLICY_DEFAULTS.persistence,
})

export function resolveDemCachePanelConfig(
    current: URLSearchParams,
    stored: string | null
): DemCachePanelResolution {

    const storedRead = readStoredConfig(stored)
    if (hasExplicitCacheParameters(current)) {
        const policy = readDemCachePolicy(current)
        return Object.freeze({
            source: 'url',
            storageStatus: storedRead.status,
            config: panelConfigFromPolicy(policy),
            parameters: new URLSearchParams(current),
        })
    }
    if (storedRead.status === 'valid') {
        const parameters = replaceDemCacheParameters(current, storedRead.config!)
        readDemCachePolicy(parameters)
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

    const normalized = normalizeConfig(config)
    const stored: StoredDemCachePanelConfig = Object.freeze({
        schemaVersion: 1,
        config: normalized,
    })
    return JSON.stringify(stored)
}

export function replaceDemCacheParameters(
    current: URLSearchParams,
    config: DemCachePanelConfig
): URLSearchParams {

    const normalized = normalizeConfig(config)
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

function readStoredConfig(stored: string | null): StoredRead {

    if (stored === null) return Object.freeze({ status: 'missing' })
    try {
        const value: unknown = JSON.parse(stored)
        if (!plainObject(value) || value.schemaVersion !== 1 ||
            !exactKeys(value, [ 'schemaVersion', 'config' ])) {
            return Object.freeze({ status: 'invalid' })
        }
        return Object.freeze({
            status: 'valid',
            config: normalizeConfig(value.config),
        })
    } catch {
        return Object.freeze({ status: 'invalid' })
    }
}

function normalizeConfig(value: unknown): DemCachePanelConfig {

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
    validateAdvancedFields(normalized)
    return normalized
}

function validateAdvancedFields(config: DemCachePanelConfig): void {

    const parameters = new URLSearchParams([
        [ 'cache', 'persistent' ],
        [ 'cacheLifecycle', 'session' ],
        [ 'cacheNamespace', config.namespace ],
        [ 'cacheMaxMiB', String(config.maxMiB) ],
        [ 'cacheMaxEntries', String(config.maxEntries) ],
        [ 'cachePersistence', config.persistence ],
    ])
    readDemCachePolicy(parameters)
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
