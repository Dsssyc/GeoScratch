import { LifetimeScope } from 'geoscratch/scratch'
import {
    startUnderwaterTerrainApplication,
} from './application.ts'
import type { UnderwaterTerrainApplication } from './application.ts'
import { readUnderwaterTerrainCachePolicy } from './cache-policy.ts'
import { prepareUnderwaterTerrainControlPanel } from './control-panel.ts'

type UnderwaterTerrainProofModule = typeof import(
    '../../tests/browser/support/underwater-terrain-proof.ts'
)
type UnderwaterTerrainProof = ReturnType<UnderwaterTerrainProofModule['createUnderwaterTerrainProof']>
type FailureDetails = Error & { diagnostic?: unknown }

const canvas = document.getElementById('GPUFrame') as HTMLCanvasElement
const controlPanelContainer = document.getElementById('UnderwaterTerrainControlPanel') as HTMLElement
const pageLifetime = new LifetimeScope({ label: 'underwater-terrain-page' })
const preparedControlPanel = prepareUnderwaterTerrainControlPanel({
    parameters: new URLSearchParams(window.location.search),
})
const parameters = preparedControlPanel.parameters
const proofMode = parameters.get('proof') === '1'
const tileServerUrl = parameters.get('tileServer') ?? 'http://127.0.0.1:8787'
const cachePolicy = readUnderwaterTerrainCachePolicy(parameters)
const maxPhysicalPages = boundedIntegerParameter(parameters.get('atlasPages'), 64, 2, 64)
const variableLodPitchThresholdRadians = readVariableLodPitchThreshold(
    import.meta.env.VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES
)
let tileWireframeEnabled = preparedControlPanel.renderingPreference.tileWireframe
let application: UnderwaterTerrainApplication | undefined
let proof: UnderwaterTerrainProof | undefined
let pageSettlement: Promise<unknown> | undefined

const controlPanel = preparedControlPanel.mount({
    container: controlPanelContainer,
    location: window.location,
    compact: window.matchMedia('(max-width: 640px)').matches,
    onTileWireframeChange(enabled) {
        tileWireframeEnabled = enabled
        application?.setTileWireframe(enabled)
    },
})
const handlePageHide = () => { void disposePage() }
window.addEventListener('pagehide', handlePageHide, { once: true })
pageLifetime.deferStop({ label: 'underwater-terrain-control-panel', run: controlPanel.dispose })
pageLifetime.deferStop({
    label: 'pagehide-listener',
    run: () => window.removeEventListener('pagehide', handlePageHide),
})

setStatus('loading')
const pageInitialization = pageLifetime.track(initializePage(), 'underwater-terrain-page-initialization')
void pageInitialization.catch(error => {
    if (pageLifetime.isStopError(error)) return
    void failPage(error)
})

async function initializePage() {

    proof = await loadProof()
    application = await startUnderwaterTerrainApplication({
        lifetime: pageLifetime,
        canvas,
        proofMode,
        tileServerUrl,
        workerModuleManifestUrl: new URL('../scratch-workers/manifest.json', window.location.href),
        cachePolicy,
        maxPhysicalPages,
        tileWireframeEnabled,
        variableLodPitchThresholdRadians,
        ...(proof === undefined ? {} : { proof }),
        fail: error => { void failPage(error) },
        dispose: disposePage,
        setStatus,
    })
    application.setTileWireframe(tileWireframeEnabled)
}

async function loadProof(): Promise<UnderwaterTerrainProof | undefined> {

    if (!import.meta.env.DEV || !proofMode) return undefined
    const { createUnderwaterTerrainProof } = await import(
        '../../tests/browser/support/underwater-terrain-proof.ts'
    )
    return createUnderwaterTerrainProof({
        canvas,
        lifetime: pageLifetime,
        scenario: parameters.get('fault') ?? undefined,
        tileServerUrl,
        cachePolicy,
        maxPhysicalPages,
        controlPanel: preparedControlPanel,
    })
}

async function failPage(error: unknown) {

    if (pageSettlement !== undefined) return pageSettlement
    reportFatalError(error)
    proof?.captureBeforeDisposal()
    pageSettlement = pageLifetime.dispose(error).then(report =>
        proof?.finalizeFailure(error, report)
    ).catch((cleanupFailure: unknown) => {
        console.error(cleanupFailure)
    })
    return pageSettlement
}

async function disposePage() {

    if (pageSettlement !== undefined) return pageSettlement
    pageSettlement = pageLifetime.dispose().then(report => {
        const cleanupProof = proof?.finalizeCleanup(report)
        setStatus(report.cleanupFailures.length === 0 ? 'disposed' : 'error')
        return cleanupProof ?? report
    })
    return pageSettlement
}

function boundedIntegerParameter(
    value: string | null,
    fallback: number,
    minimum: number,
    maximum: number
) {

    if (value === null) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new RangeError(
            `Underwater Terrain integer parameter must be between ${minimum} and ${maximum}`
        )
    }
    return parsed
}

function readVariableLodPitchThreshold(value: string | undefined): number {

    if (value === undefined || value.trim().length === 0) return Math.PI / 3
    const degrees = Number(value)
    if (!Number.isFinite(degrees) || degrees < 0 || degrees > 90) {
        throw new RangeError(
            'VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES must be between 0 and 90'
        )
    }
    return degrees * Math.PI / 180
}

function setStatus(status: string) {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error: unknown) {

    setStatus('error')
    canvas.dataset.error = error instanceof Error ? error.message : String(error)
    if ((error as FailureDetails | null | undefined)?.diagnostic !== undefined) {
        canvas.dataset.diagnostic = JSON.stringify((error as FailureDetails).diagnostic)
    }
    console.error(error)
}
