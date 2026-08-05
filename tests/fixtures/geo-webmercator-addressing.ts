import {
    WebMercatorQuad,
    tileMatrixCoverage,
    webMercatorQuadAddressCodec,
} from 'geoscratch/geo'

const OUTPUT_STRIDE = 40
const gpuConstants = globalThis as unknown as Readonly<{
    GPUBufferUsage: Readonly<{
        COPY_DST: number
        COPY_SRC: number
        MAP_READ: number
        STORAGE: number
    }>
    GPUMapMode: Readonly<{ READ: number }>
}>

export async function runGeoWebMercatorAddressingProof() {

    if (navigator.gpu === undefined) throw new Error('WebGPU is unavailable.')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (adapter === null) throw new Error('No WebGPU adapter is available.')
    const device = await adapter.requestDevice()
    const uncapturedErrors: string[] = []
    device.addEventListener('uncapturederror', event => {
        if (uncapturedErrors.length < 8) uncapturedErrors.push(event.error.message)
    })
    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            { matrixId: '8', minTileRow: 101, maxTileRow: 103, minTileCol: 212, maxTileCol: 215 },
            { matrixId: '9', minTileRow: 202, maxTileRow: 207, minTileCol: 424, maxTileCol: 431 },
        ],
    })
    const codec = webMercatorQuadAddressCodec({ coverage, coordinateBits: 52 })
    const world = 1n << 52n
    type ProofInput = Readonly<{
        matrixId: string
        position: ReturnType<typeof codec.fromWorldQuanta>
        delta: readonly [number, number]
        deltaMeters?: readonly [number, number]
    }>
    const inputs: readonly ProofInput[] = [
        {
            matrixId: '8',
            position: codec.fromWorldQuanta([
                BigInt(212 * 256) << 36n,
                BigInt(101 * 256) << 36n,
            ]),
            delta: [ 0, 0 ] as const,
        },
        {
            matrixId: '9',
            position: codec.fromWorldQuanta([
                (BigInt(424 * 256 + 17) << 35n) + 1_234_567n,
                (BigInt(202 * 256 + 255) << 35n) + 34_359_738_367n,
            ]),
            delta: [ 1, 1 ] as const,
        },
        {
            matrixId: '0',
            position: codec.fromWorldQuanta([ 0xffff_ffffn, world / 2n ]),
            delta: [ 1, 0 ] as const,
        },
        {
            matrixId: '24',
            position: codec.fromWorldQuanta([ 0n, 1n ]),
            delta: [ -1, -1 ] as const,
        },
        {
            matrixId: '0',
            position: codec.fromWorldQuanta([ world / 2n, 0n ]),
            delta: [ 0, -1 ] as const,
        },
        {
            matrixId: '0',
            position: codec.fromWorldQuanta([ 100n, 100n ]),
            delta: [ 0, 0 ] as const,
            deltaMeters: [
                Math.fround(Math.fround(codec.quantumMeters) * 0.5),
                Math.fround(Math.fround(codec.quantumMeters) * -0.5),
            ] as const,
        },
    ]
    const deltas = new Int32Array(inputs.flatMap(input => input.delta))
    const deltaMeters = new Float32Array(inputs.flatMap(input =>
        input.deltaMeters ?? [ 0, 0 ]
    ))
    const deltaModes = new Uint32Array(inputs.map(input =>
        input.deltaMeters === undefined ? 0 : 1
    ))
    const cpu = inputs.map((input, inputIndex) => {
        const source = codec.toWorldQuanta(input.position)
        const meterMode = deltaModes[inputIndex] === 1
        const meterDelta = Object.freeze([
            deltaMeters[inputIndex * 2]!,
            deltaMeters[inputIndex * 2 + 1]!,
        ]) as readonly [number, number]
        const delta = meterMode
            ? codec.toWorldQuanta(codec.advanceMeters(input.position, meterDelta))
                .map((value, axis) => value - source[axis]!)
            : input.delta.map(value => BigInt(value))
        const y = source[1] + delta[1]!
        const northSouthValid = y >= 0n && y < world
        return Object.freeze({
            northSouthValid,
            address: northSouthValid
                ? codec.address(codec.advance(input.position, [ delta[0]!, delta[1]! ]), input.matrixId)
                : undefined,
        })
    })
    const positionBytes = codec.positionCodec.pack(inputs.map(input => input.position.fixed))
    const matrices = new Uint32Array(inputs.map(input => Number(input.matrixId)))
    const outputBytes = inputs.length * OUTPUT_STRIDE
    const positionBuffer = device.createBuffer({
        label: 'WebMercator parity positions',
        size: positionBytes.byteLength,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_DST,
    })
    const matrixBuffer = device.createBuffer({
        label: 'WebMercator parity matrices',
        size: matrices.byteLength,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_DST,
    })
    const deltaBuffer = device.createBuffer({
        label: 'WebMercator parity deltas',
        size: deltas.byteLength,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_DST,
    })
    const deltaMetersBuffer = device.createBuffer({
        label: 'WebMercator parity meter deltas',
        size: deltaMeters.byteLength,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_DST,
    })
    const deltaModeBuffer = device.createBuffer({
        label: 'WebMercator parity delta modes',
        size: deltaModes.byteLength,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_DST,
    })
    const outputBuffer = device.createBuffer({
        label: 'WebMercator parity output',
        size: outputBytes,
        usage: gpuConstants.GPUBufferUsage.STORAGE | gpuConstants.GPUBufferUsage.COPY_SRC,
    })
    const readbackBuffer = device.createBuffer({
        label: 'WebMercator parity readback',
        size: outputBytes,
        usage: gpuConstants.GPUBufferUsage.COPY_DST | gpuConstants.GPUBufferUsage.MAP_READ,
    })

    try {
        device.queue.writeBuffer(
            positionBuffer,
            0,
            positionBytes.buffer as ArrayBuffer,
            positionBytes.byteOffset,
            positionBytes.byteLength
        )
        device.queue.writeBuffer(matrixBuffer, 0, matrices)
        device.queue.writeBuffer(deltaBuffer, 0, deltas)
        device.queue.writeBuffer(deltaMetersBuffer, 0, deltaMeters)
        device.queue.writeBuffer(deltaModeBuffer, 0, deltaModes)
        const code = `${codec.wgslModule({ namespace: 'ProofMercator' })}\n` +
            `struct ProofOutput {\n` +
            `    address: ProofMercatorAddress,\n` +
            `    north_south_valid: u32,\n` +
            `}\n\n` +
            `@group(0) @binding(0) var<storage, read> positions: array<ProofMercatorFixedPosition>;\n` +
            `@group(0) @binding(1) var<storage, read> matrices: array<u32>;\n` +
            `@group(0) @binding(2) var<storage, read> deltas: array<vec2i>;\n` +
            `@group(0) @binding(3) var<storage, read> meter_deltas: array<vec2f>;\n` +
            `@group(0) @binding(4) var<storage, read> delta_modes: array<u32>;\n` +
            `@group(0) @binding(5) var<storage, read_write> outputs: array<ProofOutput>;\n\n` +
            `@compute @workgroup_size(1)\n` +
            `fn main(@builtin(global_invocation_id) id: vec3u) {\n` +
            `    var advanced: ProofMercatorAdvance;\n` +
            `    if (delta_modes[id.x] == 1u) {\n` +
            `        advanced = ProofMercator_advance_meters(positions[id.x], meter_deltas[id.x]);\n` +
            `    } else {\n` +
            `        advanced = ProofMercator_advance_i32(positions[id.x], deltas[id.x]);\n` +
            `    }\n` +
            `    outputs[id.x] = ProofOutput(\n` +
            `        ProofMercator_address(advanced.position, matrices[id.x]),\n` +
            `        advanced.north_south_valid,\n` +
            `    );\n` +
            `}\n`
        device.pushErrorScope('validation')
        const module = device.createShaderModule({ label: 'WebMercator parity shader', code })
        const compilationInfo = await module.getCompilationInfo()
        const compilationErrors = compilationInfo.messages
            .filter(message => message.type === 'error')
            .map(message => `${message.lineNum}:${message.linePos} ${message.message}`)
        const pipeline = await device.createComputePipelineAsync({
            label: 'WebMercator parity pipeline',
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        })
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: positionBuffer } },
                { binding: 1, resource: { buffer: matrixBuffer } },
                { binding: 2, resource: { buffer: deltaBuffer } },
                { binding: 3, resource: { buffer: deltaMetersBuffer } },
                { binding: 4, resource: { buffer: deltaModeBuffer } },
                { binding: 5, resource: { buffer: outputBuffer } },
            ],
        })
        const encoder = device.createCommandEncoder({ label: 'WebMercator parity encoder' })
        const pass = encoder.beginComputePass({ label: 'WebMercator parity pass' })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.dispatchWorkgroups(inputs.length)
        pass.end()
        encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputBytes)
        device.queue.submit([ encoder.finish() ])
        await device.queue.onSubmittedWorkDone()
        const validationError = await device.popErrorScope()
        await readbackBuffer.mapAsync(gpuConstants.GPUMapMode.READ)
        const gpu = decodeAddresses(readbackBuffer.getMappedRange(), inputs)
        readbackBuffer.unmap()
        const comparisons = cpu.map((expected, index) => compareAddress(expected, gpu[index]!))
        return Object.freeze({
            adapter: Object.freeze({
                vendor: adapter.info.vendor,
                architecture: adapter.info.architecture,
                device: adapter.info.device,
                description: adapter.info.description,
            }),
            coordinateBits: codec.coordinateBits,
            bytesPerPosition: codec.bytesPerPosition,
            quantumMeters: codec.quantumMeters,
            coverageEntryCount: coverage.entryCount,
            vectorCount: inputs.length,
            outputStride: OUTPUT_STRIDE,
            cpu,
            gpu,
            comparisons,
            allMatch: comparisons.every(comparison => comparison.matches),
            compilationErrors,
            validationError: validationError?.message,
            uncapturedErrors,
        })
    } finally {
        positionBuffer.destroy()
        matrixBuffer.destroy()
        deltaBuffer.destroy()
        deltaMetersBuffer.destroy()
        deltaModeBuffer.destroy()
        outputBuffer.destroy()
        readbackBuffer.destroy()
        device.destroy()
    }
}

