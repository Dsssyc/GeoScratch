import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { layoutCodec } from '../../packages/geoscratch/dist/index.js'

const iterations = positiveInteger(
    process.env.SCRATCH_LAYOUT_CODEC_ITERATIONS,
    20_000
)
const allowShort = process.env.SCRATCH_LAYOUT_CODEC_ALLOW_SHORT === '1'
const MAX_HEAP_GROWTH_BYTES = 128 * 1024 * 1024
const MAX_SERIALIZED_EVIDENCE_BYTES = 64 * 1024

if (!allowShort) {
    assertStress(
        iterations >= 20_000,
        'layout-codec stress must run at least 20,000 fixed/runtime cycles'
    )
}

const fixed = layoutCodec({
    name: 'StressFixedRoot',
    fields: [
        {
            name: 'header',
            type: {
                kind: 'struct',
                name: 'StressHeader',
                fields: [
                    { name: 'sequence', type: 'u32' },
                    { name: 'gain', type: 'f16' },
                ],
            },
            align: 16,
            size: 16,
        },
        { name: 'basis', type: 'mat3x2f' },
        {
            name: 'samples',
            type: {
                kind: 'array',
                count: 2,
                element: {
                    kind: 'struct',
                    name: 'StressSample',
                    fields: [
                        { name: 'position', type: 'vec3f' },
                        { name: 'weight', type: 'f32' },
                    ],
                },
            },
        },
    ],
})
const runtime = layoutCodec({
    name: 'StressRuntimeRoot',
    fields: [
        { name: 'declaredCount', type: 'u32' },
        {
            name: 'values',
            type: {
                kind: 'runtime-array',
                element: {
                    kind: 'struct',
                    name: 'StressRuntimeValue',
                    fields: [
                        { name: 'position', type: 'vec3f' },
                        { name: 'weight', type: 'f32' },
                    ],
                },
            },
        },
    ],
})

const fixedArtifact = fixed.artifact
const runtimeArtifact = runtime.artifact
const fixedAbiHash = fixedArtifact.abiHash
const fixedSchemaHash = fixedArtifact.schemaHash
const runtimeAbiHash = runtimeArtifact.abiHash
const runtimeSchemaHash = runtimeArtifact.schemaHash
const fixedWgsl = fixed.wgslAccessors({ namespace: 'StressFixedLayout' })
const runtimeWgsl = runtime.wgslAccessors({ namespace: 'StressRuntimeLayout' })
const initialHeapBytes = process.memoryUsage().heapUsed
let peakHeapBytes = initialHeapBytes
let packedByteCount = 0
let maxRuntimeByteLength = 0
const startedAt = performance.now()

for (let index = 0; index < iterations; index++) {
    const sequence = index >>> 0
    const fixedValue = {
        header: {
            sequence,
            gain: sequence % 16,
        },
        basis: [
            [ 1, 0 ],
            [ 0, 1 ],
            [ sequence % 8, sequence % 4 ],
        ],
        samples: [
            {
                position: [ sequence, sequence + 1, sequence + 2 ],
                weight: sequence + 3,
            },
            {
                position: [ sequence + 4, sequence + 5, sequence + 6 ],
                weight: sequence + 7,
            },
        ],
    }
    const fixedBytes = fixed.pack(fixedValue)
    const fixedResult = fixed.createReadbackView(fixedBytes).toObject()
    assertStress(
        fixedResult.header.sequence === sequence,
        'fixed nested round trip changed sequence'
    )
    assertStress(
        fixedResult.samples[1].weight === sequence + 7,
        'fixed nested round trip changed the final sample'
    )

    const runtimeElementCount = index % 8 + 1
    const values = Array.from({ length: runtimeElementCount }, (_, valueIndex) => ({
        position: [
            sequence + valueIndex,
            sequence + valueIndex + 1,
            sequence + valueIndex + 2,
        ],
        weight: sequence + valueIndex + 3,
    }))
    const runtimeBytes = runtime.pack({
        declaredCount: runtimeElementCount,
        values,
    }, {
        runtimeElementCount,
    })
    const runtimeView = runtime.createReadbackView(runtimeBytes)
    const runtimeResult = runtimeView.toObject()
    assertStress(
        runtimeView.runtimeElementCount === runtimeElementCount,
        'runtime element count did not match the exact byte extent'
    )
    assertStress(
        runtimeResult.values.at(-1).weight ===
            sequence + runtimeElementCount + 2,
        'runtime-tail round trip changed the final value'
    )
    assertStress(
        runtimeBytes.byteLength === runtime.byteLength({
            runtimeElementCount,
        }),
        'runtime byte length drifted from the artifact extent'
    )

    packedByteCount += fixedBytes.byteLength + runtimeBytes.byteLength
    maxRuntimeByteLength = Math.max(
        maxRuntimeByteLength,
        runtimeBytes.byteLength
    )
    if ((index + 1) % 256 === 0 || index + 1 === iterations) {
        peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
    }
}

