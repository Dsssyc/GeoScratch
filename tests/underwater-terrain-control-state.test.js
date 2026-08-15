import { expect } from 'chai'
import {
    readUnderwaterTerrainCachePolicy,
} from '../examples/underwaterTerrain/cache-policy.ts'
import {
    UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
    UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY,
    UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY,
    removeUnderwaterTerrainCacheParameters,
    replaceUnderwaterTerrainCacheParameters,
    resolveUnderwaterTerrainRenderingPreference,
    resolveUnderwaterTerrainCachePanelConfig,
    serializeUnderwaterTerrainCachePanelConfig,
    serializeUnderwaterTerrainRenderingPreference,
} from '../examples/underwaterTerrain/control-state.ts'
import { prepareUnderwaterTerrainControlPanel } from '../examples/underwaterTerrain/control-panel.ts'

describe('Underwater Terrain control state', () => {

    describe('Underwater Terrain cache panel configuration', () => {

        it('uses the existing no-cache defaults without URL or stored state', () => {

            const resolved = resolveUnderwaterTerrainCachePanelConfig(new URLSearchParams(), null)

            expect(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY).to.equal(
                'geoscratch.examples.underwaterTerrain.cache-panel.v1'
            )
            expect(resolved.source).to.equal('default')
            expect(resolved.storageStatus).to.equal('missing')
            expect(resolved.config).to.deep.equal(UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG)
            expect(resolved.parameters.toString()).to.equal('')
            expect(readUnderwaterTerrainCachePolicy(resolved.parameters)).to.deep.equal({
                mode: 'none',
            })
        })

        it('restores a complete versioned preference for a bare URL', () => {

            const stored = serializeUnderwaterTerrainCachePanelConfig({
                policy: 'durable',
                namespace: 'editable-dem',
                maxMiB: 512,
                maxEntries: 8192,
                persistence: 'request',
            })
            const resolved = resolveUnderwaterTerrainCachePanelConfig(
                new URLSearchParams('tileServer=http%3A%2F%2Flocalhost%3A8787&atlasPages=32'),
                stored
            )

            expect(JSON.parse(stored)).to.deep.equal({
                schemaVersion: 1,
                config: {
                    policy: 'durable',
                    namespace: 'editable-dem',
                    maxMiB: 512,
                    maxEntries: 8192,
                    persistence: 'request',
                },
            })
            expect(resolved.source).to.equal('storage')
            expect(resolved.storageStatus).to.equal('valid')
            expect(resolved.config.policy).to.equal('durable')
            expect(resolved.parameters.get('tileServer')).to.equal('http://localhost:8787')
            expect(resolved.parameters.get('atlasPages')).to.equal('32')
            expect(readUnderwaterTerrainCachePolicy(resolved.parameters)).to.deep.equal({
                mode: 'persistent',
                namespace: 'editable-dem',
                maxPayloadBytes: 512 * 1024 * 1024,
                maxEntries: 8192,
                requestPersistence: true,
                lifecycle: { kind: 'durable', open: 'reuse' },
            })
        })

        it('treats any explicit cache URL state as authoritative', () => {

            const stored = serializeUnderwaterTerrainCachePanelConfig({
                ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                policy: 'durable',
            })
            const explicit = resolveUnderwaterTerrainCachePanelConfig(
                new URLSearchParams('cache=none&atlasPages=16'),
                stored
            )

            expect(explicit.source).to.equal('url')
            expect(explicit.storageStatus).to.equal('valid')
            expect(explicit.config.policy).to.equal('disabled')
            expect(explicit.parameters.toString()).to.equal('cache=none&atlasPages=16')
            expect(() => resolveUnderwaterTerrainCachePanelConfig(
                new URLSearchParams('cacheLifecycle=session'),
                stored
            )).to.throw('cache=none cannot accept cacheLifecycle')
            expect(() => resolveUnderwaterTerrainCachePanelConfig(
                new URLSearchParams('cache=none&cache=none'),
                stored
            )).to.throw('Duplicate Underwater Terrain cache option: cache')
        })

        it('maps every panel policy into the existing strict query contract', () => {

            const expected = [
                [ 'disabled', { mode: 'none' } ],
                [ 'session', {
                    mode: 'persistent',
                    lifecycle: { kind: 'session' },
                } ],
                [ 'durable', {
                    mode: 'persistent',
                    lifecycle: { kind: 'durable', open: 'reuse' },
                } ],
                [ 'clear-on-open', {
                    mode: 'persistent',
                    lifecycle: { kind: 'durable', open: 'clear-before-open' },
                } ],
            ]
            for (const [ policy, facts ] of expected) {
                const parameters = replaceUnderwaterTerrainCacheParameters(
                    new URLSearchParams('proof=1'),
                    { ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG, policy }
                )
                expect(parameters.get('proof')).to.equal('1')
                expect(readUnderwaterTerrainCachePolicy(parameters)).to.deep.include(facts)
                if (policy === 'disabled') {
                    expect(parameters.toString()).to.equal('proof=1&cache=none')
                } else {
                    expect([ ...parameters.keys() ].filter(key => key.startsWith('cache')))
                        .to.deep.equal([
                            'cache',
                            'cacheLifecycle',
                            'cacheNamespace',
                            'cacheMaxMiB',
                            'cacheMaxEntries',
                            'cachePersistence',
                        ])
                }
            }
        })

        it('rejects invalid drafts and safely ignores damaged stored state', () => {

            for (const invalid of [
                '{',
                JSON.stringify({ schemaVersion: 2, config: UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG }),
                JSON.stringify({ schemaVersion: 1, config: {
                    ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                    maxMiB: 0,
                } }),
                JSON.stringify({ schemaVersion: 1, config: {
                    ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                    policy: 'forever',
                } }),
            ]) {
                const resolved = resolveUnderwaterTerrainCachePanelConfig(new URLSearchParams(), invalid)
                expect(resolved.source).to.equal('default')
                expect(resolved.storageStatus).to.equal('invalid')
                expect(resolved.config).to.deep.equal(UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG)
            }
            expect(() => serializeUnderwaterTerrainCachePanelConfig({
                ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                namespace: '',
            })).to.throw('namespace')
            expect(() => replaceUnderwaterTerrainCacheParameters(new URLSearchParams(), {
                ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                maxEntries: 65_537,
            })).to.throw('cacheMaxEntries')
        })

        it('replaces and removes only cache query parameters', () => {

            const current = new URLSearchParams([
                [ 'tileServer', 'http://localhost:8787' ],
                [ 'cache', 'persistent' ],
                [ 'cacheLifecycle', 'session' ],
                [ 'proof', '1' ],
                [ 'cacheNamespace', 'old' ],
            ])
            const next = replaceUnderwaterTerrainCacheParameters(current, {
                policy: 'clear-on-open',
                namespace: 'new-dem',
                maxMiB: 256,
                maxEntries: 4096,
                persistence: 'best-effort',
            })

            expect(current.get('cacheNamespace')).to.equal('old')
            expect(next.get('tileServer')).to.equal('http://localhost:8787')
            expect(next.get('proof')).to.equal('1')
            expect(next.get('cacheLifecycle')).to.equal('durable-clear-before-open')
            expect(next.get('cacheNamespace')).to.equal('new-dem')
            expect(next.get('cacheMaxMiB')).to.equal('256')
            expect(next.get('cacheMaxEntries')).to.equal('4096')
            expect(next.get('cachePersistence')).to.equal('best-effort')
            expect(removeUnderwaterTerrainCacheParameters(next).toString()).to.equal(
                'tileServer=http%3A%2F%2Flocalhost%3A8787&proof=1'
            )
        })

        it('prepares browser preferences and degrades unavailable local storage', () => {

            const stored = serializeUnderwaterTerrainCachePanelConfig({
                ...UNDERWATER_TERRAIN_CACHE_PANEL_DEFAULT_CONFIG,
                policy: 'session',
            })
            const available = fakeStorage({
                [UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY]: stored,
            })
            const restored = prepareUnderwaterTerrainControlPanel({
                parameters: new URLSearchParams('proof=1'),
                storage: available.storage,
            })

            expect(restored.source).to.equal('storage')
            expect(restored.storageStatus).to.equal('valid')
            expect(restored.parameters.get('proof')).to.equal('1')
            expect(restored.parameters.get('cacheLifecycle')).to.equal('session')

            available.storage.setItem(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY, '{')
            const damaged = prepareUnderwaterTerrainControlPanel({
                parameters: new URLSearchParams(),
                storage: available.storage,
            })
            expect(damaged.source).to.equal('default')
            expect(damaged.storageStatus).to.equal('invalid')
            expect(available.storage.getItem(UNDERWATER_TERRAIN_CACHE_PANEL_STORAGE_KEY)).to.equal(null)

            const unavailable = prepareUnderwaterTerrainControlPanel({
                parameters: new URLSearchParams('cache=none'),
                storage: {
                    getItem: () => null,
                    setItem: () => { throw new DOMException('denied', 'SecurityError') },
                    removeItem: () => {},
                },
            })
            expect(unavailable.source).to.equal('url')
            expect(unavailable.storageStatus).to.equal('unavailable')
            expect(unavailable.config.policy).to.equal('disabled')
        })
    })

    describe('Underwater Terrain rendering preference', () => {

        it('defaults to shaded terrain without stored state', () => {

            expect(UNDERWATER_TERRAIN_RENDERING_PREFERENCE_STORAGE_KEY).to.equal(
                'geoscratch.examples.underwaterTerrain.rendering.v1'
            )
            expect(resolveUnderwaterTerrainRenderingPreference(null)).to.deep.equal({
                preference: { tileWireframe: false },
                storageStatus: 'missing',
            })
        })

        it('round trips a strict versioned tile-wireframe preference', () => {

            const stored = serializeUnderwaterTerrainRenderingPreference({ tileWireframe: true })

            expect(stored).to.equal('{"version":1,"tileWireframe":true}')
            expect(resolveUnderwaterTerrainRenderingPreference(stored)).to.deep.equal({
                preference: { tileWireframe: true },
                storageStatus: 'valid',
            })
        })

        it('falls back safely for malformed or structurally invalid state', () => {

            for (const stored of [
                '{',
                '{"version":2,"tileWireframe":true}',
                '{"version":1,"tileWireframe":"yes"}',
                '{"version":1,"tileWireframe":true,"extra":1}',
                'null',
            ]) {
                expect(resolveUnderwaterTerrainRenderingPreference(stored)).to.deep.equal({
                    preference: { tileWireframe: false },
                    storageStatus: 'invalid',
                })
            }
            expect(() => serializeUnderwaterTerrainRenderingPreference({ tileWireframe: 'yes' }))
                .to.throw('tileWireframe')
        })
    })

    it('keeps DEM disk caching explicit and application configurable', () => {

        expect(readUnderwaterTerrainCachePolicy(new URLSearchParams())).to.deep.equal({
            mode: 'none',
        })
        expect(readUnderwaterTerrainCachePolicy(
            new URLSearchParams('cache=persistent')
        )).to.deep.equal({
            mode: 'persistent',
            namespace: 'geoscratch-dem-webmercator-raw-v2',
            maxPayloadBytes: 128 * 1024 * 1024,
            maxEntries: 2048,
            requestPersistence: false,
            lifecycle: { kind: 'session' },
        })
        expect(readUnderwaterTerrainCachePolicy(new URLSearchParams([
            [ 'cache', 'persistent' ],
            [ 'cacheNamespace', 'editable-dem' ],
            [ 'cacheLifecycle', 'durable-reuse' ],
            [ 'cacheMaxMiB', '512' ],
            [ 'cacheMaxEntries', '8192' ],
            [ 'cachePersistence', 'request' ],
        ]))).to.deep.equal({
            mode: 'persistent',
            namespace: 'editable-dem',
            maxPayloadBytes: 512 * 1024 * 1024,
            maxEntries: 8192,
            requestPersistence: true,
            lifecycle: { kind: 'durable', open: 'reuse' },
        })
        expect(readUnderwaterTerrainCachePolicy(new URLSearchParams(
            'cache=persistent&cacheLifecycle=durable-clear-before-open'
        )).lifecycle).to.deep.equal({ kind: 'durable', open: 'clear-before-open' })
    })

    it('rejects ignored or unbounded DEM cache configuration', () => {

        for (const query of [
            'cache=none&cacheNamespace=ignored',
            'cache=persistent&cacheLifecycle=unknown',
            'cache=persistent&cacheMaxMiB=0',
            'cache=persistent&cacheMaxEntries=65537',
            'cache=persistent&cachePersistence=forever',
            'cache=persistent&cacheUnknown=1',
            'cache=persistent&cacheLifecycle=session&cacheLifecycle=session',
        ]) {
            expect(() => readUnderwaterTerrainCachePolicy(new URLSearchParams(query))).to.throw()
        }
    })
})

function fakeStorage(initial = {}) {

    const values = new Map(Object.entries(initial))
    return {
        values,
        storage: {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
            removeItem: key => values.delete(key),
        },
    }
}
