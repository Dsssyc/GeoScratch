import {
    FLOW_FIELD_PRESENTATION,
    FLOW_FIELD_SDF_FEATHER,
    flowFieldPresentation,
    type FlowFieldControlSnapshot,
    type FlowFieldPresentation,
} from './flow-presentation.ts'
import type { FlowTimelineLoop } from './flow-timeline.ts'

export type FlowFieldControlOptions = Readonly<{
    container: HTMLElement
    onPlay(): unknown
    onPause(): unknown
    onSeek(modelTime: number): unknown
    onRate(rate: number): unknown
    onLoop(loop: FlowTimelineLoop): unknown
    onPresentation(presentation: FlowFieldPresentation): unknown
}>

export type FlowFieldControls = Readonly<{
    update(snapshot: FlowFieldControlSnapshot): void
    setStatus(state: FlowFieldControlSnapshot['state'], error?: unknown): void
    dispose(): void
}>

/** Mounts example-owned controls; updates are pushed by the application, with no polling. */
export function mountFlowFieldControls(options: FlowFieldControlOptions): FlowFieldControls {

    const document = options.container.ownerDocument
    const root = document.createElement('div')
    root.className = 'flow-controls'
    root.innerHTML = CONTROL_MARKUP
    options.container.append(root)
    const events = new AbortController()
    const eventOptions = { signal: events.signal }
    const find = <T extends HTMLElement>(name: string): T => {
        const element = root.querySelector<T>(`[data-flow-control="${name}"]`)
        if (element === null) throw new Error(`Missing Flow Field control: ${name}`)
        return element
    }
    const playback = find<HTMLButtonElement>('play-pause')
    const time = find<HTMLInputElement>('time')
    const rate = find<HTMLSelectElement>('rate')
    const loop = find<HTMLSelectElement>('loop')
    const view = find<HTMLSelectElement>('view')
    const sample = find<HTMLSelectElement>('sample')
    const boundary = find<HTMLSelectElement>('boundary')
    const feather = find<HTMLInputElement>('feather')
    const featherValue = find<HTMLOutputElement>('feather-value')
    const trails = find<HTMLInputElement>('trails')
    const contour = find<HTMLInputElement>('contour')
    const status = find('status')
    const errorMessage = find('error')
    const requested = find('requested')
    const requestedLabel = find('requested-label')
    const presented = find('presented')
    const pair = find('pair')
    const metadata = find('metadata')
    const start = find('start')
    const end = find('end')
    const rateUnit = find('rate-unit')
    const legend = find('legend')
    const inputs = [ playback, time, rate, loop, view, sample, boundary, feather, trails, contour ]
    let snapshot: FlowFieldControlSnapshot | undefined
    let currentPresentation = FLOW_FIELD_PRESENTATION
    let state: FlowFieldControlSnapshot['state'] = 'loading'
    let scrubbing = false
    let scrubInput = false
    let disposed = false

    function renderStatus(): void {
        root.dataset.state = state
        root.setAttribute('aria-busy', String(state === 'loading'))
        const statusText = state === 'ready'
            ? snapshot?.timeline.blockedReason === 'range-end' ? 'At end'
                : snapshot?.timeline.blockedReason === 'range-start' ? 'At start'
                    : snapshot?.timeline.playing ? 'Playing' : 'Paused'
            : ({ loading: 'Loading', gap: 'No data at this time', failed: 'Unable to render', stopped: 'Stopped' })[state]
        if (status.textContent !== statusText) status.textContent = statusText
        const disabled = snapshot === undefined || !errorMessage.hidden || state === 'stopped'
        for (const input of inputs) input.disabled = disabled
        time.disabled ||= snapshot?.dataset.minimumTime === snapshot?.dataset.maximumTime
        sample.disabled ||= currentPresentation.view === 'particles'
        trails.disabled ||= currentPresentation.view !== 'particles'
        boundary.disabled ||= currentPresentation.view !== 'particles'
        feather.disabled ||= currentPresentation.view !== 'particles' || currentPresentation.boundary === 'hard'
    }

    function setStatus(nextState: FlowFieldControlSnapshot['state'], error?: unknown): void {
        if (disposed) return
        state = nextState
        if (error !== undefined) {
            errorMessage.textContent = error instanceof Error ? error.message : String(error)
            errorMessage.hidden = false
        } else if (nextState !== 'failed') {
            errorMessage.textContent = ''
            errorMessage.hidden = true
        }
        renderStatus()
    }

    function invoke(action: () => unknown): void {
        if (disposed) return
        try {
            Promise.resolve(action()).catch(error => setStatus('failed', error))
        } catch (error) {
            setStatus('failed', error)
        }
    }

    function renderPresentation(): void {
        view.value = currentPresentation.view
        sample.value = currentPresentation.sample
        boundary.value = currentPresentation.boundary
        feather.value = String(currentPresentation.sdfFeatherTexels)
        featherValue.textContent = `${currentPresentation.sdfFeatherTexels.toFixed(2)} texel`
        feather.setAttribute('aria-valuetext', `${currentPresentation.sdfFeatherTexels.toFixed(2)} source texel`)
        trails.checked = currentPresentation.trails
        contour.checked = currentPresentation.contour
        legend.textContent = presentationLegend(currentPresentation, snapshot?.dataset.velocityUnit)
        renderStatus()
    }

    function renderRequested(modelTime: number): void {
        const unit = snapshot?.dataset.timeUnit ?? ''
        requestedLabel.textContent = scrubbing ? 'Seek preview' : 'Requested'
        requested.textContent = formatTime(modelTime, unit)
        time.setAttribute('aria-valuetext', formatTime(modelTime, unit))
    }

    function update(next: FlowFieldControlSnapshot): void {
        if (disposed) return
        snapshot = next
        // Keep an action failure visible until an explicit status change clears it.
        if (errorMessage.hidden) state = next.state
        const { dataset, timeline } = next
        time.min = String(dataset.minimumTime)
        time.max = String(dataset.maximumTime)
        if (!scrubbing) {
            time.value = String(timeline.modelTime)
            renderRequested(timeline.modelTime)
        }
        presented.textContent = next.presented === undefined
            ? '—' : formatTime(next.presented.presentedModelTime, dataset.timeUnit)
        presented.title = state === 'gap' ? 'Last presented time; the requested time has no data' : 'Last presented time'
        start.textContent = formatTime(dataset.minimumTime, dataset.timeUnit)
        end.textContent = formatTime(dataset.maximumTime, dataset.timeUnit)
        metadata.textContent = `${dataset.sampleCount} samples · ${dataset.velocityUnit}`
        rateUnit.textContent = `${dataset.timeUnit} / s`
        playback.textContent = timeline.playing ? 'Pause' : 'Play'
        playback.setAttribute('aria-label', timeline.playing ? 'Pause flow playback' : 'Play flow playback')
        if (![ ...rate.options ].some(option => option.value === String(timeline.rate))) {
            const option = document.createElement('option')
            option.value = String(timeline.rate)
            option.textContent = formatNumber(timeline.rate)
            option.dataset.customRate = 'true'
            rate.querySelector('[data-custom-rate]')?.remove()
            rate.append(option)
        }
        rate.value = String(timeline.rate)
        loop.value = timeline.loop
        const selection = timeline.selection
        pair.textContent = selection.kind === 'exact'
            ? `${selection.sample.sampleKey} · exact sample`
            : selection.kind === 'gap'
                ? `${selection.lower.sampleKey} → ${selection.upper.sampleKey} · gap`
                : `${selection.lower.sampleKey} → ${selection.upper.sampleKey} · ${formatNumber(selection.alpha * 100)}%`
        currentPresentation = flowFieldPresentation(next.presentation)
        renderPresentation()
    }

    playback.addEventListener('click', () => invoke(() => snapshot?.timeline.playing
        ? options.onPause() : options.onPlay()), eventOptions)
    time.addEventListener('pointerdown', () => {
        scrubbing = true
        scrubInput = false
    }, eventOptions)
    time.addEventListener('input', () => {
        scrubbing = true
        scrubInput = true
        renderRequested(time.valueAsNumber)
    }, eventOptions)
    time.addEventListener('change', () => {
        const modelTime = time.valueAsNumber
        scrubbing = false
        renderRequested(modelTime)
        invoke(() => options.onSeek(modelTime))
    }, eventOptions)
    const cancelPreview = () => {
        scrubbing = false
        if (snapshot !== undefined) update(snapshot)
    }
    time.addEventListener('pointerup', () => {
        if (!scrubInput) cancelPreview()
    }, eventOptions)
    time.addEventListener('pointercancel', cancelPreview, eventOptions)
    time.addEventListener('blur', cancelPreview, eventOptions)
    rate.addEventListener('change', () => invoke(() => options.onRate(Number(rate.value))), eventOptions)
    loop.addEventListener('change', () => invoke(() => options.onLoop(loop.value as FlowTimelineLoop)), eventOptions)
    function applyPresentation(sdfFeatherTexels = currentPresentation.sdfFeatherTexels): void {
        currentPresentation = flowFieldPresentation({
            view: view.value as FlowFieldPresentation['view'],
            sample: sample.value as FlowFieldPresentation['sample'],
            trails: trails.checked,
            contour: contour.checked,
            boundary: boundary.value as FlowFieldPresentation['boundary'],
            sdfFeatherTexels,
        })
        renderPresentation()
        invoke(() => options.onPresentation(currentPresentation))
    }
    for (const input of [ view, sample, boundary, trails, contour ]) {
        input.addEventListener('change', () => applyPresentation(), eventOptions)
    }
    // Native range input covers pointer dragging and keyboard steps. Do not
    // submit again on change when the same gesture is committed.
    feather.addEventListener('input', () => applyPresentation(feather.valueAsNumber), eventOptions)
    renderPresentation()

    return Object.freeze({
        update,
        setStatus,
        dispose() {
            if (disposed) return
            disposed = true
            events.abort()
            root.remove()
            snapshot = undefined
        },
    })
}

