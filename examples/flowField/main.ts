import { LifetimeScope } from 'geoscratch/scratch'
import {
    startFlowFieldApplication,
} from './application.ts'
import type {
    FlowFieldApplication,
    FlowFieldApplicationFacts,
} from './application.ts'

type FlowFieldProofApi = Readonly<{
    pauseAndDrain(): Promise<FlowFieldApplicationFacts | undefined>
    resume(): void
    dispose(): Promise<unknown>
    facts(): FlowFieldApplicationFacts | undefined
}>
type FailureDetails = Error & {
    diagnostic?: unknown
    context?: unknown
    cause?: unknown
}

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const lifetime = new LifetimeScope({ label: 'flow-field-page' })
const parameters = new URLSearchParams(window.location.search)
const proofMode = parameters.get('proof') === '1'
const tileServerUrl = parameters.get('tileServer') ?? 'http://127.0.0.1:8788'
const framesPerTime = boundedInteger(
    parameters.get('framesPerTime'),
    proofMode ? 2 : 300,
    1,
    3600
)
let application: FlowFieldApplication | undefined
let pageSettlement: Promise<unknown> | undefined

const handlePageHide = () => { void disposePage() }
window.addEventListener('pagehide', handlePageHide, { once: true })
lifetime.deferStop({
    label: 'flow-field-pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

const proofApi: FlowFieldProofApi = Object.freeze({
    async pauseAndDrain() {

        application?.setPaused(true)
        await lifetime.drain()
        await application?.flush()
        await lifetime.drain()
        return application?.facts()
    },
    resume() { application?.setPaused(false) },
    dispose: disposePage,
    facts: () => application?.facts(),
})
;(window as unknown as { __FLOW_FIELD_PROOF__: FlowFieldProofApi }).__FLOW_FIELD_PROOF__ =
    proofApi

setStatus('loading')
void lifetime.track(initializePage(), 'flow-field-page-initialization').catch(error => {
    if (lifetime.isStopError(error)) return
    void failPage(error)
})

async function initializePage(): Promise<void> {

    application = await startFlowFieldApplication({
        lifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl: new URL('../scratch-workers/manifest.json', window.location.href),
        framesPerTime,
        fail: error => { void failPage(error) },
        setStatus,
    })
}

async function failPage(error: unknown) {

    if (pageSettlement !== undefined) return pageSettlement
    reportFatalError(error)
    pageSettlement = lifetime.dispose(error).catch(cleanupFailure => {
        console.error(cleanupFailure)
    })
    return pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = lifetime.dispose().then(report => {
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return report
    })
    return pageSettlement
}

function boundedInteger(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number
): number {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(
            `Flow Field integer parameter must be between ${minimum} and ${maximum}`
        )
    }
    return parsed
}

function setStatus(status: string): void {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error: unknown): void {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    if ((error as FailureDetails | null | undefined)?.diagnostic !== undefined) {
        const details = error as FailureDetails
        canvas.dataset.diagnostic = JSON.stringify(details.diagnostic)
        canvas.dataset.failure = JSON.stringify({
            context: details.context,
            cause: details.cause instanceof Error
                ? { name: details.cause.name, message: details.cause.message }
                : details.cause,
        })
    }
    console.error(error)
}
