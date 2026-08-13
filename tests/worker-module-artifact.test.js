import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    WorkerModuleCatalog,
    WorkerSystem,
    defineWorkerModuleBuild,
    defineWorkerModuleContract,
} from 'geoscratch/scratch'

const HASH = '0123456789abcdef'.repeat(4)

describe('Worker module artifacts', () => {

    it('uses one immutable contract for implementation and deployment identity', () => {

        const identity = { id: 'fixture.worker', version: '3' }
        const contract = defineWorkerModuleContract(identity)
        identity.id = 'mutated.worker'
        identity.version = '4'
        const implementation = contract.implement({
            id: 'forged.worker',
            version: '99',
            operations: {
                echo(input) {

                    return input
                },
            },
        })

        expect(contract).to.deep.include({
            kind: 'worker-module-contract',
            id: 'fixture.worker',
            version: '3',
        })
        expect(Object.isFrozen(contract)).to.equal(true)
        expect(implementation).to.deep.include({ id: contract.id, version: contract.version })
        expect(Object.isFrozen(implementation)).to.equal(true)
    })

    it('snapshots a contract identity exactly once', () => {

        let idReads = 0
        let versionReads = 0
        const contract = defineWorkerModuleContract({
            get id() {

                idReads += 1
                return idReads === 1 ? 'fixture.worker' : 'mutated.worker'
            },
            get version() {

                versionReads += 1
                return versionReads === 1 ? '3' : '4'
            },
        })

        expect(contract).to.deep.include({ id: 'fixture.worker', version: '3' })
        expect(idReads).to.equal(1)
        expect(versionReads).to.equal(1)
    })

    it('resolves a contract through a strict manifest relative to the manifest URL', () => {

        const contract = defineWorkerModuleContract({ id: 'fixture.worker', version: '3' })
        const catalog = WorkerModuleCatalog.fromManifest({
            kind: 'geoscratch-worker-module-manifest',
            schemaVersion: 1,
            modules: [ {
                id: contract.id,
                version: contract.version,
                url: './fixture.worker-ABC123.js',
                byteLength: 321,
                sha256: HASH,
            } ],
        }, new URL('https://example.test/assets/workers/manifest.json'))

        expect(catalog.resolve(contract)).to.deep.equal({
            id: contract.id,
            version: contract.version,
            url: new URL('https://example.test/assets/workers/fixture.worker-ABC123.js'),
        })
        expect(catalog.inspect()).to.deep.include({
            kind: 'worker-module-catalog',
            moduleCount: 1,
            manifestUrl: 'https://example.test/assets/workers/manifest.json',
        })
    })

    it('loads a manifest explicitly without owning application lifecycle', async() => {

        const requested = []
        const contract = defineWorkerModuleContract({ id: 'fixture.worker', version: '3' })
        const catalog = await WorkerModuleCatalog.load(
            new URL('https://example.test/workers/manifest.json'),
            {
                fetch: async(url, init) => {

                    requested.push({ url: String(url), init })
                    return new Response(JSON.stringify({
                        kind: 'geoscratch-worker-module-manifest',
                        schemaVersion: 1,
                        modules: [ {
                            id: contract.id,
                            version: contract.version,
                            url: './fixture.js',
                            byteLength: 64,
                            sha256: HASH,
                        } ],
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    })
                },
            }
        )

        expect(catalog.resolve(contract).url.href)
            .to.equal('https://example.test/workers/fixture.js')
        expect(requested).to.deep.equal([ {
            url: 'https://example.test/workers/manifest.json',
            init: { cache: 'no-cache', credentials: 'same-origin' },
        } ])
    })

    it('snapshots the manifest URL across asynchronous loading', async() => {

        let releaseFetch
        const fetchGate = new Promise(resolve => { releaseFetch = resolve })
        const manifestUrl = new URL('https://example.test/workers/manifest.json')
        const contract = defineWorkerModuleContract({ id: 'fixture.worker', version: '3' })
        const loading = WorkerModuleCatalog.load(manifestUrl, {
            fetch: async() => {

                await fetchGate
                return new Response(JSON.stringify({
                    kind: 'geoscratch-worker-module-manifest',
                    schemaVersion: 1,
                    modules: [ {
                        id: contract.id,
                        version: contract.version,
                        url: './fixture.js',
                        byteLength: 64,
                        sha256: HASH,
                    } ],
                }))
            },
        })
        manifestUrl.pathname = '/mutated/manifest.json'
        releaseFetch()
        const catalog = await loading

        expect(catalog.inspect().manifestUrl)
            .to.equal('https://example.test/workers/manifest.json')
        expect(catalog.resolve(contract).url.href)
            .to.equal('https://example.test/workers/fixture.js')
    })

    it('rejects invalid manifests and missing exact contract versions diagnostically', () => {

        const entry = {
            id: 'fixture.worker',
            version: '3',
            url: './fixture.js',
            byteLength: 64,
            sha256: HASH,
        }
        expectDiagnostic(() => WorkerModuleCatalog.fromManifest({
            kind: 'geoscratch-worker-module-manifest',
            schemaVersion: 1,
            modules: [ entry, entry ],
        }, new URL('https://example.test/workers/manifest.json')), 'WORKER_MANIFEST_INVALID')
        for (const url of [ '../outside.js', '/absolute.js', 'https://other.test/worker.js' ]) {
            expectDiagnostic(() => WorkerModuleCatalog.fromManifest({
                kind: 'geoscratch-worker-module-manifest',
                schemaVersion: 1,
                modules: [ { ...entry, url } ],
            }, new URL('https://example.test/workers/manifest.json')), 'WORKER_MANIFEST_INVALID')
        }

        const catalog = WorkerModuleCatalog.fromManifest({
            kind: 'geoscratch-worker-module-manifest',
            schemaVersion: 1,
            modules: [ entry ],
        }, new URL('https://example.test/workers/manifest.json'))
        expectDiagnostic(() => catalog.resolve(
            defineWorkerModuleContract({ id: entry.id, version: '4' })
        ), 'WORKER_MODULE_NOT_FOUND')
    })

    it('defines a build registry without repeating contract identity', () => {

        const contract = defineWorkerModuleContract({ id: 'fixture.worker', version: '3' })
        const build = defineWorkerModuleBuild({
            outDir: './public/workers',
            modules: [ { contract, entry: './src/fixture.worker.ts' } ],
        })

        expect(build.modules[0]).to.deep.equal({
            contract,
            entry: './src/fixture.worker.ts',
        })
        expect(Object.isFrozen(build)).to.equal(true)
        expect(Object.isFrozen(build.modules)).to.equal(true)
    })

    it('lets WorkerSystem resolve contracts while preserving explicit construction', async() => {

        const contract = defineWorkerModuleContract({ id: 'fixture.worker', version: '3' })
        const catalog = WorkerModuleCatalog.fromManifest({
            kind: 'geoscratch-worker-module-manifest',
            schemaVersion: 1,
            modules: [ {
                id: contract.id,
                version: contract.version,
                url: './fixture.js',
                byteLength: 64,
                sha256: HASH,
            } ],
        }, new URL('https://example.test/workers/manifest.json'))
        const endpoints = []
        const system = new WorkerSystem({
            maxWorkers: 1,
            moduleResolver: catalog,
            workerFactory: () => {

                const listeners = new Map()
                const endpoint = {
                    postMessage(message) {

                        if (message.kind === 'initialize') {
                            queueMicrotask(() => listeners.get('message')?.({
                                data: { kind: 'ready', hostId: message.hostId },
                            }))
                        }
                    },
                    terminate() {},
                    addEventListener(type, listener) { listeners.set(type, listener) },
                    removeEventListener(type) { listeners.delete(type) },
                }
                endpoints.push(endpoint)
                return endpoint
            },
        })
        const group = system.createGroup({
            id: 'contract-group',
            modules: [ contract ],
            isolation: 'group',
            size: { min: 1, max: 1 },
            maxQueuedTasks: 1,
            maxActiveTasks: 1,
            idleTimeoutMs: 0,
        })
        await group.ready

        expect(group.options.modules[0]).to.deep.equal({
            id: contract.id,
            version: contract.version,
            url: new URL('https://example.test/workers/fixture.js'),
        })
        expect(endpoints).to.have.length(1)
        await system.dispose()
    })

    it('rejects a malformed module resolver diagnostically', () => {

        expectDiagnostic(() => new WorkerSystem({ moduleResolver: {} }), 'WORKER_DESCRIPTOR_INVALID')
    })
})

function expectDiagnostic(operation, code) {

    try {
        operation()
        expect.fail(`Expected ${code}`)
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.deep.include({ domain: 'worker', code })
    }
}
