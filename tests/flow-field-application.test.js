import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const applicationPath = path.join(root, 'examples', 'flowField', 'application.ts')
const mainPath = path.join(root, 'examples', 'flowField', 'main.ts')
const htmlPath = path.join(root, 'examples', 'flowField', 'index.html')

describe('Flow Field application shell', () => {

    it('uses one public runtime WorkerSystem Surface temporal raster and renderer', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include('GPURuntime.create({')
        expect(source).to.include('new WorkerSystem({')
        expect(source).to.include('moduleResolver: workerModules')
        expect(source).to.include("label: 'Flow Field surface'")
        expect(source).to.include('createTemporalVelocityRaster({')
        expect(source).to.include('createFlowFieldRenderer({')
        expect(source).to.include('maxPhysicalPages: 64')
        expect(source).to.not.match(/runtime\.(?:device|queue)/)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
    })

    it('uses the public MapLibre view source driver and one conservative frame slot', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include('mapLibrePlanarViewSource({')
        expect(source).to.include('mapLibreFrameDriver({')
        expect(source).to.include('createGeoFrameController({')
        expect(source).to.include('maximumInFlightFrames: 1')
        expect(source).to.include('return renderer.render(frameNumber, captured)')
        expect(source).to.include('if (!paused) frameController.invalidate()')
        expect(source).to.include('frameController.stop()')
        expect(source).to.include('renderer.flushResidency()')
        expect(source).not.to.match(/map\.on\(['"](?:move|resize|load)/)
    })

    it('publishes an independent proof identity and exact standalone title', () => {

        const main = fs.readFileSync(mainPath, 'utf8')
        const html = fs.readFileSync(htmlPath, 'utf8')
        expect(main).to.include('__FLOW_FIELD_PROOF__')
        expect(main).to.include("tileServer') ?? 'http://127.0.0.1:8788'")
        expect(main).to.include("proofMode ? 2 : 300")
        expect(html).to.include('<title>Flow Field | GeoScratch Examples</title>')
        expect(html).to.include('<canvas id="GPUFrame"></canvas>')
        expect(html).to.include('maplibre-gl@4.7.1')
        expect(html).to.include('src="./main.ts"')
        expect(`${main}\n${html}`).not.to.match(/__FLOW_LAYER_PROOF__|Flow Layer/)
    })

    it('keeps the application data plane velocity-only', () => {

        const source = fs.readFileSync(applicationPath, 'utf8')
        expect(source).to.include("loadFlowDatasetManifest(flowManifestUrl(tileServerUrl))")
        expect(source).to.include("return new URL('manifest.json', base)")
        expect(source).to.not.match(/boundary|depth|wet(?:Mask|Texture)|SDF|vectorFeature/i)
    })
})
