import { LifetimeScope } from 'geoscratch/scratch'
import {
    startFlowFieldApplication,
} from './application.ts'
import type {
    FlowFieldApplication,
    FlowFieldApplicationFacts,
} from './application.ts'
import { mountFlowFieldControls } from './control-panel.ts'
import { FLOW_FIELD_PRESENTATION, flowFieldPresentation } from './flow-presentation.ts'
import type { FlowFieldPresentation } from './flow-presentation.ts'

type FlowFieldProofApi = Readonly<{
    pauseAndDrain(): Promise<FlowFieldApplicationFacts | undefined>
    play(): void
    pause(): void
    resume(): void
    seek(modelTime: number): void
    setRate(rate: number): void
    setLoop(loop: 'clamp' | 'loop'): void
    setPresentation(presentation: FlowFieldPresentation): void
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
let application: FlowFieldApplication | undefined
let terminalFlush: Promise<FlowFieldApplicationFacts | undefined> | undefined
let pageSettlement: Promise<unknown> | undefined
const controls = mountFlowFieldControls({
    container: document.getElementById('FlowFieldControls')!,
    onPlay: () => application?.play({ wallTime: performance.now() }),
    onPause: () => application?.pause({ wallTime: performance.now() }),
    onSeek: modelTime => application?.seek({ wallTime: performance.now(), modelTime }),
    onRate: rate => application?.setRate({ wallTime: performance.now(), rate }),
    onLoop: loop => application?.setLoop({ wallTime: performance.now(), loop }),
    onPresentation: value => application?.setPresentation(value),
})
lifetime.deferStop({ label: 'flow-field-controls', run: controls.dispose })

const handlePageHide = () => { void disposePage() }
window.addEventListener('pagehide', handlePageHide, { once: true })
lifetime.deferStop({
    label: 'flow-field-pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

const proofApi: FlowFieldProofApi = Object.freeze({
    async pauseAndDrain() {

        if (terminalFlush !== undefined) return await terminalFlush
        const active = application
        if (active === undefined) return undefined
        terminalFlush = active.flush({ wallTime: performance.now() })
        return await terminalFlush
    },
    play() { application?.play({ wallTime: performance.now() }) },
    pause() { application?.pause({ wallTime: performance.now() }) },
    resume() { application?.play({ wallTime: performance.now() }) },
    seek(modelTime) { application?.seek({ wallTime: performance.now(), modelTime }) },
    setRate(rate) { application?.setRate({ wallTime: performance.now(), rate }) },
    setLoop(loop) { application?.setLoop({ wallTime: performance.now(), loop }) },
    setPresentation(value) { application?.setPresentation(value) },
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

    const proofMode = parameters.get('proof') === '1'
    const tileServerUrl = parameters.get('tileServer') ?? 'http://127.0.0.1:8788'
    const initialRate = finiteRate(parameters.get('rate'), proofMode ? 8 : 0.2)
    const initialLoop = flowLoop(parameters.get('loop'))
    const initialZoom = boundedNumber(parameters.get('zoom'), 0, 18)
    application = await startFlowFieldApplication({
        lifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl: new URL('../scratch-workers/manifest.json', window.location.href),
        readWallTime: () => performance.now(),
        initialRate,
        initialLoop,
        initialPresentation: flowFieldPresentation({
            ...FLOW_FIELD_PRESENTATION,
            view: (parameters.get('view') ?? 'particles') as FlowFieldPresentation['view'],
        }),
        onControlSnapshot: controls.update,
        ...(initialZoom === undefined ? {} : { initialZoom }),
        fail: failPage,
        setStatus,
    })
}

async function failPage(error: unknown): Promise<void> {

    if (pageSettlement !== undefined) {
        await pageSettlement
        return
    }
    reportFatalError(error)
    pageSettlement = lifetime.dispose(error).catch(cleanupFailure => {
        console.error(cleanupFailure)
    })
    await pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = lifetime.dispose().then(report => {
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return report
    })
    return pageSettlement
}

function finiteRate(value: string | null, fallback: number): number {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed === 0 || Math.abs(parsed) > 1000) {
        throw new RangeError('Flow Field rate must be finite, non-zero, and within [-1000, 1000]')
    }
    return parsed
}

function flowLoop(value: string | null): 'clamp' | 'loop' {

    if (value === null || value === 'loop') return 'loop'
    if (value === 'clamp') return 'clamp'
    throw new TypeError('Flow Field loop must be clamp or loop')
}

function boundedNumber(
    value: string | null,
    minimum: number,
    maximum: number
): number | undefined {

    if (value === null) return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(`Flow Field number must be within [${minimum}, ${maximum}]`)
    }
    return parsed
}

function setStatus(status: string): void {

    canvas.dataset.status = status
    document.body.dataset.status = status
    canvas.style.visibility = status === 'gap' || status === 'failed' ? 'hidden' : 'visible'
    controls.setStatus(status === 'disposed' ? 'stopped'
        : status === 'error' ? 'failed' : status as 'ready' | 'loading' | 'gap' | 'failed')
}

function reportFatalError(error: unknown): void {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    const errorElement = document.getElementById('FlowFieldError')!
    errorElement.textContent = canvas.dataset.error
    errorElement.hidden = false
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
