import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('examples structure', () => {
    const examples = [
        '1_helloTriangle',
        '2_helloVertexBuffer',
        'm_helloMap',
        'm_demLayer',
        'x_helloGAW',
    ]

    it('keeps the repository root free of demo html entrypoints', () => {
        expect(exists('index.html')).to.equal(false)
    })

    it('provides an examples browser under examples/', () => {
        const html = read('examples', 'index.html')

        expect(html).to.include('GeoScratch Examples')
        expect(html).to.include('type="search"')
        expect(html).to.include('examples-nav')
        for (const name of examples) {
            expect(html).to.include(`./${name}/`)
        }
    })

    it('gives each runnable example its own standalone html shell', () => {
        for (const name of examples) {
            const html = read('examples', name, 'index.html')

            expect(html).to.include('id="GPUFrame"')
            expect(html).to.include('src="./main.js"')
            expect(html).to.include('../shared/example.css')
        }
    })

    it('loads mapbox only for the mapbox-backed terrain example', () => {
        const html = read('examples', 'm_demLayer', 'index.html')

        expect(html).to.include('mapbox-gl-js/v3.2.0/mapbox-gl.js')
        expect(html).to.include('mapbox-gl-js/v3.2.0/mapbox-gl.css')
    })

    it('keeps filtered examples hidden in the examples browser', () => {
        const css = read('examples', 'shared', 'index.css')

        expect(css).to.include('.example-link[hidden]')
        expect(css).to.include('display: none')
    })
})