assertStress(fixed.artifact === fixedArtifact, 'fixed artifact identity changed')
assertStress(runtime.artifact === runtimeArtifact, 'runtime artifact identity changed')
assertStress(fixed.artifact.abiHash === fixedAbiHash, 'fixed ABI hash changed')
assertStress(fixed.artifact.schemaHash === fixedSchemaHash, 'fixed schema hash changed')
assertStress(runtime.artifact.abiHash === runtimeAbiHash, 'runtime ABI hash changed')
assertStress(runtime.artifact.schemaHash === runtimeSchemaHash, 'runtime schema hash changed')
assertStress(
    fixed.wgslAccessors({ namespace: 'StressFixedLayout' }) === fixedWgsl,
    'fixed generated WGSL changed'
)
assertStress(
    runtime.wgslAccessors({ namespace: 'StressRuntimeLayout' }) === runtimeWgsl,
    'runtime generated WGSL changed'
)

const heapGrowthBytes = peakHeapBytes - initialHeapBytes
assertStress(
    heapGrowthBytes <= MAX_HEAP_GROWTH_BYTES,
    'layout-codec heap growth exceeded the bounded stress budget'
)

const result = {
    schemaVersion: 1,
    environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        iterations,
    },
    measurementBoundary: {
        cycle: 'one nested fixed pack/readback plus one runtime-tail pack/readback',
        gpuObjects: 'none',
        retainedArtifacts: 2,
        retainedGeneratedModules: 2,
    },
    facts: {
        fixedAbiHash,
        fixedSchemaHash,
        runtimeAbiHash,
        runtimeSchemaHash,
        fixedByteLength: fixed.byteLength(),
        runtimeMinimumBindingSize: runtime.artifact.minimumBindingSize,
        maxRuntimeByteLength,
        packedByteCount,
    },
    terminal: {
        liveAttemptLocalHandles: 0,
        activeMappedReadbackLeases: 0,
        stagingBytes: 0,
        pendingOperations: 0,
        retainedNativeHandles: 0,
    },
    bounds: {
        initialHeapBytes,
        peakHeapBytes,
        heapGrowthBytes,
        maxHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
        maxSerializedEvidenceBytes: MAX_SERIALIZED_EVIDENCE_BYTES,
    },
    timing: {
        durationMs: performance.now() - startedAt,
    },
    verification: {
        status: 'passed',
        minimumEnforced: !allowShort,
        minimumIterations: allowShort ? 1 : 20_000,
    },
}

const serialized = JSON.stringify(result, null, 2)
assertStress(
    Buffer.byteLength(serialized) <= MAX_SERIALIZED_EVIDENCE_BYTES,
    'layout-codec serialized evidence exceeded its fixed budget'
)
process.stdout.write(`${serialized}\n`)

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`expected a positive integer, received ${value}`)
    }
    return number
}

function assertStress(condition, message) {

    if (!condition) throw new Error(message)
}