function formatNumber(value: number): string {
    return NUMBER_FORMAT.format(value)
}

function formatTime(value: number, unit: string): string {
    return `${formatNumber(value)} ${unit}`.trim()
}

function presentationLegend(value: FlowFieldPresentation, unit = 'm/s'): string {
    if (value.view === 'particles') {
        const boundary = {
            hard: 'A: Hard texture boundary.',
            sdf: 'B: Inner-edge display only; no extra source detail.',
            'sdf-center-linear': 'C: Linear center-field reconstruction may move the boundary. Feather controls display AA; no extra source detail.',
            'sdf-center-smooth': 'D: Smooth center-field reconstruction may move the boundary. Feather controls display AA; no extra source detail.',
        }[value.boundary]
        return `Particles follow the interpolated velocity. ${boundary}`
    }
    const field = ({ speed: `Speed (${unit})`, direction: 'Flow direction', u: `U · eastward (${unit})`, v: `V · northward (${unit})`, status: 'Velocity sampling status' })[value.view]
    const sampled = value.sample === 'delta' ? `${field} · upper − lower` : `${field} · ${value.sample} sample`
    return `${sampled}. Unfiltered diagnostics; boundary A/B/C/D inactive.`
}

const NUMBER_FORMAT = new Intl.NumberFormat('en', { maximumFractionDigits: 3 })

