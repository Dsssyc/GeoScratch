import { workerDiagnosticError } from './diagnostics.js'
import type { WorkerModuleContract } from './module.js'
import { isWorkerModuleContract, validWorkerModuleIdentity } from './module.js'
import type { WorkerModuleDescriptor, WorkerModuleResolver } from './worker-system.js'

export type WorkerModuleArtifactSourceMap = Readonly<{
    url: string
    byteLength: number
    sha256: string
}>

export type WorkerModuleArtifact = Readonly<{
    id: string
    version: string
    url: string
    byteLength: number
    sha256: string
    sourceMap?: WorkerModuleArtifactSourceMap
}>

export type WorkerModuleManifest = Readonly<{
    kind: 'geoscratch-worker-module-manifest'
    schemaVersion: 1
    modules: readonly WorkerModuleArtifact[]
}>

export type WorkerModuleCatalogFacts = Readonly<{
    kind: 'worker-module-catalog'
    manifestUrl: string
    moduleCount: number
}>

export type WorkerModuleCatalogLoadOptions = Readonly<{
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    signal?: AbortSignal
}>

type ResolvedArtifact = Readonly<{
    artifact: WorkerModuleArtifact
    url: URL
}>

/** Resolves typed Worker contracts to immutable standalone artifacts from one manifest. */
export class WorkerModuleCatalog implements WorkerModuleResolver {

    readonly #manifestUrl: URL
    readonly #artifacts: ReadonlyMap<string, ResolvedArtifact>

    private constructor(manifest: WorkerModuleManifest, manifestUrl: URL) {

        this.#manifestUrl = new URL(manifestUrl.href)
        this.#artifacts = new Map(manifest.modules.map(artifact => [
            moduleKey(artifact.id, artifact.version),
            Object.freeze({ artifact, url: new URL(artifact.url, manifestUrl) }),
        ]))
        Object.freeze(this)
    }

    static fromManifest(manifest: unknown, manifestUrl: URL): WorkerModuleCatalog {

        if (!(manifestUrl instanceof URL)) {
            return invalidManifest('A Worker module manifest requires an absolute manifest URL.', {
                manifestUrl,
            })
        }
        const capturedManifestUrl = new URL(manifestUrl.href)
        return new WorkerModuleCatalog(
            parseWorkerModuleManifest(manifest, capturedManifestUrl),
            capturedManifestUrl
        )
    }

    static async load(
        manifestUrl: URL,
        options: WorkerModuleCatalogLoadOptions = {}
    ): Promise<WorkerModuleCatalog> {

        if (!(manifestUrl instanceof URL)) {
            return invalidManifest('A Worker module manifest requires an absolute manifest URL.', {
                manifestUrl,
            })
        }
        const capturedManifestUrl = new URL(manifestUrl.href)
        const fetchManifest = options.fetch ?? globalThis.fetch
        if (typeof fetchManifest !== 'function') {
            return invalidManifest('Worker module manifest loading requires fetch.', {
                manifestUrl: manifestUrl.href,
            })
        }
        let response: Response
        try {
            response = await fetchManifest(capturedManifestUrl, {
                cache: 'no-cache',
                credentials: 'same-origin',
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            })
        } catch (error) {
            throw manifestFetchError(capturedManifestUrl, error)
        }
        if (!response.ok) {
            throw manifestFetchError(capturedManifestUrl, new Error(`HTTP ${response.status}`))
        }
        let manifest: unknown
        try {
            manifest = await response.json()
        } catch (error) {
            throw manifestFetchError(capturedManifestUrl, error)
        }
        return WorkerModuleCatalog.fromManifest(manifest, capturedManifestUrl)
    }

    resolve(contract: WorkerModuleContract): WorkerModuleDescriptor {

        if (!isWorkerModuleContract(contract)) {
            return missingModule('Worker module resolution requires a contract.', contract)
        }
        const resolved = this.#artifacts.get(moduleKey(contract.id, contract.version))
        if (resolved === undefined) {
            return missingModule(
                `Worker module ${contract.id}@${contract.version} is absent from the catalog.`,
                { id: contract.id, version: contract.version, manifestUrl: this.#manifestUrl.href }
            )
        }
        return Object.freeze({
            id: contract.id,
            version: contract.version,
            url: new URL(resolved.url.href),
        })
    }

    inspect(): WorkerModuleCatalogFacts {

        return Object.freeze({
            kind: 'worker-module-catalog',
            manifestUrl: this.#manifestUrl.href,
            moduleCount: this.#artifacts.size,
        })
    }
}