function decodeAddresses(
    buffer: ArrayBuffer,
    inputs: readonly Readonly<{ matrixId: string }>[]
) {

    const view = new DataView(buffer)
    return inputs.map((input, index) => {
        const offset = index * OUTPUT_STRIDE
        return Object.freeze({
            matrixId: input.matrixId,
            tileCol: view.getUint32(offset, true),
            tileRow: view.getUint32(offset + 4, true),
            texel: Object.freeze([
                view.getUint32(offset + 8, true),
                view.getUint32(offset + 12, true),
            ]),
            subTexel: Object.freeze([
                view.getFloat32(offset + 16, true),
                view.getFloat32(offset + 20, true),
            ]),
            compactIndex: view.getUint32(offset + 24, true),
            covered: view.getUint32(offset + 28, true) === 1,
            northSouthValid: view.getUint32(offset + 32, true) === 1,
        })
    })
}

function compareAddress(
    expected: Readonly<{
        northSouthValid: boolean
        address: ReturnType<ReturnType<typeof webMercatorQuadAddressCodec>['address']> | undefined
    }>,
    actual: ReturnType<typeof decodeAddresses>[number]
) {

    if (!expected.northSouthValid || expected.address === undefined) {
        return Object.freeze({
            matches: !actual.northSouthValid,
            fields: Object.freeze([ actual.northSouthValid === expected.northSouthValid ]),
        })
    }
    const expectedAddress = expected.address
    const expectedIndex = expectedAddress.compactIndex ?? 0xffff_ffff
    const differences = [
        actual.northSouthValid === expected.northSouthValid,
        actual.tileCol === expectedAddress.tile.tileCol,
        actual.tileRow === expectedAddress.tile.tileRow,
        actual.texel[0] === expectedAddress.texel[0],
        actual.texel[1] === expectedAddress.texel[1],
        actual.subTexel[0] === expectedAddress.subTexel[0],
        actual.subTexel[1] === expectedAddress.subTexel[1],
        actual.compactIndex === expectedIndex,
        actual.covered === expectedAddress.covered,
    ]
    return Object.freeze({
        matches: differences.every(Boolean),
        fields: Object.freeze(differences),
    })
}
