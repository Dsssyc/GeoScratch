import type { PersistentCacheLifecycle } from 'geoscratch/scratch'
import type { DemCachePolicy } from './dem-tile-protocol.ts'

const DEFAULT_NAMESPACE = 'geoscratch-dem-webmercator-raw-v2'
const DEFAULT_MAX_MIB = 128
const DEFAULT_MAX_ENTRIES = 2048
const MAX_MIB = 4096
const MAX_ENTRIES = 65_536
const MEBIBYTE = 1024 * 1024
const CACHE_PARAMETERS = Object.freeze(new Set([
    'cache',
    'cacheNamespace',
    'cacheLifecycle',
    'cacheMaxMiB',
    'cacheMaxEntries',
    'cachePersistence',
]))

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

    const namespace = parameters.get('cacheNamespace') ?? DEFAULT_NAMESPACE
    if (namespace.length === 0) throw new TypeError('DEM cache namespace must not be empty')
    const maxMiB = boundedInteger(
        parameters.get('cacheMaxMiB'),
        DEFAULT_MAX_MIB,
        1,
        MAX_MIB,
        'cacheMaxMiB'
    )
    const maxEntries = boundedInteger(
        parameters.get('cacheMaxEntries'),
        DEFAULT_MAX_ENTRIES,
        1,
        MAX_ENTRIES,
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
        case 'session':
            return Object.freeze({ kind: 'session' })
        case 'durable-reuse':
            return Object.freeze({ kind: 'durable', open: 'reuse' })
        case 'durable-clear-before-open':
            return Object.freeze({ kind: 'durable', open: 'clear-before-open' })
        default:
            throw new TypeError(`Unsupported DEM cache lifecycle: ${value}`)
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
        if (!CACHE_PARAMETERS.has(name)) throw new TypeError(`Unsupported DEM cache option: ${name}`)
        if (seen.has(name)) throw new TypeError(`Duplicate DEM cache option: ${name}`)
        seen.add(name)
    }
}
