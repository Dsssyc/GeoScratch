export const DEM_RENDERING_PREFERENCE_STORAGE_KEY =
    'geoscratch.examples.demLayer.rendering.v1'

export type DemRenderingPreference = Readonly<{
    tileWireframe: boolean
}>

type DemRenderingPreferenceResolution = Readonly<{
    preference: DemRenderingPreference
    storageStatus: 'missing' | 'valid' | 'invalid'
}>

const DEFAULT_PREFERENCE: DemRenderingPreference = Object.freeze({
    tileWireframe: false,
})

export function resolveDemRenderingPreference(
    serialized: string | null
): DemRenderingPreferenceResolution {

    if (serialized === null) {
        return Object.freeze({
            preference: DEFAULT_PREFERENCE,
            storageStatus: 'missing',
        })
    }
    try {
        const stored = normalizeStoredPreference(JSON.parse(serialized) as unknown)
        return Object.freeze({
            preference: Object.freeze({ tileWireframe: stored.tileWireframe }),
            storageStatus: 'valid',
        })
    } catch {
        return Object.freeze({
            preference: DEFAULT_PREFERENCE,
            storageStatus: 'invalid',
        })
    }
}

export function serializeDemRenderingPreference(
    preference: DemRenderingPreference
): string {

    const normalized = normalizePreference(preference)
    return JSON.stringify({
        version: 1,
        tileWireframe: normalized.tileWireframe,
    })
}

function normalizeStoredPreference(value: unknown): DemRenderingPreference {

    if (!isRecord(value) || value.version !== 1 ||
        typeof value.tileWireframe !== 'boolean') {
        throw new TypeError('DEM rendering preference version is invalid')
    }
    if (Object.keys(value).some(key => key !== 'version' && key !== 'tileWireframe')) {
        throw new TypeError('DEM rendering preference contains unknown fields')
    }
    return Object.freeze({ tileWireframe: value.tileWireframe })
}

function normalizePreference(value: unknown): DemRenderingPreference {

    if (!isRecord(value) || typeof value.tileWireframe !== 'boolean') {
        throw new TypeError('DEM rendering preference tileWireframe must be boolean')
    }
    if (Object.keys(value).some(key => key !== 'tileWireframe')) {
        throw new TypeError('DEM rendering preference contains unknown fields')
    }
    return Object.freeze({ tileWireframe: value.tileWireframe })
}

function isRecord(value: unknown): value is Record<string, unknown> {

    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
