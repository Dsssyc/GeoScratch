import { expect } from 'chai'
import { setMaxListeners } from 'node:events'
import { mountFlowFieldControls } from '../examples/flowField/control-panel.ts'
import { FLOW_FIELD_PRESENTATION } from '../examples/flowField/flow-presentation.ts'

describe('Flow Field boundary controls (Node DOM fixture)', () => {
    it('defaults to balanced trails and retains native quality through inspection views', () => {
        const fixture = controlsFixture()
        fixture.controls.update(fixture.snapshot)
        expect(fixture.find('trail-quality').value).to.equal('balanced')
        fixture.change('trail-quality','native')
        expect(fixture.events.at(-1).trailQuality).to.equal('native')
        fixture.change('view','status')
        expect(fixture.find('trail-quality').disabled).to.equal(true)
        fixture.change('view','particles')
        expect(fixture.find('trail-quality').disabled).to.equal(false)
        expect(fixture.find('trail-quality').value).to.equal('native')
        expect(fixture.events.at(-1).trailQuality).to.equal('native')
        const count = fixture.events.length
        fixture.controls.dispose()
        fixture.change('trail-quality','balanced')
        expect(fixture.events.length).to.equal(count)
    })

    it('defaults to A and only enables the boundary choice for particles', () => {
        const fixture = controlsFixture()
        const boundary = fixture.find('boundary')
        expect(boundary.disabled).to.equal(true)
        fixture.controls.update(fixture.snapshot)
        expect(boundary.value).to.equal('hard')
        expect(boundary.disabled).to.equal(false)
        expect(boundary.options.map(value => value.textContent)).to.deep.equal([
            'A · Hard texture', 'B · SDF (inward)', 'C · Center SDF (linear)', 'D · Center SDF (smooth)',
        ])
        expect(fixture.find('sample').disabled).to.equal(true)
        expect(fixture.find('trails').disabled).to.equal(false)
        expect(fixture.find('feather').disabled).to.equal(true)
        expect(fixture.find('feather').valueAsNumber).to.equal(0.25)
        expect(fixture.find('feather').min).to.equal('0.05')
        expect(fixture.find('feather').max).to.equal('0.35')
        expect(fixture.find('feather').step).to.equal('0.01')
        expect(fixture.find('feather-value').textContent).to.equal('0.25 texel')
        fixture.controls.dispose()
    })

    it('retains B through unfiltered inspection views and restores its particle hint', () => {
        const fixture = controlsFixture()
        fixture.controls.update(fixture.snapshot)
        fixture.change('boundary', 'sdf')
        expect(fixture.events.at(-1)).to.deep.equal({...FLOW_FIELD_PRESENTATION,boundary:'sdf'})
        expect(fixture.find('legend').textContent).to.include('Inner-edge display only')
        expect(fixture.find('legend').textContent).to.include('no extra source detail')
        for (const view of ['speed','direction','u','v','status']) {
            fixture.change('view', view)
            expect(fixture.find('boundary').disabled).to.equal(true)
            expect(fixture.find('boundary').value).to.equal('sdf')
            expect(fixture.find('feather').disabled).to.equal(true)
            expect(fixture.find('legend').textContent).to.include('Unfiltered diagnostics')
            expect(fixture.find('legend').textContent).to.include('boundary A/B/C/D inactive')
            expect(fixture.find('sample').disabled).to.equal(false)
            expect(fixture.find('trails').disabled).to.equal(true)
        }
        fixture.change('sample', 'upper')
        fixture.change('view', 'particles')
        expect(fixture.find('boundary').disabled).to.equal(false)
        expect(fixture.find('boundary').value).to.equal('sdf')
        expect(fixture.find('feather').disabled).to.equal(false)
        expect(fixture.snapshot.presentation.sample).to.equal('upper')
        expect(fixture.snapshot.presentation.trails).to.equal(true)
        expect(fixture.snapshot.presentation.contour).to.equal(false)
        expect(fixture.find('legend').textContent).to.include('Inner-edge display only')
        fixture.controls.dispose()
    })

    it('selects C and D independently, enables feather, and retains each reconstruction through diagnostics', () => {
        const fixture = controlsFixture()
        fixture.controls.update(fixture.snapshot)
        for (const [boundary, hint] of [['sdf-center-linear','C: Linear'],['sdf-center-smooth','D: Smooth']]) {
            fixture.change('boundary', boundary)
            expect(fixture.events.at(-1)).to.deep.equal({...FLOW_FIELD_PRESENTATION,boundary})
            expect(fixture.find('boundary').value).to.equal(boundary)
            expect(fixture.find('feather').disabled).to.equal(false)
            expect(fixture.find('legend').textContent).to.include(hint)
            expect(fixture.find('legend').textContent).to.include('may move the boundary')
            expect(fixture.find('legend').textContent).to.include('Feather controls display AA')
            for (const view of ['speed','direction','u','v','status']) {
                fixture.change('view', view)
                expect(fixture.find('boundary').disabled).to.equal(true)
                expect(fixture.find('feather').disabled).to.equal(true)
                expect(fixture.find('boundary').value).to.equal(boundary)
                expect(fixture.find('legend').textContent).to.include('boundary A/B/C/D inactive')
            }
            fixture.change('view', 'particles')
            expect(fixture.find('feather').disabled).to.equal(false)
            expect(fixture.find('legend').textContent).to.include(hint)
        }
        fixture.change('boundary', 'hard')
        expect(fixture.find('feather').disabled).to.equal(true)
        expect(fixture.find('legend').textContent).to.include('A: Hard texture boundary')
        fixture.controls.dispose()
    })

    it('normalizes legacy updates and removes all event ownership on disposal', () => {
        const fixture = controlsFixture()
        fixture.controls.update(fixture.snapshot)
        fixture.change('boundary', 'sdf')
        const legacy = {view:'particles',sample:'lower',trails:false,contour:true}
        fixture.snapshot.presentation = legacy
        fixture.controls.update(fixture.snapshot)
        expect(fixture.find('boundary').value).to.equal('hard')
        expect(legacy).to.not.have.property('boundary')
        fixture.change('boundary', 'sdf')
        expect(fixture.events.at(-1)).to.deep.equal({...legacy,boundary:'sdf',sdfFeatherTexels:0.25,trailQuality:'balanced'})
        fixture.controls.setStatus('stopped')
        expect(fixture.find('boundary').disabled).to.equal(true)
        expect(fixture.find('feather').disabled).to.equal(true)
        const boundary = fixture.find('boundary'), eventCount = fixture.events.length
        fixture.controls.dispose()
        fixture.controls.dispose()
        boundary.dispatchEvent(new Event('change'))
        expect(fixture.events.length).to.equal(eventCount)
        expect(fixture.container.children).to.have.length(0)
    })

    it('emits each feather input immediately, ignores duplicate change, and preserves width across views', () => {
        const fixture = controlsFixture()
        fixture.controls.update(fixture.snapshot)
        fixture.change('boundary','sdf')
        const feather = fixture.find('feather')
        expect(feather.disabled).to.equal(false)
        for (const width of [0.05,0.35,0.25]) {
            const before = fixture.events.length
            feather.valueAsNumber = width
            feather.dispatchEvent(new Event('input'))
            expect(fixture.events.length).to.equal(before+1)
            expect(fixture.events.at(-1).sdfFeatherTexels).to.equal(width)
            expect(fixture.find('feather-value').textContent).to.equal(`${width.toFixed(2)} texel`)
            expect(feather.getAttribute('aria-valuetext')).to.equal(`${width.toFixed(2)} source texel`)
            feather.dispatchEvent(new Event('change'))
            expect(fixture.events.length).to.equal(before+1)
        }
        feather.valueAsNumber = 0.35
        feather.dispatchEvent(new Event('input'))
        for (const [control,value] of [
            ['boundary','hard'],['boundary','sdf'],['boundary','sdf-center-linear'],
            ['boundary','sdf-center-smooth'],['view','status'],['view','particles'],
        ]) {
            fixture.change(control,value)
            expect(feather.valueAsNumber).to.equal(0.35)
            expect(fixture.events.at(-1).sdfFeatherTexels).to.equal(0.35)
            expect(feather.disabled).to.equal(fixture.snapshot.presentation.view!=='particles' ||
                fixture.snapshot.presentation.boundary==='hard')
        }
        expect(fixture.snapshot.presentation.sample).to.equal('interpolated')
        expect(fixture.snapshot.presentation.trails).to.equal(true)
        expect(fixture.snapshot.presentation.contour).to.equal(false)
        const eventCount = fixture.events.length
        fixture.controls.dispose()
        feather.dispatchEvent(new Event('input'))
        expect(fixture.events.length).to.equal(eventCount)
    })

    it('preserves a non-step caller width through unrelated A/B/C/D and view changes', () => {
        const fixture = controlsFixture()
        fixture.snapshot.presentation = {...FLOW_FIELD_PRESENTATION,boundary:'sdf',sdfFeatherTexels:0.123}
        fixture.controls.update(fixture.snapshot)
        const feather = fixture.find('feather')
        for (const [control,value] of [
            ['boundary','hard'],['boundary','sdf'],['boundary','sdf-center-linear'],
            ['boundary','sdf-center-smooth'],['view','status'],['view','particles'],
        ]) {
            // Native range inputs snap their displayed value to the declared
            // step. That DOM normalization is not a user feather edit.
            feather.valueAsNumber = 0.12
            fixture.change(control,value)
            expect(fixture.events.at(-1).sdfFeatherTexels).to.equal(0.123)
            expect(fixture.snapshot.presentation.sdfFeatherTexels).to.equal(0.123)
        }
        feather.valueAsNumber = 0.13
        feather.dispatchEvent(new Event('input'))
        expect(fixture.snapshot.presentation.sdfFeatherTexels).to.equal(0.13)
        fixture.controls.dispose()
    })
})

