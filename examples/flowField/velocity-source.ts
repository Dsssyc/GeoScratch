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
    FlowDatasetManifest,
    FlowVelocityPageManifest,
} from './flow-dataset.ts'

export type FlowVelocityTimeSource = Readonly<{
    timeIndex: number
    model: ReturnType<typeof webMercatorVirtualRasterField>
    tileUrl(page: VirtualRasterPageIdentity): string
    expectedPage(page: VirtualRasterPageIdentity): FlowVelocityPageManifest
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

    return Object.freeze({
        timeIndex,
        model,
        tileUrl(page) {

            const expected = requirePage(page)
            return new URL(
                `${timeLabel}/${encodeURIComponent(expected.matrixId)}/` +
                `${expected.tileRow}/${expected.tileCol}.rg32f`,
                tileBaseUrl
            ).href
        },
        expectedPage: requirePage,
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
        timeIndex,
        contentVersion: manifest.contentVersion,
        cachePolicy,
        workerSystem,
        workerModules,
        ...(workerCount === undefined ? {} : { workerCount }),
        ...(maxNetworkRequests === undefined ? {} : { maxNetworkRequests }),
        ...(maxDecodeTasks === undefined ? {} : { maxDecodeTasks }),
        maxRequests,
        tileUrl: source.tileUrl,
        expectedPage: source.expectedPage,
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
