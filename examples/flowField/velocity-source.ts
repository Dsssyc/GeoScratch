import {
    WebMercatorQuad,
    createVirtualRasterRuntime,
    tileMatrixCoverage,
    webMercatorVirtualRasterField,
} from 'geoscratch/geo'
import type {
    VirtualRasterPageIdentity,
    VirtualRasterRuntime,
} from 'geoscratch/geo'
import type {
    GPURuntime,
    WorkerModuleResolver,
    WorkerSystem,
} from 'geoscratch/scratch'
import type { FlowFieldCachePolicy } from './cache-policy.ts'
import {
    flowDatasetManifestUrl,
} from './flow-dataset.ts'
import {
    createVelocityWorkerRequestExecutor,
} from './velocity-tile-executor.ts'
import type {
    FlowVelocityWorkerRequestExecutor,
} from './velocity-tile-executor.ts'
import type {
    FlowFieldDataset,
    FlowFieldRuntimePage,
    FlowFieldRuntimeRepresentation,
    FlowFieldRuntimeSample,
    FlowDatasetManifest,
    FlowVelocityPageManifest,
} from './flow-dataset.ts'

export type FlowVelocityResolvedPage = Readonly<{
    url: string
    byteLength: 524288
    sha256: string
}>

export type FlowVelocityTimeSource = Readonly<{
    sampleKey: string
    timeIndex: number
    sampleRegistration: 'global-texel-lattice'
    model: ReturnType<typeof webMercatorVirtualRasterField>
    tileUrl(page: VirtualRasterPageIdentity): string
    expectedPage(page: VirtualRasterPageIdentity): FlowVelocityPageManifest
    resolvePage(page: VirtualRasterPageIdentity):
        FlowVelocityPageManifest & FlowVelocityResolvedPage
}>

export type FlowVelocitySampleSource = Readonly<{
    sampleKey: string
    timeIndex: number
    sample: FlowFieldRuntimeSample
    sampleRegistration: 'pixel-center'
    representation: FlowFieldRuntimeRepresentation
    model: ReturnType<typeof webMercatorVirtualRasterField>
    resolvePage(page: VirtualRasterPageIdentity): FlowFieldRuntimePage
}>

type FlowVelocityTimeModel = ReturnType<typeof webMercatorVirtualRasterField>

export type FlowVelocityTimeRuntime = VirtualRasterRuntime<FlowVelocityTimeModel> & Readonly<{
    source: FlowVelocityTimeSource
    workerFacts(): ReturnType<FlowVelocityWorkerRequestExecutor['inspect']>
}>

export type FlowVelocityTimeRuntimeOptions = Readonly<{
    runtime: GPURuntime
    manifest: FlowDatasetManifest
    timeIndex: number
    cachePolicy: FlowFieldCachePolicy
    workerSystem: WorkerSystem
    workerModules: WorkerModuleResolver
    workerCount?: number
    maxNetworkRequests?: number
    maxDecodeTasks?: number
    maxRequests?: number
    maxPhysicalPages?: number
    maxStagingBytes?: number
    maxHistory?: number
}>

const DEFAULT_MAX_REQUESTS = 24
const DEFAULT_MAX_PHYSICAL_PAGES = 18
const DEFAULT_MAX_HISTORY = 64
const PAGE_BYTE_LENGTH = 256 * 256 * 2 * Float32Array.BYTES_PER_ELEMENT

/** Creates one immutable model-time velocity source from a loaded dataset manifest. */
export function createVelocityTimeSource(
    manifest: FlowDatasetManifest,
    timeIndex: number
): FlowVelocityTimeSource {

    const manifestUrl = flowDatasetManifestUrl(manifest)
    const time = manifest.times[timeIndex]
    if (!Number.isSafeInteger(timeIndex) || time === undefined || time.timeIndex !== timeIndex) {
        throw new TypeError('Flow Field velocity source requires a declared model time')
    }
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: manifest.tileMatrixSet.limits,
    })
    const timeLabel = `t${String(timeIndex).padStart(2, '0')}`
    const model = webMercatorVirtualRasterField({
        id: `flow-velocity.${timeLabel}`,
        addressSpaceId: `flow-velocity.wmq.${manifest.sourceHash.slice(0, 16)}.${timeLabel}`,
        sourceRevision: manifest.contentVersion,
        coverage,
        geographicBounds: manifest.source.geographicBounds,
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        unit: manifest.unit,
        interpolation: 'linear',
        auxiliaryAxes: [
            { name: 'model-time', value: time.modelTime },
            { name: 'vector-basis', value: manifest.basis },
        ],
    })
    const expectedPages = new Map<string, FlowVelocityPageManifest>()
    for (const page of manifest.pages) {
        if (page.timeIndex === timeIndex) expectedPages.set(pageKey(page), page)
    }
    const tileBaseUrl = new URL('./tiles/WebMercatorQuad/', manifestUrl)

    function requirePage(page: VirtualRasterPageIdentity): FlowVelocityPageManifest {

        const tile = page?.tile
        if (page?.addressSpaceId !== model.addressSpace.id || tile === undefined ||
            tile.tileMatrixSetId !== manifest.tileMatrixSet.id) {
            throw new TypeError('Flow Field velocity source requires its own WebMercatorQuad page')
        }
        const expected = expectedPages.get(pageKey({
            matrixId: tile.matrixId,
            tileRow: tile.tileRow,
            tileCol: tile.tileCol,
        }))
        if (expected === undefined) {
            throw new TypeError('Flow Field velocity page is outside declared source coverage')
        }
        return expected
    }

    function resolvePage(
        page: VirtualRasterPageIdentity
    ): FlowVelocityPageManifest & FlowVelocityResolvedPage {

        const expected = requirePage(page)
        return Object.freeze({
            ...expected,
            url: new URL(
                `${timeLabel}/${encodeURIComponent(expected.matrixId)}/` +
                `${expected.tileRow}/${expected.tileCol}.rg32f`,
                tileBaseUrl
            ).href,
        })
    }

    return Object.freeze({
        sampleKey: timeLabel,
        timeIndex,
        sampleRegistration: 'global-texel-lattice' as const,
        model,
        tileUrl(page) {

            return resolvePage(page).url
        },
        expectedPage: requirePage,
        resolvePage,
    })
}

