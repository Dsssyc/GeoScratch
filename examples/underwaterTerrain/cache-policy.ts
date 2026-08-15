import type { PersistentCacheLifecycle } from 'geoscratch/scratch'

export type UnderwaterTerrainCachePolicy =
    | Readonly<{ mode: 'none' }>
    | Readonly<{
        mode: 'persistent'
        namespace: string
        maxPayloadBytes: number
        maxEntries: number
        requestPersistence: boolean
        lifecycle: PersistentCacheLifecycle
    }>

const MEBIBYTE = 1024 * 1024

export const UNDERWATER_TERRAIN_CACHE_DEFAULTS = Object.freeze({
    namespace: 'geoscratch-dem-webmercator-raw-v2',
    maxMiB: 128,
    maxEntries: 2048,
    persistence: 'best-effort' as const,
    lifecycle: 'session' as const,
})

export const UNDERWATER_TERRAIN_CACHE_LIMITS = Object.freeze({
    minMiB: 1,
    maxMiB: 4096,
    minEntries: 1,
    maxEntries: 65_536,
})

export const UNDERWATER_TERRAIN_CACHE_PARAMETER_NAMES = Object.freeze([
    'cache',
    'cacheLifecycle',
    'cacheNamespace',
    'cacheMaxMiB',
    'cacheMaxEntries',
    'cachePersistence',
] as const)

const CACHE_PARAMETERS = Object.freeze(
    new Set<string>(UNDERWATER_TERRAIN_CACHE_PARAMETER_NAMES)
)

export function readUnderwaterTerrainCachePolicy(
    parameters: URLSearchParams
): UnderwaterTerrainCachePolicy {

    assertKnownParameters(parameters)
    const mode = parameters.get('cache') ?? 'none'
    if (mode === 'none') {
        const ignored = [ ...CACHE_PARAMETERS ].filter(name =>
            name !== 'cache' && parameters.has(name)
        )
        if (ignored.length > 0) {
            throw new TypeError(
                `Underwater Terrain cache=none cannot accept ${ignored.join(', ')}`
            )
        }
        return Object.freeze({ mode: 'none' })
    }
    if (mode !== 'persistent') {
        throw new TypeError(`Unsupported Underwater Terrain cache mode: ${mode}`)
    }

    const namespace = parameters.get('cacheNamespace') ??
        UNDERWATER_TERRAIN_CACHE_DEFAULTS.namespace
    if (namespace.length === 0) {
        throw new TypeError('Underwater Terrain cache namespace must not be empty')
    }
    const maxMiB = boundedInteger(
        parameters.get('cacheMaxMiB'),
        UNDERWATER_TERRAIN_CACHE_DEFAULTS.maxMiB,
        UNDERWATER_TERRAIN_CACHE_LIMITS.minMiB,
        UNDERWATER_TERRAIN_CACHE_LIMITS.maxMiB,
        'cacheMaxMiB'
    )
    const maxEntries = boundedInteger(
        parameters.get('cacheMaxEntries'),
        UNDERWATER_TERRAIN_CACHE_DEFAULTS.maxEntries,
        UNDERWATER_TERRAIN_CACHE_LIMITS.minEntries,
        UNDERWATER_TERRAIN_CACHE_LIMITS.maxEntries,
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

function readLifecycle(value: string | null): PersistentCacheLifecycle {

    switch (value ?? 'session') {
        case 'session': return Object.freeze({ kind: 'session' })
        case 'durable-reuse': return Object.freeze({ kind: 'durable', open: 'reuse' })
        case 'durable-clear-before-open':
            return Object.freeze({ kind: 'durable', open: 'clear-before-open' })
        default: throw new TypeError(`Unsupported Underwater Terrain cache lifecycle: ${value}`)
    }
}

function readPersistence(value: string | null): boolean {

    switch (value ?? 'best-effort') {
        case 'best-effort': return false
        case 'request': return true
        default:
            throw new TypeError(
                `Unsupported Underwater Terrain cache persistence request: ${value}`
            )
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
            throw new TypeError(`Unsupported Underwater Terrain cache option: ${name}`)
        }
        if (seen.has(name)) {
            throw new TypeError(`Duplicate Underwater Terrain cache option: ${name}`)
        }
        seen.add(name)
    }
}