function controlsFixture() {
    const document = {createElement(tagName) { return new ElementFixture(tagName, document) }}
    const container = document.createElement('main')
    const snapshot = {
        dataset:{id:'test',minimumTime:0,maximumTime:26,timeUnit:'ordinal',velocityUnit:'m/s',sampleCount:27},
        timeline:{modelTime:2.5,playing:false,rate:0.2,loop:'loop',selection:{kind:'exact',sample:{sampleKey:'t02'}}},
        presented:{presentedModelTime:2.5},state:'ready',runtimeCount:2,presentation:FLOW_FIELD_PRESENTATION,
    }
    const events = []
    const controls = mountFlowFieldControls({
        container,onPlay() {},onPause() {},onSeek() {},onRate() {},onLoop() {},
        onPresentation(value) { events.push(value); snapshot.presentation = value; controls.update(snapshot) },
    })
    const root = container.children[0]
    const find = name => root.querySelector(`[data-flow-control="${name}"]`)
    return {container,snapshot,events,controls,find,change(name,value) {
        const control = find(name)
        control.value = value
        control.dispatchEvent(new Event('change'))
    }}
}

// This fixture exercises actual controller state/events without adding a DOM
// package or launching a browser. It is not a layout or accessibility proof.
class ElementFixture extends EventTarget {
    constructor(tagName, document) {
        super()
        this.tagName = tagName
        this.ownerDocument = document
        this.children = []
        this.options = []
        this.controls = new Map()
        this.attributes = new Map()
        this.dataset = {}
        this.value = ''
        this.min = ''
        this.max = ''
        this.step = ''
        this.checked = false
        this.hidden = false
        this.disabled = false
        this.textContent = ''
    }
    set innerHTML(markup) {
        for (const match of markup.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bdata-flow-control="([^"]+)"[^>]*)>/g)) {
            const element = this.ownerDocument.createElement(match[1])
            element.hidden = /\bhidden\b/.test(match[2])
            for (const name of ['min','max','step','value','type']) {
                const attribute = match[2].match(new RegExp(`\\b${name}="([^"]*)"`))
                if (attribute) element[name] = attribute[1]
            }
            this.controls.set(match[3], element)
            if (match[1] === 'select') {
                const end = markup.indexOf('</select>', match.index)
                const source = markup.slice(match.index + match[0].length, end)
                for (const option of source.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)) {
                    const child = this.ownerDocument.createElement('option')
                    child.value = option[1]
                    child.textContent = option[2]
                    element.append(child)
                }
            }
        }
    }
    setAttribute(name, value) { this.attributes.set(name, value) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    querySelector(selector) {
        if (selector === '[data-custom-rate]') return this.options.find(value => value.dataset.customRate) ?? null
        const match = selector.match(/^\[data-flow-control="([^"]+)"\]$/)
        return match ? this.controls.get(match[1]) ?? null : null
    }
    append(child) {
        child.parent = this
        this.children.push(child)
        if (child.tagName === 'option') this.options.push(child)
    }
    remove() {
        if (!this.parent) return
        this.parent.children = this.parent.children.filter(value => value !== this)
        this.parent.options = this.parent.options.filter(value => value !== this)
        this.parent = undefined
    }
    addEventListener(type, callback, options) {
        if (options?.signal) setMaxListeners(0, options.signal)
        super.addEventListener(type, callback, options)
    }
    get valueAsNumber() { return Number(this.value) }
    set valueAsNumber(value) { this.value = String(value) }
}