const CONTROL_MARKUP = `
    <details class="flow-inspector" open>
        <summary>Flow Field <span>Inspect</span></summary>
        <div class="flow-inspector-body">
            <p class="flow-metadata" data-flow-control="metadata">Loading dataset…</p>
            <label class="flow-field">View <select data-flow-control="view">
                <option value="particles">Particles</option><option value="speed">Speed</option>
                <option value="direction">Direction</option><option value="u">U · eastward</option>
                <option value="v">V · northward</option><option value="status">Sample status</option>
            </select></label>
            <label class="flow-field">Sample <select data-flow-control="sample">
                <option value="interpolated">Interpolated</option><option value="lower">Lower time</option>
                <option value="upper">Upper time</option><option value="delta">Upper − lower</option>
            </select></label>
            <label class="flow-field">Boundary <select data-flow-control="boundary">
                <option value="hard">A · Hard texture</option>
                <option value="sdf">B · SDF (inward)</option>
                <option value="sdf-center-linear">C · Center SDF (linear)</option>
                <option value="sdf-center-smooth">D · Center SDF (smooth)</option>
            </select></label>
            <label class="flow-field">Feather <span class="flow-feather">
                <input type="range" data-flow-control="feather" aria-label="SDF feather width"
                    min="${FLOW_FIELD_SDF_FEATHER.minimum}" max="${FLOW_FIELD_SDF_FEATHER.maximum}"
                    step="0.01" value="${FLOW_FIELD_SDF_FEATHER.default}" />
                <output data-flow-control="feather-value">0.25 texel</output>
            </span></label>
            <div class="flow-checks">
                <label><input type="checkbox" data-flow-control="trails" /> Particle trails</label>
                <label><input type="checkbox" data-flow-control="contour" /> Activity contour</label>
            </div>
            <p class="flow-legend" data-flow-control="legend"></p>
        </div>
    </details>
    <section class="flow-timeline" aria-label="Flow playback controls">
        <div class="flow-timeline-heading">
            <span class="flow-status" role="status" data-flow-control="status">Loading</span>
            <span class="flow-pair" data-flow-control="pair">Preparing time samples</span>
        </div>
        <p class="flow-error" role="alert" data-flow-control="error" hidden></p>
        <div class="flow-transport">
            <button type="button" class="flow-play" data-flow-control="play-pause" aria-label="Play flow playback">Play</button>
            <div class="flow-time-values">
                <span><span data-flow-control="requested-label">Requested</span> <output data-flow-control="requested" aria-live="off">—</output></span>
                <span>Presented <output data-flow-control="presented" aria-live="off">—</output></span>
            </div>
            <label class="flow-rate">Rate <select data-flow-control="rate">
                <option value="-2">−2</option><option value="-1">−1</option><option value="-0.2">−0.2</option>
                <option value="0.2" selected>0.2</option><option value="1">1</option><option value="2">2</option>
            </select><span data-flow-control="rate-unit">units / s</span></label>
            <label class="flow-loop">At end <select data-flow-control="loop">
                <option value="loop">Loop</option><option value="clamp">Stop</option>
            </select></label>
        </div>
        <input type="range" min="0" max="1" step="any" value="0" data-flow-control="time" aria-label="Model time" />
        <div class="flow-time-limits"><span data-flow-control="start">—</span><span data-flow-control="end">—</span></div>
    </section>
`
