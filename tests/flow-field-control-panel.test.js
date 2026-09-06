import { expect } from 'chai'
import { setMaxListeners } from 'node:events'
import { mountFlowFieldControls } from '../examples/flowField/control-panel.ts'
import { FLOW_FIELD_PRESENTATION } from '../examples/flowField/flow-presentation.ts'

describe('Flow Field boundary controls (Node DOM fixture)', () => {
    it('defaults to A and only enables the boundary choice for particles', () => {
        const fixture = controlsFixture()
        const boundary = fixture.find('boundary')
        expect(boundary.disabled).to.equal(true)
        fixture.controls.update(fixture.snapshot)
        expect(boundary.value).to.equal('hard')
        expect(boundary.disabled).to.equal(false)
        expect(boundary.options.map(value => value.textContent)).to.deep.equal([
            'A · Hard texture', 'B · SDF (inward)',
        ])
        expect(fixture.find('sample').disabled).to.equal(true)
        expect(fixture.find('trails').disabled).to.equal(false)
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
            expect(fixture.find('legend').textContent).to.include('Unfiltered diagnostics')
            expect(fixture.find('legend').textContent).to.include('boundary A/B inactive')
            expect(fixture.find('sample').disabled).to.equal(false)
            expect(fixture.find('trails').disabled).to.equal(true)
        }
        fixture.change('sample', 'upper')
        fixture.change('view', 'particles')
        expect(fixture.find('boundary').disabled).to.equal(false)
        expect(fixture.find('boundary').value).to.equal('sdf')
        expect(fixture.snapshot.presentation.sample).to.equal('upper')
        expect(fixture.snapshot.presentation.trails).to.equal(true)
        expect(fixture.snapshot.presentation.contour).to.equal(false)
        expect(fixture.find('legend').textContent).to.include('Inner-edge display only')
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
        expect(fixture.events.at(-1)).to.deep.equal({...legacy,boundary:'sdf'})
        fixture.controls.setStatus('stopped')
        expect(fixture.find('boundary').disabled).to.equal(true)
        const boundary = fixture.find('boundary'), eventCount = fixture.events.length
        fixture.controls.dispose()
        fixture.controls.dispose()
        boundary.dispatchEvent(new Event('change'))
        expect(fixture.events.length).to.equal(eventCount)
        expect(fixture.container.children).to.have.length(0)
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
        this.checked = false
        this.hidden = false
        this.disabled = false
        this.textContent = ''
    }
    set innerHTML(markup) {
        for (const match of markup.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bdata-flow-control="([^"]+)"[^>]*)>/g)) {
            const element = this.ownerDocument.createElement(match[1])
            element.hidden = /\bhidden\b/.test(match[2])
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
}
