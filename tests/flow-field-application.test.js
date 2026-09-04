import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    FLOW_FIELD_RUNTIME_BUDGETS,
} from '../examples/flowField/flow-runtime-budgets.ts'

const root = process.cwd()
const applicationPath = path.join(root, 'examples', 'flowField', 'application.ts')
const mainPath = path.join(root, 'examples', 'flowField', 'main.ts')
const htmlPath = path.join(root, 'examples', 'flowField', 'index.html')

describe('Flow Field application shell', () => {

    it('uses one public runtime WorkerSystem Surface timeline window and renderer', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include('GPURuntime.create({')
        expect(source).to.include('new WorkerSystem({')
        expect(source).to.include('moduleResolver: workerModules')
        expect(source).to.include("label: 'Flow Field surface'")
        expect(source).to.include('loadFlowFieldDataset(flowManifestUrl(tileServerUrl)')
        expect(source).to.include('createFlowTimeline({')
        expect(source).to.include('createFlowTemporalRuntimeWindow({')
        expect(source).to.include('createReadyVelocitySampleRuntime({')
        expect(source).to.include('createFlowFieldRenderer({')
        expect(source).to.include('temporalWindow,')
        expect(source).to.include('stopRuntimeRequests: value => value.stopDemand()')
        expect(source).to.include("label: 'flow-field-temporal-runtime-window-requests'")
        expect(source).to.include('temporalWindow.termination.then(')
        expect(source).to.include('AbortSignal.any([ context.signal, lifetime.signal ])')
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
    })

    it('uses the public MapLibre view source driver and one conservative frame slot', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include('mapLibrePlanarViewSource({')
        expect(source).to.include('mapLibreFrameDriver({')
        expect(source).to.include('createGeoFrameController<')
        expect(source).to.include('maximumInFlightFrames: 1')
        expect(source).to.include('renderer.render(frameNumber, captured, current)')
        expect(source.match(/await renderer\.suspendTemporal\(\)/g)?.length).to.be.at.least(3)
        expect(source).to.include('if (timeline.snapshot().needsTick) frameController.invalidate()')
        expect(source).to.include("'runtime-selection-loading'")
        expect(source).to.include("state: 'gap' as const")
        expect(source).to.include('frameController!.stop()')
        expect(source).to.include('renderer.flushResidency()')
        expect(source).to.include('const terminalCapture = viewSource.capture()')
        expect(source).to.include(
            "await renderTerminalPass(admitted, terminalCapture, 'feedback')"
        )
        expect(source).to.include(
            "await renderTerminalPass(admitted, terminalCapture, 'demand')"
        )
        expect(source).to.include(
            "await renderTerminalPass(admitted, terminalCapture, 'presentation')"
        )
        expect(source).to.include('setGapFrame(timeline.snapshot(), latestHandshake)')
        expect(source).to.include('Promise.resolve(options.fail(error))')
        expect(source).to.include("state: 'failed' as const")
        expect(source).to.include("'runtime-selection-failed'")
        expect(source).to.include('latestHandshake.status === \'failed\'')
        expect(source).to.include("latestWindow.state === 'gap'")
        expect(source).not.to.match(/map\.on\(['"](?:move|resize|load)/)
    })

    it('publishes an independent proof identity and exact standalone title', () => {

        const main = fs.readFileSync(mainPath, 'utf8')
        const html = fs.readFileSync(htmlPath, 'utf8')
        expect(main).to.include('__FLOW_FIELD_PROOF__')
        expect(main).to.include('let terminalFlush: Promise<FlowFieldApplicationFacts')
        expect(main).to.include('if (terminalFlush !== undefined) return await terminalFlush')
        expect(main).to.include("tileServer') ?? 'http://127.0.0.1:8788'")
        expect(main).to.include("parameters.get('rate')")
        expect(main).to.include('performance.now()')
        expect(main).to.not.include('framesPerTime')
        expect(html).to.include('<title>Flow Field | GeoScratch Examples</title>')
        expect(html).to.include('<canvas id="GPUFrame"></canvas>')
        expect(html).to.include('maplibre-gl@4.7.1')
        expect(html).to.include('src="./main.ts"')
        expect(`${main}\n${html}`).not.to.match(/__FLOW_LAYER_PROOF__|Flow Layer/)
        const initialize = main.indexOf('async function initializePage')
        const parseRate = main.indexOf("const initialRate = finiteRate(parameters.get('rate')")
        expect(initialize).to.be.greaterThan(-1)
        expect(parseRate).to.be.greaterThan(initialize)
    })

    it('keeps the application data plane velocity-only', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include("loadFlowFieldDataset(flowManifestUrl(tileServerUrl)")
        expect(source).to.include("return new URL('manifest.json', base)")
        expect(source).to.not.match(/boundary|depth|wet(?:Mask|Texture)|SDF|vectorFeature/i)
    })

    it('partitions one explicit four-runtime resource budget without hidden multiplication', () => {

        expect(FLOW_FIELD_RUNTIME_BUDGETS.maxOwnedRuntimes).to.equal(4)
        for (const key of [
            'maxRequests',
            'maxPhysicalPages',
            'maxStagingBytes',
            'maxNetworkRequests',
            'maxDecodeTasks',
        ]) {
            expect(FLOW_FIELD_RUNTIME_BUDGETS.perRuntime[key] * 4)
                .to.equal(FLOW_FIELD_RUNTIME_BUDGETS.total[key])
        }
        expect(FLOW_FIELD_RUNTIME_BUDGETS.total.maxPhysicalPages).to.equal(192)
        expect(Object.isFrozen(FLOW_FIELD_RUNTIME_BUDGETS)).to.equal(true)
    })
})