/** Creates one immutable velocity source from a normalized runtime sample identity. */
export function createVelocitySampleSource(
    dataset: FlowFieldDataset,
    sampleKey: string
): FlowVelocitySampleSource {

    if (dataset?.kind !== 'flow-field-dataset' || dataset.schemaVersion !== 2 ||
        dataset.artifactType !== 'flow-field-cog-runtime' ||
        !/^[0-9a-f]{64}$/.test(dataset.sourceHash) ||
        typeof dataset.contentVersion !== 'string' || dataset.contentVersion.length === 0 ||
        dataset.representation?.sampleRegistration !== 'pixel-center' ||
        dataset.tileMatrixSet?.coverage?.tileMatrixSet !== WebMercatorQuad ||
        typeof dataset.sample !== 'function' || typeof dataset.page !== 'function') {
        throw new TypeError('Flow Field velocity samples require a normalized runtime dataset')
    }
    const sample = dataset.sample(sampleKey)
    if (sample.sampleKey !== sampleKey) {
        throw new TypeError('Flow Field runtime dataset returned another sample identity')
    }
    const model = webMercatorVirtualRasterField({
        id: `flow-velocity.${dataset.datasetId}.${sample.sampleKey}`,
        addressSpaceId:
            `flow-velocity.wmq.${dataset.sourceHash.slice(0, 16)}.` +
            `${dataset.contentVersion}.${sample.sampleKey}`,
        sourceRevision: dataset.contentVersion,
        coverage: dataset.tileMatrixSet.coverage,
        geographicBounds: dataset.source.geographicBounds,
        fieldKind: 'vector',
        channels: 2,
        sampleType: 'float32',
        gpuFormat: 'rg32float',
        unit: dataset.unit,
        interpolation: 'linear',
        auxiliaryAxes: [
            { name: 'model-time', value: sample.modelTime },
            { name: 'vector-basis', value: dataset.basis },
        ],
    })

    function resolvePage(page: VirtualRasterPageIdentity): FlowFieldRuntimePage {

        const tile = page?.tile
        if (page?.addressSpaceId !== model.addressSpace.id || tile === undefined ||
            tile.tileMatrixSetId !== dataset.tileMatrixSet.id) {
            throw new TypeError('Flow Field velocity source requires its own WebMercatorQuad page')
        }
        const resolved = dataset.page(sample.sampleKey, tile)
        if (resolved.sampleKey !== sample.sampleKey ||
            resolved.timeIndex !== sample.timeIndex) {
            throw new TypeError('Flow Field runtime page belongs to another sample')
        }
        return resolved
    }

    return Object.freeze({
        sampleKey: sample.sampleKey,
        timeIndex: sample.timeIndex,
        sample,
        sampleRegistration: dataset.representation.sampleRegistration,
        representation: dataset.representation,
        model,
        resolvePage,
    })
}

/** Composes one velocity time with borrowed WorkerSystem and owned executor authority. */
export async function createVelocityTimeRuntime({
    runtime,
    manifest,
    timeIndex,
    cachePolicy,
    workerSystem,
    workerModules,
    workerCount,
    maxNetworkRequests,
    maxDecodeTasks,
    maxRequests = DEFAULT_MAX_REQUESTS,
    maxPhysicalPages = DEFAULT_MAX_PHYSICAL_PAGES,
    maxStagingBytes = maxPhysicalPages * PAGE_BYTE_LENGTH,
    maxHistory = DEFAULT_MAX_HISTORY,
}: FlowVelocityTimeRuntimeOptions): Promise<FlowVelocityTimeRuntime> {

    const source = createVelocityTimeSource(manifest, timeIndex)
    const requestExecutor = await createVelocityWorkerRequestExecutor({
        sourceId: `flow-velocity.${manifest.sourceHash}`,
        sampleKey: source.sampleKey,
        contentVersion: manifest.contentVersion,
        cachePolicy,
        workerSystem,
        workerModules,
        ...(workerCount === undefined ? {} : { workerCount }),
        ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
        ...(maxDecodeTasks === undefined ? {} : { maxDecodeTasks }),
        maxRequests,
        resolvePage: source.resolvePage,
    })
    const virtualRaster = await createVirtualRasterRuntime({
        runtime,
        model: source.model,
        executor: {
            ownership: 'owned',
            executor: requestExecutor,
        },
        maxRequests,
        maxPhysicalPages,
        maxStagingBytes,
        maxHistory,
        viewDemandProducerId: `flow-velocity-view-demand.${source.model.id}`,
    })
    return Object.freeze({
        ...virtualRaster,
        source,
        workerFacts: requestExecutor.inspect,
    })
}

function pageKey(page: Readonly<{
    matrixId: string
    tileRow: number
    tileCol: number
}>): string {

    return `${page.matrixId}/${page.tileRow}/${page.tileCol}`
}
