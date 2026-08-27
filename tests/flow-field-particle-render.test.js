import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const sourcePath = path.join(
    process.cwd(), 'examples', 'flowField', 'flow-particle-render.ts'
)
const shaderPath = path.join(
    process.cwd(), 'examples', 'flowField', 'shaders', 'particle-render.wgsl'
)

describe('Flow Field particle line draw', () => {

    it('borrows canonical particle and shared view resources through two bind groups', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include('particles: Pick<FlowParticles')
        expect(source).to.include("name: 'flowParticleRenderRecords'")
        expect(source).to.include("type: 'read-storage'")
        expect(source).to.include('group: 0')
        expect(source).to.include('view: FlowRenderViewBinding')
        expect(source).to.include('bindLayouts: [ particleLayout, view.bindLayout ]')
        expect(source).to.include('{ set: view.bindSet }')
        expect(source).to.include('...currentReads(view.resources)')
        expect(source).to.not.include('particles.resources.particles.dispose()')
        expect(source).to.not.include('view.bindSet.dispose()')
        expect(source).to.not.include('view.bindLayout.dispose()')
    })

    it('creates one rgba8unorm history-compatible line-list draw', () => {

        const source = fs.readFileSync(sourcePath, 'utf8')
        expect(source).to.include("targetFormat = options.targetFormat ?? 'rgba8unorm'")
        expect(source).to.include("primitive: { topology: 'line-list' }")
        expect(source).to.include('count: { vertexCount: particleCount * 2 }')
        expect(source).to.include("contentEpoch: 'current-at-step'")
        expect(source).to.not.match(/readback|runtime\.(?:device|queue)/i)
        expect(source).to.not.match(/packages\/geoscratch\/src|flowLayer/)
    })

    it('projects previous/current wide-fixed endpoints camera-relatively and suppresses rebirth lines', () => {

        const shader = fs.readFileSync(shaderPath, 'utf8')
        expect(shader).to.include('current: FlowParticleFixedPosition')
        expect(shader).to.include('previous: FlowParticleFixedPosition')
        expect(shader).to.include('clipFromRelativeWorld: mat4x4f')
        expect(shader).to.include('cameraX: vec2u')
        expect(shader).to.include('cameraY: vec2u')
        expect(shader).to.include('fixedDifferenceMeters(')
        expect(shader).to.include('particle.lifecycle_state == FLOW_PARTICLE_ACTIVE')
        expect(shader).to.include('sameFixedPosition(particle.current, particle.previous)')
        expect(shader).to.include('visible = visible && !sameFixedPosition')
        expect(shader).to.include('contourView.clipFromRelativeWorld * relative')
        expect(shader).to.not.match(/normalizedWorld|worldPosition:\s*vec2f/)
    })
})
