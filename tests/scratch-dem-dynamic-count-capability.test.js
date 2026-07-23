import { expect } from 'chai'
import { ScratchRuntime } from 'geoscratch'
import {
    createFakeGpu,
    defaultRenderStateActions,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_DST = 0x08
const GPU_BUFFER_USAGE_INDIRECT = 0x100
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

function indirectWords(buffer) {

    return Array.from(new Uint32Array(
        buffer.data.buffer,
        buffer.data.byteOffset,
        buffer.data.byteLength / Uint32Array.BYTES_PER_ELEMENT
    ))
}

function dynamicCountFacts(submitted, resources) {

    const resourceIds = new Set(resources.map(resource => resource.id))

    return submitted.resourceAccesses
        .filter(access => resourceIds.has(access.resourceId))
        .map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            commandId: access.commandId,
            resourceId: access.resourceId,
            access: access.access,
            declaredContentEpoch: access.declaredContentEpoch,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))
}

describe('scratch DEM CPU-dynamic count capability', () => {

    it('reuses stable uploads and indirect draws while payloads advance across submissions', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const program = runtime.createProgram({
            modules: [ triangleWgsl ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const pipeline = await runtime.createRenderPipeline({
            program,
            targets: [ { format: 'rgba8unorm' } ],
        })
        const target = await runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const pass = runtime.createRenderPass({
            color: [ {
                target: target.view(),
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const lodArguments = await runtime.createBuffer({
            label: 'DEM LoD indirect arguments',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDIRECT,
        })
        const terrainArguments = await runtime.createBuffer({
            label: 'DEM terrain indirect arguments',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_INDIRECT,
        })
        const lodPayload = new Uint32Array([ 4, 2, 0, 0 ])
        const terrainPayload = new Uint32Array([ 384, 2, 0, 0 ])
        const uploadLodArguments = runtime.createUploadCommand({
            label: 'upload DEM LoD indirect arguments',
            target: lodArguments.region(),
            data: lodPayload,
        })
        const uploadTerrainArguments = runtime.createUploadCommand({
            label: 'upload DEM terrain indirect arguments',
            target: terrainArguments.region(),
            data: terrainPayload,
        })
        const drawLod = runtime.createDrawCommand({
            label: 'draw DEM LoD map',
            pipeline,
            count: { indirect: lodArguments.region() },
            resources: {
                read: [ { resource: lodArguments, contentEpoch: 'current-at-step' } ],
                write: [],
            },
            whenMissing: 'throw',
        })
        const drawTerrain = runtime.createDrawCommand({
            label: 'draw DEM terrain',
            pipeline,
            count: { indirect: terrainArguments.region() },
            resources: {
                read: [ { resource: terrainArguments, contentEpoch: 'current-at-step' } ],
                write: [],
            },
            whenMissing: 'throw',
        })

        const first = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadLodArguments)
            .upload(uploadTerrainArguments)
            .render(pass, [ drawLod, drawTerrain ])
            .submit()

        expect(indirectWords(lodArguments.gpuBuffer)).to.deep.equal([ 4, 2, 0, 0 ])
        expect(indirectWords(terrainArguments.gpuBuffer)).to.deep.equal([ 384, 2, 0, 0 ])

        lodPayload[1] = 5
        terrainPayload[1] = 5

        const second = runtime.createSubmission({ validation: 'throw' })
            .upload(uploadLodArguments)
            .upload(uploadTerrainArguments)
            .render(pass, [ drawLod, drawTerrain ])
            .submit()

        expect(indirectWords(lodArguments.gpuBuffer)).to.deep.equal([ 4, 5, 0, 0 ])
        expect(indirectWords(terrainArguments.gpuBuffer)).to.deep.equal([ 384, 5, 0, 0 ])
        expect(fake.calls.queueTimeline.map(action => action.type)).to.deep.equal([
            'write-buffer',
            'write-buffer',
            'submit',
            'write-buffer',
            'write-buffer',
            'submit',
        ])
        expect(fake.calls.renderPasses.map(renderPass => renderPass.actions)).to.deep.equal([
            [
                { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
                ...defaultRenderStateActions(4, 4),
                { type: 'drawIndirect', buffer: lodArguments.gpuBuffer, offset: 0 },
                { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
                ...defaultRenderStateActions(4, 4),
                { type: 'drawIndirect', buffer: terrainArguments.gpuBuffer, offset: 0 },
                { type: 'end' },
            ],
            [
                { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
                ...defaultRenderStateActions(4, 4),
                { type: 'drawIndirect', buffer: lodArguments.gpuBuffer, offset: 0 },
                { type: 'setPipeline', pipeline: pipeline.gpuPipeline },
                ...defaultRenderStateActions(4, 4),
                { type: 'drawIndirect', buffer: terrainArguments.gpuBuffer, offset: 0 },
                { type: 'end' },
            ],
        ])

        expect(dynamicCountFacts(first, [ lodArguments, terrainArguments ])).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadLodArguments.id,
                resourceId: lodArguments.id,
                access: 'write',
                declaredContentEpoch: undefined,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 1,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadTerrainArguments.id,
                resourceId: terrainArguments.id,
                access: 'write',
                declaredContentEpoch: undefined,
                contentEpochBefore: 0,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 2,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: drawLod.id,
                resourceId: lodArguments.id,
                access: 'read',
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
            {
                stepIndex: 2,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: drawTerrain.id,
                resourceId: terrainArguments.id,
                access: 'read',
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 1,
                contentEpochAfter: 1,
            },
        ])
        expect(dynamicCountFacts(second, [ lodArguments, terrainArguments ])).to.deep.equal([
            {
                stepIndex: 0,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadLodArguments.id,
                resourceId: lodArguments.id,
                access: 'write',
                declaredContentEpoch: undefined,
                contentEpochBefore: 1,
                contentEpochAfter: 2,
            },
            {
                stepIndex: 1,
                stepKind: 'upload',
                commandKind: 'upload',
                commandId: uploadTerrainArguments.id,
                resourceId: terrainArguments.id,
                access: 'write',
                declaredContentEpoch: undefined,
                contentEpochBefore: 1,
                contentEpochAfter: 2,
            },
            {
                stepIndex: 2,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: drawLod.id,
                resourceId: lodArguments.id,
                access: 'read',
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 2,
                contentEpochAfter: 2,
            },
            {
                stepIndex: 2,
                stepKind: 'render',
                commandKind: 'draw',
                commandId: drawTerrain.id,
                resourceId: terrainArguments.id,
                access: 'read',
                declaredContentEpoch: 'current-at-step',
                contentEpochBefore: 2,
                contentEpochAfter: 2,
            },
        ])
        expect(first.producerEpochs.filter(epoch =>
            [ lodArguments.id, terrainArguments.id ].includes(epoch.resourceId)
        ).map(epoch => ({
            resourceId: epoch.resourceId,
            contentEpoch: epoch.contentEpoch,
            stepIndex: epoch.producedBy.stepIndex,
            commandId: epoch.producedBy.commandId,
        }))).to.deep.equal([
            { resourceId: lodArguments.id, contentEpoch: 1, stepIndex: 0, commandId: uploadLodArguments.id },
            { resourceId: terrainArguments.id, contentEpoch: 1, stepIndex: 1, commandId: uploadTerrainArguments.id },
        ])
        expect(second.producerEpochs.filter(epoch =>
            [ lodArguments.id, terrainArguments.id ].includes(epoch.resourceId)
        ).map(epoch => ({
            resourceId: epoch.resourceId,
            contentEpoch: epoch.contentEpoch,
            stepIndex: epoch.producedBy.stepIndex,
            commandId: epoch.producedBy.commandId,
        }))).to.deep.equal([
            { resourceId: lodArguments.id, contentEpoch: 2, stepIndex: 0, commandId: uploadLodArguments.id },
            { resourceId: terrainArguments.id, contentEpoch: 2, stepIndex: 1, commandId: uploadTerrainArguments.id },
        ])

        expect(uploadLodArguments.data).to.equal(lodPayload)
        expect(uploadTerrainArguments.data).to.equal(terrainPayload)
        expect(lodArguments.contentEpoch).to.equal(2)
        expect(terrainArguments.contentEpoch).to.equal(2)
        expect(fake.calls.maps).to.deep.equal([])

        await Promise.all([ first.done, second.done ])
    })
})
