import { expect } from 'chai'
import { createLayoutReadbackView, GPURuntime } from 'geoscratch/scratch'
import {
    GeoDiagnosticError, WebMercatorQuad, tileMatrixCoverage,
    webMercatorVirtualRasterField, prepareWebMercatorVirtualRasterSampler,
    webMercatorVirtualRasterWgslModule, createWebMercatorVirtualRasterSamplerBinding,
    VirtualRasterGpuState,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

describe('WebMercator raster sampler metadata', () => {

    it('directly maps sparse matrix ids to compact row-major page table addresses', () => {
        const model = field(['4', '6', '9'])
        const prepared = prepareWebMercatorVirtualRasterSampler(model)
        const data = decode(prepared)
        expect(data.dimensions).to.deep.equal([3, 256, 256, 40])
        for (let matrix = 0; matrix <= 24; matrix++) {
            const index = data.levelForMatrix[Math.floor(matrix / 4)][matrix % 4]
            const limit = model.coverage.limit(String(matrix))
            if (!limit) { expect(index).to.equal(0xffff_ffff); continue }
            const entry = data.levels[index]
            expect(entry.mapping[0]).to.equal(matrix)
            for (let row = limit.minTileRow; row <= limit.maxTileRow; row++) {
                for (let col = limit.minTileCol; col <= limit.maxTileCol; col++) {
                    expect(entry.mapping[1] + (row - entry.tileBounds[1]) * entry.mapping[2] + col - entry.tileBounds[0])
                        .to.equal(model.coverage.index({matrixId: String(matrix), tileRow: row, tileCol: col}))
                }
            }
            const half = BigInt(entry.halfTexel[0]) + (BigInt(entry.halfTexel[1]) << 32n)
            expect(half).to.equal(1n << BigInt(40 - matrix - 9))
        }
        expect(data.levels.slice(3).every(value => value.mapping[3] === 0)).to.equal(true)
    })

    it('keeps one uniform ABI across different source coverage and returns owned byte copies', () => {
        const a = prepareWebMercatorVirtualRasterSampler(field(['4', '5', '6']))
        const b = prepareWebMercatorVirtualRasterSampler(field(['2', '7']))
        expect(a.layout).to.equal(b.layout)
        expect(a.pack().byteLength).to.equal(1808)
        expect(b.pack().byteLength).to.equal(a.pack().byteLength)
        const bytes = a.pack(), original = a.pack()
        bytes.fill(0)
        expect(a.pack()).to.deep.equal(original)
        expect(Object.isFrozen(a)).to.equal(true)
    })

    it('packs decoding facts and represents the eastern world edge without wrapping it to zero', () => {
        const model = field(['0'], {bounds: [-180, -80, 180, 80], sampleType: 'unorm8',
            channels: 1, fieldKind: 'scalar', gpuFormat: 'r8unorm', noData: 255, scale: 2, offset: -4})
        const data = decode(prepareWebMercatorVirtualRasterSampler(model))
        expect(data.decoding).to.deep.equal([255, 2, 255, 0])
        expect(data.scale).to.deep.equal([2, 2, 2, 2])
        expect(data.offset).to.deep.equal([-4, -4, -4, -4])
        expect(data.sourceEastSouth.slice(0, 2)).to.deep.equal([0, 256])
        expect(data.levels[0].texelBounds[2]).to.equal(255)
    })

    it('rejects mixed source address-space ownership with a structured diagnostic', () => {
        const a = field(['4']), b = field(['5'])
        try { prepareWebMercatorVirtualRasterSampler({...a, plane: b.plane}) }
        catch (error) {
            expect(error).to.be.instanceOf(GeoDiagnosticError)
            expect(error.diagnostic.code).to.equal('GEO_RASTER_SAMPLER_METADATA_INVALID')
            return
        }
        throw new Error('Mixed model was accepted')
    })

    it('generates identical shader code when coverage, bounds and decoding data change', () => {
        const a = field(['4', '6']), b = field(['2', '7'], {bounds: [5, -4, 8, 4], scale: [2, 3], offset: [-4, 7], noData: -99})
        const options = {namespace: 'Sampler', group: 0, pageTableBinding: 0, atlasBinding: 1, metadataBinding: 2}
        const first = webMercatorVirtualRasterWgslModule(a, options)
        const second = webMercatorVirtualRasterWgslModule(b, options)
        expect(first.code).to.equal(second.code)
        expect(first.code).to.equal(first.addressCode + '\n\n' + first.samplingCode)
        expect(first.bindings.metadata).to.equal(2)
        expect(first.code).to.not.include('const Sampler_matrix =')
        expect(first.code).to.not.include('const SamplerAddress_limit_count =')
        expect(first.code).to.include('Sampler_index_at_level(level, tile)')
        expect(webMercatorVirtualRasterWgslModule(a, {...options, metadataBinding: undefined}).code)
            .to.not.include('fn Sampler_level_count_value(')
        expect(() => webMercatorVirtualRasterWgslModule(a, {...options, metadataBinding: 1})).to.throw(GeoDiagnosticError)
    })

    it('initializes immutable uniform storage and never owns the borrowed raster', async () => {
        const fake = createFakeGpu(), runtime = await GPURuntime.create({gpu: fake.gpu})
        const model = field(['4'])
        const gpu = await VirtualRasterGpuState.create(runtime, {addressSpace: model.addressSpace, plane: model.plane, maxPhysicalPages: 4})
        const first = await createWebMercatorVirtualRasterSamplerBinding(model, gpu)
        const second = await createWebMercatorVirtualRasterSamplerBinding(model, gpu)
        expect(first.metadata.buffer).to.not.equal(second.metadata.buffer)
        expect(first.metadata.buffer.usage).to.equal(0x40)
        expect(first.metadata.buffer.contentEpoch).to.equal(1)
        expect(first.metadata.buffer.state).to.equal('ready')
        expect(first.metadata.buffer.gpuBuffer.data).to.deep.equal(prepareWebMercatorVirtualRasterSampler(model).pack())
        expect(first.pageTable.buffer).to.equal(gpu.pageTable)
        expect(first.atlas).to.equal(gpu.atlasView)
        first.dispose()
        first.dispose()
        expect(first.metadata.buffer.isDisposed).to.equal(true)
        expect(second.metadata.buffer.isDisposed).to.equal(false)
        expect(gpu.atlas.isDisposed).to.equal(false)
        expect(gpu.pageTable.isDisposed).to.equal(false)
        try { await createWebMercatorVirtualRasterSamplerBinding(field(['5']), gpu); throw new Error('accepted foreign raster') }
        catch (error) { expect(error.diagnostic?.code).to.equal('GEO_RASTER_SAMPLER_BINDING_MISMATCH') }
        second.dispose(); gpu.dispose(); await runtime.dispose()
    })

    for (const method of ['getMappedRange', 'unmap']) it(`cleans owned metadata when native ${method} fails`, async () => {
        const fake = createFakeGpu(), runtime = await GPURuntime.create({gpu: fake.gpu})
        const model = field(['4']), gpu = await VirtualRasterGpuState.create(runtime, {
            addressSpace: model.addressSpace, plane: model.plane, maxPhysicalPages: 4,
        })
        const before = fake.calls.bufferDestroys.length
        fake.errors.throwNext(method, new Error('sampler native failure'))
        let failure
        try { await createWebMercatorVirtualRasterSamplerBinding(model, gpu) } catch (error) { failure = error }
        expect(failure).to.be.instanceOf(Error)
        expect(fake.calls.bufferDestroys.length).to.equal(before + 1)
        expect(gpu.pageTable.isDisposed).to.equal(false)
        expect(gpu.atlas.isDisposed).to.equal(false)
        gpu.dispose(); await runtime.dispose()
    })

    it('rejects disposal of the borrowed raster during asynchronous metadata creation', async () => {
        const fake = createFakeGpu(), runtime = await GPURuntime.create({gpu: fake.gpu})
        const model = field(['4']), gpu = await VirtualRasterGpuState.create(runtime, {
            addressSpace: model.addressSpace, plane: model.plane, maxPhysicalPages: 4,
        })
        const create = runtime.createMappedBuffer.bind(runtime)
        let allocated
        runtime.createMappedBuffer = async descriptor => {
            const result = await create(descriptor); allocated = result.buffer; gpu.dispose(); return result
        }
        let failure
        try { await createWebMercatorVirtualRasterSamplerBinding(model, gpu) } catch (error) { failure = error }
        expect(failure?.diagnostic?.code).to.equal('GEO_RASTER_SAMPLER_BINDING_MISMATCH')
        expect(allocated.isDisposed).to.equal(true)
        await runtime.dispose()
    })
})

function decode(prepared) {
    return createLayoutReadbackView(prepared.layout.artifact, prepared.pack()).toObject()
}

function field(matrices, options = {}) {
    const bounds = options.bounds ?? [0, -2, 3, 2]
    const limits = matrices.map(matrixId => {
        const first = WebMercatorQuad.tileFromLonLat([bounds[0], bounds[3]], matrixId)
        const last = WebMercatorQuad.tileFromLonLat([bounds[2] === 180 ? 179.99 : bounds[2], bounds[1]], matrixId)
        return {matrixId, minTileRow: first.tileRow, maxTileRow: last.tileRow,
            minTileCol: first.tileCol, maxTileCol: last.tileCol}
    })
    return webMercatorVirtualRasterField({
        id: 'sampler', addressSpaceId: 'sampler.' + matrices.join('-'), sourceRevision: '1',
        coverage: tileMatrixCoverage({tileMatrixSet: WebMercatorQuad, limits}), geographicBounds: bounds,
        fieldKind: 'vector', channels: 2, sampleType: 'float32', gpuFormat: 'rg32float',
        interpolation: 'linear', ...options,
    })
}