function parseWorkerModuleManifest(value: unknown, manifestUrl: URL): WorkerModuleManifest {

    if (!record(value) || !exactKeys(value, [ 'kind', 'schemaVersion', 'modules' ]) ||
        value.kind !== 'geoscratch-worker-module-manifest' ||
        value.schemaVersion !== 1 || !Array.isArray(value.modules)) {
        return invalidManifest('Worker module manifest envelope is invalid.', {
            manifestUrl: manifestUrl.href,
            manifest: value,
        })
    }
    const identities = new Set<string>()
    const modules = value.modules.map((candidate, index) => {
        if (!record(candidate) || !allowedArtifactKeys(candidate) ||
            typeof candidate.url !== 'string' || candidate.url.length === 0 ||
            !positiveSafeInteger(candidate.byteLength) || !sha256(candidate.sha256)) {
            return invalidManifest(`Worker module manifest entry ${index} is invalid.`, candidate)
        }
        if (!validWorkerModuleIdentity(candidate.id, candidate.version)) {
            return invalidManifest(`Worker module manifest entry ${index} is invalid.`, candidate)
        }
        const id = candidate.id as string
        const version = candidate.version as string
        validateArtifactUrl(candidate.url, manifestUrl, `Worker module manifest entry ${index}`)
        const key = moduleKey(id, version)
        if (identities.has(key)) {
            return invalidManifest(
                `Worker module manifest identity ${id}@${version} is duplicated.`,
                candidate
            )
        }
        identities.add(key)
        const sourceMap = candidate.sourceMap === undefined
            ? undefined
            : parseSourceMap(candidate.sourceMap, manifestUrl, index)
        return Object.freeze({
            id,
            version,
            url: candidate.url,
            byteLength: candidate.byteLength,
            sha256: candidate.sha256,
            ...(sourceMap === undefined ? {} : { sourceMap }),
        })
    })
    return Object.freeze({
        kind: 'geoscratch-worker-module-manifest',
        schemaVersion: 1,
        modules: Object.freeze(modules),
    })
}

function parseSourceMap(value: unknown, manifestUrl: URL, index: number): WorkerModuleArtifactSourceMap {

    if (!record(value) || !exactKeys(value, [ 'url', 'byteLength', 'sha256' ]) ||
        typeof value.url !== 'string' || value.url.length === 0 ||
        !positiveSafeInteger(value.byteLength) || !sha256(value.sha256)) {
        return invalidManifest(`Worker module source map ${index} is invalid.`, value)
    }
    validateArtifactUrl(value.url, manifestUrl, `Worker module source map ${index}`)
    return Object.freeze({
        url: value.url,
        byteLength: value.byteLength,
        sha256: value.sha256,
    })
}

function validateArtifactUrl(value: string, manifestUrl: URL, label: string): void {

    if (!value.startsWith('./')) {
        return invalidManifest(`${label} URL must be relative to the manifest directory.`, value)
    }
    try {
        const directory = new URL('./', manifestUrl)
        const resolved = new URL(value, manifestUrl)
        if (resolved.origin !== directory.origin ||
            !resolved.pathname.startsWith(directory.pathname) ||
            resolved.search.length > 0 || resolved.hash.length > 0) {
            return invalidManifest(`${label} URL must remain inside the manifest directory.`, value)
        }
    } catch (error) {
        return invalidManifest(`${label} URL is invalid.`, value, error)
    }
}

function allowedArtifactKeys(value: Record<string, unknown>): boolean {

    const keys = Object.keys(value)
    return keys.every(key => [ 'id', 'version', 'url', 'byteLength', 'sha256', 'sourceMap' ].includes(key)) &&
        [ 'id', 'version', 'url', 'byteLength', 'sha256' ].every(key => keys.includes(key))
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {

    const keys = Object.keys(value)
    return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function record(value: unknown): value is Record<string, unknown> {

    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && (value as number) > 0
}

function sha256(value: unknown): value is string {

    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function moduleKey(id: string, version: string): string {

    return `${id}\u0000${version}`
}

function invalidManifest(
    message: string,
    actual: unknown,
    cause?: unknown
): never {

    throw workerDiagnosticError({
        code: 'WORKER_MANIFEST_INVALID',
        severity: 'error',
        phase: 'worker-module',
        subject: { kind: 'WorkerModule', id: 'manifest' },
        message,
        expected: {
            kind: 'geoscratch-worker-module-manifest',
            schemaVersion: 1,
            identity: '(id, version)',
            contentHash: 'sha256',
        },
        actual,
        retriable: false,
    }, cause)
}

function manifestFetchError(manifestUrl: URL, cause: unknown): Error {

    return workerDiagnosticError({
        code: 'WORKER_MANIFEST_FETCH_FAILED',
        severity: 'error',
        phase: 'worker-module',
        subject: { kind: 'WorkerModule', id: 'manifest' },
        message: `Worker module manifest ${manifestUrl.href} could not be loaded.`,
        actual: cause instanceof Error ? cause.message : String(cause),
        retriable: true,
    }, cause)
}

function missingModule(message: string, actual: unknown): never {

    throw workerDiagnosticError({
        code: 'WORKER_MODULE_NOT_FOUND',
        severity: 'error',
        phase: 'worker-module',
        subject: { kind: 'WorkerModule', id: 'catalog' },
        message,
        actual,
        hints: [ 'Build the module into the catalog or provide a matching catalog.' ],
        retriable: false,
    })
}
