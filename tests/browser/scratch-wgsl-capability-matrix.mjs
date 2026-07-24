import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const examplesRoot = resolve(repositoryRoot, 'examples')
const viteEntry = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js')
const packageEntry = resolve(repositoryRoot, 'packages/geoscratch/dist/index.js')
const adapterPowerPreference = 'high-performance'
const expectedEnableProofNames = [
    'clip_distances',
    'dual_source_blending',
    'f16',
    'primitive_index',
    'subgroup_size_control',
    'subgroups',
]
const expectedLanguageProofNames = [
    'readonly_and_readwrite_storage_textures',
    'packed_4x8_integer_dot_product',
    'unrestricted_pointer_parameters',
    'pointer_composite_access',
    'uniform_buffer_standard_layout',
    'subgroup_id',
    'subgroup_uniformity',
    'texture_and_sampler_let',
    'texture_formats_tier1',
    'linear_indexing',
    'immediate_address_space',
    'buffer_view',
]
const expectedDeviceFeaturesByProof = Object.freeze({
    clip_distances: [ 'clip-distances' ],
    dual_source_blending: [ 'dual-source-blending' ],
    f16: [ 'shader-f16' ],
    primitive_index: [ 'primitive-index' ],
    subgroup_size_control: [ 'subgroup-size-control', 'subgroups' ],
    subgroups: [ 'subgroups' ],
    subgroup_id: [ 'subgroups' ],
    subgroup_uniformity: [ 'subgroups' ],
    texture_formats_tier1: [ 'texture-formats-tier1' ],
})
const timeout = positiveInteger(
    process.env.SCRATCH_WGSL_BROWSER_TIMEOUT_MS,
    120_000
)
const port = process.env.SCRATCH_WGSL_BROWSER_PORT === undefined
    ? await findAvailablePort()
    : positiveInteger(process.env.SCRATCH_WGSL_BROWSER_PORT)
const baseUrl = `http://127.0.0.1:${port}`
const vite = startVite(port)
let browser
let browserVersion
let probe
let fatalError
let cleanupError
let serverClosed = false
const pageEvents = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
}

try {
    await waitForVite(vite, `${baseUrl}/index.html`)
    browser = await chromium.launch({
        channel: 'chrome',
        headless: false,
        args: [ '--enable-unsafe-webgpu' ],
    })
    browserVersion = await browser.version()
    const context = await browser.newContext({
        viewport: { width: 960, height: 720 },
        deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    observePage(page, pageEvents)
    await page.goto(`${baseUrl}/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout,
    })
    const moduleUrl = `${baseUrl}/@fs${packageEntry}`
    probe = await page.evaluate(runCapabilityMatrix, {
        moduleUrl,
        adapterPowerPreference,
        expectedEnableProofNames,
        expectedLanguageProofNames,
    })
    await context.close()
} catch (error) {
    fatalError = serializeError(error)
} finally {
    const cleanupFailures = []
    try {
        if (browser !== undefined) {
            await withTimeout(browser.close(), 5_000, 'Chrome shutdown')
        }
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        await stopVite(vite)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    try {
        serverClosed = await waitForPortClosed(port)
    } catch (error) {
        cleanupFailures.push(serializeError(error))
    }
    if (cleanupFailures.length > 0) cleanupError = cleanupFailures.join('\n')
}

const failures = validateResult({
    probe,
    fatalError,
    cleanupError,
    serverClosed,
    pageEvents,
})
const result = {
    schemaVersion: 1,
    browserVersion,
    headed: true,
    baseUrl,
    vite: {
        pid: vite.child.pid,
        exitCode: vite.child.exitCode,
        signalCode: vite.child.signalCode,
        serverClosed,
        stdout: failures.length === 0 ? undefined : vite.stdout,
        stderr: failures.length === 0 ? undefined : vite.stderr,
    },
    capabilities: probe?.capabilities,
    enableExtensions: probe?.enableExtensions,
    languageExtensions: probe?.languageExtensions,
    layoutProofs: probe?.layoutProofs,
    aggregateObservations: probe?.aggregateObservations,
    pageEvents,
    fatalError,
    cleanupError,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function runCapabilityMatrix({
    moduleUrl,
    adapterPowerPreference,
    expectedEnableProofNames,
    expectedLanguageProofNames,
}) {

    const scratch = await import(moduleUrl)
    const enableContracts = [
        {
            extension: 'clip_distances',
            requiredFeatures: [ 'clip-distances' ],
            kind: 'render',
        },
        {
            extension: 'dual_source_blending',
            requiredFeatures: [ 'dual-source-blending' ],
            kind: 'render',
        },
        {
            extension: 'f16',
            requiredFeatures: [ 'shader-f16' ],
            kind: 'f16-layout',
        },
        {
            extension: 'primitive_index',
            requiredFeatures: [ 'primitive-index' ],
            kind: 'render',
        },
        {
            extension: 'subgroup_size_control',
            requiredFeatures: [ 'subgroup-size-control', 'subgroups' ],
            kind: 'subgroup-size',
        },
        {
            extension: 'subgroups',
            requiredFeatures: [ 'subgroups' ],
            kind: 'subgroup',
        },
    ]
    const languageContracts = [
        {
            name: 'readonly_and_readwrite_storage_textures',
            kind: 'read-write-storage-texture',
            requiredFeatures: [],
        },
        {
            name: 'packed_4x8_integer_dot_product',
            kind: 'packed-dot-product',
            requiredFeatures: [],
        },
        {
            name: 'unrestricted_pointer_parameters',
            kind: 'unrestricted-pointer',
            requiredFeatures: [],
        },
        {
            name: 'pointer_composite_access',
            kind: 'pointer-composite',
            requiredFeatures: [],
        },
        {
            name: 'uniform_buffer_standard_layout',
            kind: 'uniform-layout',
            requiredFeatures: [],
        },
        {
            name: 'subgroup_id',
            kind: 'subgroup-id',
            requiredFeatures: [ 'subgroups' ],
        },
        {
            name: 'subgroup_uniformity',
            kind: 'subgroup-uniformity',
            requiredFeatures: [ 'subgroups' ],
        },
        {
            name: 'texture_and_sampler_let',
            kind: 'texture-sampler-let',
            requiredFeatures: [],
        },
        {
            name: 'texture_formats_tier1',
            kind: 'tier1-storage-texture',
            requiredFeatures: [ 'texture-formats-tier1' ],
        },
        {
            name: 'linear_indexing',
            kind: 'linear-index',
            requiredFeatures: [],
        },
        {
            name: 'immediate_address_space',
            kind: 'immediate-data',
            requiredFeatures: [],
        },
        {
            name: 'buffer_view',
            kind: 'buffer-view',
            requiredFeatures: [],
        },
    ]
    if (
        JSON.stringify(enableContracts.map(contract => contract.extension)) !==
            JSON.stringify(expectedEnableProofNames) ||
        JSON.stringify(languageContracts.map(contract => contract.name)) !==
            JSON.stringify(expectedLanguageProofNames)
    ) {
        throw new Error('Capability matrix contract names drifted.')
    }

    if (navigator.gpu === undefined) {
        return {
            capabilities: {
                navigatorGpu: false,
                adapterAvailable: false,
                adapterFeatures: [],
                wgslLanguageFeatures: [],
            },
            enableExtensions: [],
            languageExtensions: [],
            layoutProofs: {},
            aggregateObservations: emptyAggregate(),
        }
    }

    let discoveryRuntime
    try {
        discoveryRuntime = await scratch.ScratchRuntime.create({
            label: 'WGSL matrix capability discovery',
            powerPreference: adapterPowerPreference,
            diagnostics: {
                stackCapture: 'errors',
            },
        })
    } catch (error) {
        return {
            capabilities: {
                navigatorGpu: true,
                adapterAvailable: false,
                adapterFeatures: [],
                wgslLanguageFeatures: [],
                adapterSelection: {
                    powerPreference: adapterPowerPreference,
                },
                discoveryFailure: serializeFailure(error),
            },
            enableExtensions: [],
            languageExtensions: [],
            layoutProofs: {},
            aggregateObservations: emptyAggregate(),
        }
    }

    const adapterFeatures = [ ...discoveryRuntime.adapterFeatures ].sort()
    const languageFeatureFacts = [
        ...discoveryRuntime.wgslLanguageFeatures,
    ].sort()
    const adapterInfo = discoveryRuntime.adapterInfo
    const adapterLimits = discoveryRuntime.adapterLimits
    const discoveryRequestFacts = discoveryRuntime.requestFacts
    discoveryRuntime.dispose()
    await Promise.resolve()
    const discoveryTerminal = terminalFacts(
        discoveryRuntime.diagnostics.exportEvidence().snapshot
    )
    const capabilities = {
        navigatorGpu: true,
        adapterAvailable: true,
        adapterSelection: {
            powerPreference: adapterPowerPreference,
        },
        discoveryRequestFacts,
        discoveryTerminal,
        adapterInfo: {
            vendor: adapterInfo.vendor ?? '',
            architecture: adapterInfo.architecture ?? '',
            device: adapterInfo.device ?? '',
            description: adapterInfo.description ?? '',
            subgroupMinSize: numberOrUndefined(adapterInfo.subgroupMinSize),
            subgroupMaxSize: numberOrUndefined(adapterInfo.subgroupMaxSize),
            isFallbackAdapter: adapterInfo.isFallbackAdapter ?? false,
        },
        adapterFeatures,
        wgslLanguageFeatures: languageFeatureFacts,
        limits: {
            maxBufferSize: adapterLimits.maxBufferSize,
            maxStorageBufferBindingSize:
                adapterLimits.maxStorageBufferBindingSize,
            maxComputeInvocationsPerWorkgroup:
                adapterLimits.maxComputeInvocationsPerWorkgroup,
            maxImmediateSize: numberOrUndefined(
                adapterLimits.maxImmediateSize
            ),
        },
    }

    const enableResults = []
    let f16Proof
    for (const contract of enableContracts) {
        const missingAdapterFeatures = contract.requiredFeatures.filter(
            feature => !adapterFeatures.includes(feature)
        )
        if (missingAdapterFeatures.length > 0) {
            const skipped = skippedResult(contract.extension, {
                kind: 'adapter-feature-missing',
                adapterFeatures,
                missingAdapterFeatures,
            }, {
                requestedDeviceFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [],
            })
            enableResults.push(skipped)
            if (contract.extension === 'f16') f16Proof = skipped
            continue
        }

        let proof
        if (contract.kind === 'f16-layout') {
            proof = await runF16LayoutProof(scratch, contract)
            f16Proof = proof
        } else if (contract.kind === 'render') {
            proof = await runRenderEnableProof(scratch, contract)
        } else if (contract.kind === 'subgroup-size') {
            proof = await runSubgroupSizeProof(
                scratch,
                contract,
                capabilities.adapterInfo
            )
        } else {
            proof = await runSubgroupProof(scratch, contract)
        }
        enableResults.push(proof)
    }

    const languageResults = []
    let bufferViewProof
    for (const contract of languageContracts) {
        const languageFeature = contract.name
        const missingAdapterFeatures = contract.requiredFeatures.filter(
            feature => !adapterFeatures.includes(feature)
        )
        if (missingAdapterFeatures.length > 0) {
            const skipped = skippedResult(languageFeature, {
                kind: 'adapter-feature-missing',
                adapterFeatures,
                missingAdapterFeatures,
            }, {
                requestedDeviceFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [ languageFeature ],
            })
            languageResults.push(skipped)
            if (languageFeature === 'buffer_view') bufferViewProof = skipped
            continue
        }
        if (!languageFeatureFacts.includes(languageFeature)) {
            const skipped = skippedResult(languageFeature, {
                kind: 'wgsl-language-feature-missing',
                wgslLanguageFeatures: languageFeatureFacts,
                missingLanguageFeature: languageFeature,
            }, {
                requestedDeviceFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [ languageFeature ],
            })
            languageResults.push(skipped)
            if (languageFeature === 'buffer_view') bufferViewProof = skipped
            continue
        }

        let proof
        if (contract.kind === 'immediate-data') {
            const maxImmediateSize = capabilities.limits.maxImmediateSize
            if (typeof maxImmediateSize !== 'number' || maxImmediateSize < 4) {
                proof = skippedResult(languageFeature, {
                    kind: 'limit-missing',
                    limit: 'maxImmediateSize',
                    required: 4,
                    actual: maxImmediateSize,
                }, {
                    requestedDeviceFeatures: contract.requiredFeatures,
                    requiredLanguageFeatures: [ languageFeature ],
                })
            } else {
                proof = await runImmediateProof(scratch, contract)
            }
        } else {
            proof = await runLanguageSemanticProof(scratch, contract)
        }
        languageResults.push(proof)
        if (languageFeature === 'buffer_view') bufferViewProof = proof
    }

    const nestedMatrix = await runNestedMatrixProof(scratch)
    const allProofs = [
        ...enableResults,
        ...languageResults,
        nestedMatrix,
    ]

    return {
        capabilities,
        enableExtensions: enableResults,
        languageExtensions: languageResults,
        layoutProofs: {
            nestedMatrix,
            f16: f16Proof,
            bufferView: bufferViewProof,
        },
        aggregateObservations: aggregateProofs(allProofs),
    }

    async function runNestedMatrixProof(activeScratch) {

        const codec = activeScratch.layoutCodec({
            name: 'NestedMatrixProbe',
            fields: [
                {
                    name: 'inner',
                    type: {
                        kind: 'struct',
                        name: 'NestedMatrixInner',
                        fields: [
                            { name: 'basis', type: 'mat3x2f' },
                        ],
                    },
                },
            ],
        }, {
            usage: [ 'storage' ],
        })
        const source = `
${codec.wgslAccessors({ namespace: 'NestedMatrixProbeLayout' })}

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@group(0) @binding(1)
var<storage, read> inputValue: NestedMatrixProbe;

@compute @workgroup_size(1)
fn csMain() {
    let inner = NestedMatrixProbeLayout_readInner(inputValue);
    outputValues[0] = u32(inner.basis[2][1]);
}
`
        return await runComputeProbe(activeScratch, {
            name: 'nested-matrix',
            source,
            expected: 6,
            input: {
                codec,
                value: {
                    inner: {
                        basis: [
                            [ 1, 2 ],
                            [ 3, 4 ],
                            [ 5, 6 ],
                        ],
                    },
                },
                bindingType: 'read-storage',
                addressSpaceUsage: GPUBufferUsage.STORAGE,
            },
        })
    }

    async function runF16LayoutProof(activeScratch, contract) {

        const codec = activeScratch.layoutCodec({
            name: 'F16MatrixProbe',
            fields: [
                { name: 'scalar', type: 'f16' },
                { name: 'basis', type: 'mat2x3h' },
            ],
        }, {
            usage: [ 'storage' ],
        })
        const source = `
enable f16;

${codec.wgslAccessors({ namespace: 'F16MatrixProbeLayout' })}

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@group(0) @binding(1)
var<storage, read> inputValue: F16MatrixProbe;

@compute @workgroup_size(1)
fn csMain() {
    let basis = F16MatrixProbeLayout_readBasis(inputValue);
    outputValues[0] = u32(basis[1][2]);
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.extension,
            source,
            expected: 6,
            requiredFeatures: contract.requiredFeatures,
            input: {
                codec,
                value: {
                    scalar: 1,
                    basis: [
                        [ 1, 2, 3 ],
                        [ 4, 5, 6 ],
                    ],
                },
                bindingType: 'read-storage',
                addressSpaceUsage: GPUBufferUsage.STORAGE,
            },
        })
    }

    async function runSubgroupProof(activeScratch, contract) {

        const source = `
enable subgroups;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain(
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) size: u32
) {
    if (lane == 0u) {
        outputValues[0] = size;
    }
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.extension,
            source,
            expectedPredicate: value => value > 0,
            requiredFeatures: contract.requiredFeatures,
        })
    }

    async function runSubgroupSizeProof(
        activeScratch,
        contract,
        info
    ) {

        const subgroupSize = info.subgroupMinSize
        if (
            typeof subgroupSize !== 'number' ||
            subgroupSize <= 0 ||
            (subgroupSize & (subgroupSize - 1)) !== 0
        ) {
            return failedCapabilityResult(contract.extension, {
                kind: 'adapter-info-invalid',
                requiredFact: 'positive power-of-two subgroupMinSize',
                subgroupMinSize: subgroupSize,
            }, {
                requestedDeviceFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [],
            })
        }
        const source = `
enable subgroups;
enable subgroup_size_control;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(${subgroupSize}) @subgroup_size(${subgroupSize})
fn csMain(
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) size: u32
) {
    if (lane == 0u) {
        outputValues[0] = size;
    }
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.extension,
            source,
            expected: subgroupSize,
            requiredFeatures: contract.requiredFeatures,
        })
    }

    async function runLanguageSemanticProof(activeScratch, contract) {

        if (contract.kind === 'read-write-storage-texture') {
            return await runReadWriteStorageTextureProof(activeScratch, contract)
        }
        if (contract.kind === 'texture-sampler-let') {
            return await runTextureSamplerLetProof(activeScratch, contract)
        }
        if (contract.kind === 'tier1-storage-texture') {
            return await runTier1StorageTextureProof(activeScratch, contract)
        }
        if (contract.kind === 'uniform-layout') {
            return await runUniformLayoutProof(activeScratch, contract)
        }
        if (contract.kind === 'buffer-view') {
            return await runBufferViewProof(activeScratch, contract)
        }

        const semanticCases = {
            'packed-dot-product': {
                source: `
requires packed_4x8_integer_dot_product;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    outputValues[0] = dot4U8Packed(0x04030201u, 0x01010101u);
}
`,
                expected: 10,
            },
            'unrestricted-pointer': {
                source: `
requires unrestricted_pointer_parameters;

@group(0) @binding(0)
var<storage, read_write> outputValues: u32;

fn writeThroughStoragePointer(
    destination: ptr<storage, u32, read_write>,
    value: u32
) {
    *destination = value;
}

@compute @workgroup_size(1)
fn csMain() {
    writeThroughStoragePointer(&outputValues, 103u);
}
`,
                expected: 103,
            },
            'pointer-composite': {
                source: `
requires pointer_composite_access;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    var localValues = array<u32, 4>(101u, 102u, 104u, 105u);
    let valuesPointer = &localValues;
    outputValues[0] = valuesPointer[2u];
}
`,
                expected: 104,
            },
            'subgroup-id': {
                source: `
requires subgroup_id;
enable subgroups;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(64)
fn csMain(
    @builtin(local_invocation_index) localIndex: u32,
    @builtin(subgroup_id) subgroupId: u32,
    @builtin(num_subgroups) subgroupCount: u32
) {
    if (localIndex == 0u) {
        outputValues[0] = subgroupCount * 100u + subgroupId;
    }
}
`,
                expectedPredicate: value => value >= 100,
            },
            'subgroup-uniformity': {
                source: `
requires subgroup_uniformity;
enable subgroups;
diagnostic(error, subgroup_uniformity);

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain(@builtin(subgroup_invocation_id) lane: u32) {
    let sum = subgroupAdd(7u);
    if (lane == 0u) {
        outputValues[0] = sum;
    }
}
`,
                expected: 7,
            },
            'linear-index': {
                source: `
requires linear_indexing;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(2)
fn csMain(@builtin(global_invocation_index) linearIndex: u32) {
    if (linearIndex == 1u) {
        outputValues[0] = linearIndex + 1u;
    }
}
`,
                expected: 2,
            },
        }
        const semantic = semanticCases[contract.kind]
        if (semantic === undefined) {
            throw new Error(`Unknown language proof kind: ${contract.kind}`)
        }
        return await runComputeProbe(activeScratch, {
            name: contract.name,
            source: semantic.source,
            expected: semantic.expected,
            expectedPredicate: semantic.expectedPredicate,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            proofKind: 'language-semantic-execution',
        })
    }

    async function runImmediateProof(activeScratch, contract) {

        const expected = 211
        const source = `
requires immediate_address_space;

var<immediate> probeValue: u32;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    outputValues[0] = probeValue;
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.name,
            source,
            expected,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            immediateData: new Uint32Array([ expected ]),
            immediateSize: 4,
            proofKind: 'immediate-data-execution',
        })
    }

    async function runUniformLayoutProof(activeScratch, contract) {

        const codec = activeScratch.layoutCodec({
            name: 'StandardUniformProbe',
            fields: [
                {
                    name: 'values',
                    type: {
                        kind: 'array',
                        element: 'u32',
                        count: 4,
                    },
                },
            ],
        }, {
            usage: [ 'uniform' ],
            uniformLayout: 'uniform_buffer_standard_layout',
        })
        const source = `
requires uniform_buffer_standard_layout;

${codec.wgslAccessors({ namespace: 'StandardUniformProbeLayout' })}

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@group(0) @binding(1)
var<uniform> inputValue: StandardUniformProbe;

@compute @workgroup_size(1)
fn csMain() {
    let values = StandardUniformProbeLayout_readValues(inputValue);
    outputValues[0] = values[3];
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.name,
            source,
            expected: 4,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            input: {
                codec,
                value: { values: [ 1, 2, 3, 4 ] },
                bindingType: 'uniform',
                addressSpaceUsage: GPUBufferUsage.UNIFORM,
            },
            proofKind: 'uniform-layout-execution',
        })
    }

    async function runBufferViewProof(activeScratch, contract) {

        const raw = activeScratch.layoutCodec({
            name: 'RawBufferViewProbe',
            type: { kind: 'buffer', byteLength: 32 },
        })
        const target = activeScratch.layoutCodec({
            name: 'BufferViewMatrixTarget',
            type: 'mat3x2f',
        })
        const view = raw.bufferView({
            kind: 'bufferView',
            target: target.artifact,
            addressSpace: 'storage',
            accessMode: 'read',
            byteOffset: 0,
        })
        const matrixBytes = target.pack([
            [ 1, 2 ],
            [ 3, 4 ],
            [ 5, 6 ],
        ])
        const inputBytes = new Uint8Array(32)
        inputBytes.set(matrixBytes)
        const source = `
requires buffer_view;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@group(0) @binding(1)
var<storage> inputBytes: buffer<32>;

@compute @workgroup_size(1)
fn csMain() {
    let matrixPointer = bufferView<mat3x2f>(&inputBytes, 0u);
    outputValues[0] = u32((*matrixPointer)[2][1]);
}
`
        return await runComputeProbe(activeScratch, {
            name: contract.name,
            source,
            expected: 6,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            input: {
                codec: raw,
                bytes: inputBytes,
                bindingType: 'read-storage',
                addressSpaceUsage: GPUBufferUsage.STORAGE,
                bufferViews: [ view ],
            },
            proofKind: 'buffer-view-execution',
        })
    }

    async function runReadWriteStorageTextureProof(activeScratch, contract) {

        const source = `
requires readonly_and_readwrite_storage_textures;

@group(0) @binding(0)
var image: texture_storage_2d<r32uint, read_write>;

@group(0) @binding(1)
var<storage, read_write> outputValues: array<u32>;

@compute @workgroup_size(1)
fn csMain() {
    let nextValue = textureLoad(image, vec2i(0, 0)).r + 1u;
    textureStore(image, vec2i(0, 0), vec4u(nextValue, 0u, 0u, 0u));
    outputValues[0] = nextValue;
}
`
        return await withRuntime(activeScratch, {
            name: contract.name,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            proofKind: 'read-write-storage-texture-execution',
        }, async runtime => {
            const image = await runtime.createTexture({
                label: `${contract.name} image`,
                size: [ 1, 1 ],
                format: 'r32uint',
                usage:
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.STORAGE_BINDING,
            })
            const output = await runtime.createBuffer({
                label: `${contract.name} output`,
                size: 4,
                usage:
                    GPUBufferUsage.COPY_DST |
                    GPUBufferUsage.COPY_SRC |
                    GPUBufferUsage.STORAGE,
            })
            const bindLayout = await runtime.createBindLayout({
                label: `${contract.name} layout`,
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'image',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'read-write',
                        format: 'r32uint',
                        viewDimension: '2d',
                    },
                    {
                        binding: 1,
                        name: 'outputValues',
                        type: 'storage',
                        visibility: [ 'compute' ],
                        minBindingSize: 4,
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(bindLayout, {
                image: image.view(),
                outputValues: output.region(),
            })
            const module = await runtime.createShaderModule({
                label: `${contract.name} shader`,
                sourceParts: [ { code: source } ],
            })
            const program = runtime.createProgram({
                label: `${contract.name} program`,
                compute: { module, entryPoint: 'csMain' },
                requiredFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [ contract.name ],
            })
            const pipeline = await runtime.createComputePipeline({
                label: `${contract.name} pipeline`,
                program,
                layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            })
            const pass = runtime.createComputePass({
                label: `${contract.name} pass`,
            })
            const initializeImage = runtime.createTextureUploadCommand({
                label: `${contract.name} image initialization`,
                target: image,
                data: new Uint32Array([ 5 ]),
                layout: { bytesPerRow: 4, rowsPerImage: 1 },
                size: { width: 1, height: 1 },
            })
            const initializeOutput = runtime.createUploadCommand({
                label: `${contract.name} output initialization`,
                target: output.region(),
                data: new Uint32Array([ 0 ]),
            })
            const dispatch = runtime.createDispatchCommand({
                label: `${contract.name} dispatch`,
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [
                        { resource: image, contentEpoch: 1 },
                        { resource: output, contentEpoch: 1 },
                    ],
                    write: [ image, output ],
                },
                whenMissing: 'throw',
            })
            const submitted = runtime.submission()
                .upload(initializeImage)
                .upload(initializeOutput)
                .compute(pass, [ dispatch ])
                .submit()
            const nativeOutcome = await observedSubmission(submitted)
            const readback = runtime.createReadback({
                label: `${contract.name} readback`,
                source: output.region(),
                after: submitted,
            })
            const values = await readback.toArray(Uint32Array)
            if (values[0] !== 6) {
                throw new Error(
                    `${contract.name} readback was ${values[0]}, expected 6.`
                )
            }
            readback.dispose()
            return computeExecutionFacts({
                module,
                pipeline,
                nativeOutcome,
                readback: { type: 'u32', values: [ ...values ] },
                program,
            })
        })
    }

    async function runTextureSamplerLetProof(activeScratch, contract) {

        const source = `
requires texture_and_sampler_let;

@group(0) @binding(0)
var<storage, read_write> outputValues: array<u32>;

@group(0) @binding(1)
var sourceTexture: texture_2d<f32>;

@group(0) @binding(2)
var sourceSampler: sampler;

@compute @workgroup_size(1)
fn csMain() {
    let localTexture = sourceTexture;
    let localSampler = sourceSampler;
    let sampled = textureSampleLevel(
        localTexture,
        localSampler,
        vec2f(0.5, 0.5),
        0.0
    );
    outputValues[0] = u32(round(sampled.r * 255.0));
}
`
        return await withRuntime(activeScratch, {
            name: contract.name,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            proofKind: 'texture-sampler-let-execution',
        }, async runtime => {
            const texture = await runtime.createTexture({
                label: `${contract.name} texture`,
                size: [ 1, 1 ],
                format: 'rgba8unorm',
                usage:
                    GPUTextureUsage.COPY_DST |
                    GPUTextureUsage.TEXTURE_BINDING,
            })
            const sampler = await runtime.createSampler({
                label: `${contract.name} sampler`,
                minFilter: 'nearest',
                magFilter: 'nearest',
            })
            const output = await runtime.createBuffer({
                label: `${contract.name} output`,
                size: 4,
                usage:
                    GPUBufferUsage.COPY_DST |
                    GPUBufferUsage.COPY_SRC |
                    GPUBufferUsage.STORAGE,
            })
            const bindLayout = await runtime.createBindLayout({
                label: `${contract.name} layout`,
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'outputValues',
                        type: 'storage',
                        visibility: [ 'compute' ],
                        minBindingSize: 4,
                    },
                    {
                        binding: 1,
                        name: 'sourceTexture',
                        type: 'texture',
                        visibility: [ 'compute' ],
                        sampleType: 'float',
                        viewDimension: '2d',
                    },
                    {
                        binding: 2,
                        name: 'sourceSampler',
                        type: 'sampler',
                        visibility: [ 'compute' ],
                        samplerType: 'filtering',
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(bindLayout, {
                outputValues: output.region(),
                sourceTexture: texture.view(),
                sourceSampler: sampler,
            })
            const module = await runtime.createShaderModule({
                label: `${contract.name} shader`,
                sourceParts: [ { code: source } ],
            })
            const program = runtime.createProgram({
                label: `${contract.name} program`,
                compute: { module, entryPoint: 'csMain' },
                requiredFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [ contract.name ],
            })
            const pipeline = await runtime.createComputePipeline({
                label: `${contract.name} pipeline`,
                program,
                layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            })
            const pass = runtime.createComputePass({
                label: `${contract.name} pass`,
            })
            const initializeTexture = runtime.createTextureUploadCommand({
                label: `${contract.name} texture initialization`,
                target: texture,
                data: new Uint8Array([ 64, 0, 0, 255 ]),
                layout: { bytesPerRow: 4, rowsPerImage: 1 },
                size: { width: 1, height: 1 },
            })
            const initializeOutput = runtime.createUploadCommand({
                label: `${contract.name} output initialization`,
                target: output.region(),
                data: new Uint32Array([ 0 ]),
            })
            const dispatch = runtime.createDispatchCommand({
                label: `${contract.name} dispatch`,
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [
                        { resource: texture, contentEpoch: 1 },
                        { resource: output, contentEpoch: 1 },
                    ],
                    write: [ output ],
                },
                whenMissing: 'throw',
            })
            const submitted = runtime.submission()
                .upload(initializeTexture)
                .upload(initializeOutput)
                .compute(pass, [ dispatch ])
                .submit()
            const nativeOutcome = await observedSubmission(submitted)
            const readback = runtime.createReadback({
                label: `${contract.name} readback`,
                source: output.region(),
                after: submitted,
            })
            const values = await readback.toArray(Uint32Array)
            if (values[0] !== 64) {
                throw new Error(
                    `${contract.name} readback was ${values[0]}, expected 64.`
                )
            }
            readback.dispose()
            return computeExecutionFacts({
                module,
                pipeline,
                nativeOutcome,
                readback: { type: 'u32', values: [ ...values ] },
                program,
            })
        })
    }

    async function runTier1StorageTextureProof(activeScratch, contract) {

        const source = `
requires texture_formats_tier1;

@group(0) @binding(0)
var outputImage: texture_storage_2d<r16unorm, write>;

@compute @workgroup_size(1)
fn csMain() {
    textureStore(outputImage, vec2i(0, 0), vec4f(0.5, 0.0, 0.0, 1.0));
}
`
        return await withRuntime(activeScratch, {
            name: contract.name,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [ contract.name ],
            proofKind: 'tier1-storage-texture-execution',
        }, async runtime => {
            const texture = await runtime.createTexture({
                label: `${contract.name} texture`,
                size: [ 1, 1 ],
                format: 'r16unorm',
                usage:
                    GPUTextureUsage.COPY_SRC |
                    GPUTextureUsage.STORAGE_BINDING,
            })
            const bindLayout = await runtime.createBindLayout({
                label: `${contract.name} layout`,
                group: 0,
                entries: [
                    {
                        binding: 0,
                        name: 'outputImage',
                        type: 'storage-texture',
                        visibility: [ 'compute' ],
                        access: 'write-only',
                        format: 'r16unorm',
                        viewDimension: '2d',
                    },
                ],
            })
            const bindSet = await runtime.createBindSet(bindLayout, {
                outputImage: texture.view(),
            })
            const module = await runtime.createShaderModule({
                label: `${contract.name} shader`,
                sourceParts: [ { code: source } ],
            })
            const program = runtime.createProgram({
                label: `${contract.name} program`,
                compute: { module, entryPoint: 'csMain' },
                requiredFeatures: contract.requiredFeatures,
                requiredLanguageFeatures: [ contract.name ],
            })
            const pipeline = await runtime.createComputePipeline({
                label: `${contract.name} pipeline`,
                program,
                layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
            })
            const pass = runtime.createComputePass({
                label: `${contract.name} pass`,
            })
            const dispatch = runtime.createDispatchCommand({
                label: `${contract.name} dispatch`,
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: [],
                    write: [ texture ],
                },
                whenMissing: 'throw',
            })
            const submitted = runtime.submission()
                .compute(pass, [ dispatch ])
                .submit()
            const nativeOutcome = await observedSubmission(submitted)
            const readback = runtime.createReadback({
                label: `${contract.name} readback`,
                source: {
                    resource: texture,
                    size: [ 1, 1, 1 ],
                },
                after: submitted,
            })
            const bytes = await readback.toBytes()
            const encoded = new DataView(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength
            ).getUint16(0, true)
            if (encoded < 32767 || encoded > 32768) {
                throw new Error(
                    `${contract.name} encoded value was ${encoded}, expected 32767 or 32768.`
                )
            }
            readback.dispose()
            return computeExecutionFacts({
                module,
                pipeline,
                nativeOutcome,
                readback: {
                    type: 'r16unorm',
                    values: [ ...bytes ],
                    encoded,
                },
                program,
            })
        })
    }

    async function runRenderEnableProof(activeScratch, contract) {

        const shaders = {
            clip_distances: {
                source: `
enable clip_distances;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @builtin(clip_distances) clip: array<f32, 1>,
}

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> VertexOutput {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );
    var output: VertexOutput;
    output.position = vec4f(positions[index], 0.0, 1.0);
    output.clip = array<f32, 1>(1.0);
    return output;
}

@fragment
fn fsMain() -> @location(0) vec4f {
    return vec4f(1.0, 0.25, 0.0, 1.0);
}
`,
                target: { format: 'rgba8unorm' },
                expected: bytes => bytes[0] >= 240 && bytes[1] >= 55,
            },
            dual_source_blending: {
                source: `
enable dual_source_blending;

struct FragmentOutput {
    @location(0) @blend_src(0) primary: vec4f,
    @location(0) @blend_src(1) secondary: vec4f,
}

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );
    return vec4f(positions[index], 0.0, 1.0);
}

@fragment
fn fsMain() -> FragmentOutput {
    var output: FragmentOutput;
    output.primary = vec4f(1.0, 0.0, 0.0, 1.0);
    output.secondary = vec4f(0.5, 0.5, 0.5, 0.5);
    return output;
}
`,
                target: {
                    format: 'rgba8unorm',
                    blend: {
                        color: {
                            srcFactor: 'src1',
                            dstFactor: 'zero',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'zero',
                            operation: 'add',
                        },
                    },
                },
                expected: bytes => bytes[0] >= 120 && bytes[0] <= 136,
            },
            primitive_index: {
                source: `
enable primitive_index;

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );
    return vec4f(positions[index], 0.0, 1.0);
}

@fragment
fn fsMain(@builtin(primitive_index) index: u32) -> @location(0) vec4f {
    return vec4f(1.0 - f32(index), 0.5, 0.0, 1.0);
}
`,
                target: { format: 'rgba8unorm' },
                expected: bytes => bytes[0] >= 240 && bytes[1] >= 120,
            },
        }
        const shader = shaders[contract.extension]
        return await withRuntime(activeScratch, {
            name: contract.extension,
            requiredFeatures: contract.requiredFeatures,
            requiredLanguageFeatures: [],
            proofKind: 'enable-render-readback',
        }, async runtime => {
            const texture = await runtime.createTexture({
                label: `${contract.extension} target`,
                size: { width: 1, height: 1 },
                format: 'rgba8unorm',
                usage:
                    GPUTextureUsage.RENDER_ATTACHMENT |
                    GPUTextureUsage.COPY_SRC,
            })
            const module = await runtime.createShaderModule({
                label: `${contract.extension} shader`,
                sourceParts: [ { code: shader.source } ],
            })
            const program = runtime.createProgram({
                label: `${contract.extension} program`,
                vertex: { module, entryPoint: 'vsMain' },
                fragment: { module, entryPoint: 'fsMain' },
                requiredFeatures: contract.requiredFeatures,
            })
            const pipeline = await runtime.createRenderPipeline({
                label: `${contract.extension} pipeline`,
                program,
                targets: [ shader.target ],
            })
            const pass = runtime.createRenderPass({
                label: `${contract.extension} pass`,
                color: [
                    {
                        target: texture.view(),
                        load: 'clear',
                        store: 'store',
                        clear: [ 0, 0, 0, 0 ],
                    },
                ],
            })
            const draw = runtime.createDrawCommand({
                label: `${contract.extension} draw`,
                pipeline,
                count: { vertexCount: 3 },
                resources: { read: [], write: [] },
                whenMissing: 'throw',
            })
            const submitted = runtime.submission()
                .render(pass, [ draw ])
                .submit()
            const nativeOutcome = await observedSubmission(submitted)
            const readback = runtime.createReadback({
                label: `${contract.extension} readback`,
                source: {
                    resource: texture,
                    size: [ 1, 1, 1 ],
                },
                after: submitted,
            })
            const bytes = await readback.toBytes()
            const values = [ ...bytes ]
            if (!shader.expected(values)) {
                throw new Error(
                    `${contract.extension} readback was ${values.join(',')}.`
                )
            }
            readback.dispose()
            return {
                compilationInfo: module.compilationReport,
                pipelineCreation: pipeline.creationReport,
                submission: nativeOutcome,
                readback: {
                    type: 'rgba8unorm',
                    values,
                },
                programContracts: {
                    requiredFeatures: program.requiredFeatures,
                    requiredLanguageFeatures:
                        program.requiredLanguageFeatures,
                    layoutRequirementCount:
                        program.layoutRequirements.length,
                },
            }
        })
    }

    async function runComputeProbe(activeScratch, options) {

        return await withRuntime(activeScratch, {
            name: options.name,
            requiredFeatures: options.requiredFeatures ?? [],
            requiredLanguageFeatures:
                options.requiredLanguageFeatures ?? [],
            proofKind: options.proofKind ?? 'compute-readback',
        }, async runtime => {
            const output = await runtime.createBuffer({
                label: `${options.name} output`,
                size: 4,
                usage:
                    GPUBufferUsage.COPY_SRC |
                    GPUBufferUsage.COPY_DST |
                    GPUBufferUsage.STORAGE,
            })
            let input
            let inputBytes
            if (options.input !== undefined) {
                inputBytes = options.input.bytes ??
                    options.input.codec.pack(options.input.value)
                input = await runtime.createBuffer({
                    label: `${options.name} input`,
                    size: options.input.codec.byteLength(),
                    usage:
                        GPUBufferUsage.COPY_DST |
                        options.input.addressSpaceUsage,
                })
            }
            const entries = [
                {
                    binding: 0,
                    name: 'outputValues',
                    type: 'storage',
                    visibility: [ 'compute' ],
                    minBindingSize: 4,
                },
            ]
            if (options.input !== undefined) {
                entries.push({
                    binding: 1,
                    name: 'inputValue',
                    type: options.input.bindingType,
                    visibility: [ 'compute' ],
                    minBindingSize: options.input.codec.byteLength(),
                })
            }
            const bindLayout = await runtime.createBindLayout({
                label: `${options.name} layout`,
                group: 0,
                entries,
            })
            const bindings = { outputValues: output.region() }
            if (input !== undefined) {
                bindings.inputValue = input.region({
                    layout: options.input.codec.artifact,
                })
            }
            const bindSet = await runtime.createBindSet(
                bindLayout,
                bindings,
                { label: `${options.name} bind set` }
            )
            const sourcePart = {
                code: options.source,
                ...(options.input !== undefined
                    ? {
                        layoutDependencies: [
                            options.input.codec.artifact,
                        ],
                    }
                    : {}),
            }
            const module = await runtime.createShaderModule({
                label: `${options.name} shader`,
                sourceParts: [ sourcePart ],
            })
            const layoutRequirements = options.input === undefined
                ? []
                : [
                    {
                        group: 0,
                        binding: 1,
                        name: 'inputValue',
                        type: options.input.bindingType,
                        visibility: [ 'compute' ],
                        hasDynamicOffset: false,
                        layout: options.input.codec.artifact,
                        ...(options.input.bufferViews !== undefined
                            ? { bufferViews: options.input.bufferViews }
                            : {}),
                    },
                ]
            const program = runtime.createProgram({
                label: `${options.name} program`,
                compute: { module, entryPoint: 'csMain' },
                requiredFeatures: options.requiredFeatures ?? [],
                requiredLanguageFeatures:
                    options.requiredLanguageFeatures ?? [],
                layoutRequirements,
            })
            const pipeline = await runtime.createComputePipeline({
                label: `${options.name} pipeline`,
                program,
                layout: {
                    mode: 'explicit',
                    bindLayouts: [ bindLayout ],
                },
                ...(options.immediateSize !== undefined
                    ? { immediateSize: options.immediateSize }
                    : {}),
            })
            const pass = runtime.createComputePass({
                label: `${options.name} pass`,
            })
            const initializeOutput = runtime.createUploadCommand({
                label: `${options.name} output initialization`,
                target: output.region(),
                data: new Uint32Array([ 0 ]),
            })
            const uploads = [ initializeOutput ]
            if (input !== undefined) {
                uploads.push(runtime.createUploadCommand({
                    label: `${options.name} input upload`,
                    target: input.region(),
                    data: inputBytes,
                }))
            }
            const readResources = [
                { resource: output, contentEpoch: 1 },
            ]
            if (input !== undefined) {
                readResources.push({ resource: input, contentEpoch: 1 })
            }
            const dispatch = runtime.createDispatchCommand({
                label: `${options.name} dispatch`,
                pipeline,
                bindSets: [ { set: bindSet } ],
                count: { workgroups: [ 1 ] },
                resources: {
                    read: readResources,
                    write: [ output ],
                },
                ...(options.immediateData !== undefined
                    ? { immediateData: options.immediateData }
                    : {}),
                whenMissing: 'throw',
            })
            const submission = runtime.submission()
            for (const upload of uploads) submission.upload(upload)
            const submitted = submission.compute(pass, [ dispatch ]).submit()
            const nativeOutcome = await observedSubmission(submitted)
            const readback = runtime.createReadback({
                label: `${options.name} readback`,
                source: output.region(),
                after: submitted,
            })
            const values = await readback.toArray(Uint32Array)
            const value = values[0]
            const accepted = options.expectedPredicate !== undefined
                ? options.expectedPredicate(value)
                : value === options.expected
            if (!accepted) {
                throw new Error(
                    `${options.name} readback was ${value}, expected ` +
                    `${options.expected ?? 'predicate success'}.`
                )
            }
            readback.dispose()
            return {
                compilationInfo: module.compilationReport,
                pipelineCreation: pipeline.creationReport,
                submission: nativeOutcome,
                readback: {
                    type: 'u32',
                    values: [ ...values ],
                },
                programContracts: {
                    requiredFeatures: program.requiredFeatures,
                    requiredLanguageFeatures:
                        program.requiredLanguageFeatures,
                    layoutRequirementCount:
                        program.layoutRequirements.length,
                },
            }
        })
    }

    function computeExecutionFacts({
        module,
        pipeline,
        nativeOutcome,
        readback,
        program,
    }) {

        return {
            compilationInfo: module.compilationReport,
            pipelineCreation: pipeline.creationReport,
            submission: nativeOutcome,
            readback,
            programContracts: {
                requiredFeatures: program.requiredFeatures,
                requiredLanguageFeatures:
                    program.requiredLanguageFeatures,
                layoutRequirementCount:
                    program.layoutRequirements.length,
            },
        }
    }

    async function withRuntime(
        activeScratch,
        contract,
        execute
    ) {

        let runtime
        const uncaptured = []
        let execution
        let failure
        let evidence
        let terminal
        try {
            runtime = await activeScratch.ScratchRuntime.create({
                label: `WGSL matrix ${contract.name}`,
                powerPreference: adapterPowerPreference,
                requiredFeatures: contract.requiredFeatures,
                diagnostics: {
                    stackCapture: 'errors',
                },
            })
            const onUncaptured = event => {
                uncaptured.push(serializeGpuError(event.error))
            }
            runtime.device.addEventListener('uncapturederror', onUncaptured)
            try {
                execution = await execute(runtime)
            } finally {
                runtime.device.removeEventListener(
                    'uncapturederror',
                    onUncaptured
                )
            }
            evidence = runtime.diagnostics.exportEvidence()
        } catch (error) {
            failure = serializeFailure(error)
            if (runtime !== undefined) {
                evidence = runtime.diagnostics.exportEvidence()
            }
        } finally {
            if (runtime !== undefined) {
                runtime.dispose()
                await Promise.resolve()
                terminal = terminalFacts(
                    runtime.diagnostics.exportEvidence().snapshot
                )
            }
        }

        return {
            name: contract.name,
            status:
                failure === undefined &&
                uncaptured.length === 0 &&
                terminal?.isClean === true
                    ? 'passed'
                    : 'failed',
            proofKind: contract.proofKind,
            requestedDeviceFeatures: contract.requiredFeatures,
            requiredLanguageFeatures:
                contract.requiredLanguageFeatures,
            runtimeRequestFacts: runtime?.requestFacts,
            runtimeCapabilities: runtime === undefined
                ? undefined
                : {
                    adapterFeatures:
                        [ ...runtime.adapterFeatures ].sort(),
                    adapterInfo: runtime.adapterInfo,
                    adapterLimits: {
                        maxBufferSize:
                            runtime.adapterLimits.maxBufferSize,
                        maxStorageBufferBindingSize:
                            runtime.adapterLimits.maxStorageBufferBindingSize,
                        maxComputeInvocationsPerWorkgroup:
                            runtime.adapterLimits.maxComputeInvocationsPerWorkgroup,
                        maxImmediateSize: numberOrUndefined(
                            runtime.adapterLimits.maxImmediateSize
                        ),
                    },
                    deviceFeatures: [ ...runtime.deviceFeatures ].sort(),
                    wgslLanguageFeatures:
                        runtime.wgslLanguageFeatures,
                    isDeviceLost: runtime.isDeviceLost,
                    deviceLostInfo: runtime.deviceLostInfo,
                },
            execution,
            observations: summarizeEvidence(evidence),
            uncaptured,
            terminal,
            failure,
        }
    }

    async function observedSubmission(submitted) {

        const [ nativeOutcome ] = await Promise.all([
            submitted.nativeOutcome,
            submitted.done,
        ])
        if (nativeOutcome.status !== 'observed-succeeded') {
            throw new Error(
                `Submission native outcome was ${nativeOutcome.status}.`
            )
        }
        return nativeOutcome
    }

    function summarizeEvidence(value) {

        if (value === undefined) return undefined
        const snapshot = value.snapshot
        return {
            retainedOperationCount: value.operations.length,
            retainedIncidentCount: value.incidents.length,
            incidentCodes: value.incidents.map(
                incident => incident.diagnosticCode
            ),
            capturedValidationErrors:
                snapshot.aggregates.validationFailures,
            capturedOutOfMemoryErrors:
                snapshot.aggregates.outOfMemoryFailures,
            capturedNativeFailures:
                snapshot.aggregates.nativeFailures,
            uncapturedErrors: snapshot.aggregates.uncapturedErrors,
            deviceLosses: snapshot.aggregates.deviceLosses,
            pendingOperations: snapshot.pendingOperations.length,
            currentMappings:
                snapshot.bufferMapping.currentMappings,
            currentStagingBytes:
                snapshot.readbackMemory.currentStagingBytes,
            currentRetainedHostBytes:
                snapshot.readbackMemory.currentRetainedHostBytes,
            currentPendingNativeObservations:
                snapshot.submissionNative.currentPendingNativeObservations,
        }
    }

    function terminalFacts(snapshot) {

        const facts = {
            pendingOperations: snapshot.pendingOperations.length,
            currentMappings: snapshot.bufferMapping.currentMappings,
            activeReadbackMappings:
                snapshot.readbackMemory.activeMappings,
            currentStagingBytes:
                snapshot.readbackMemory.currentStagingBytes,
            currentRetainedHostBytes:
                snapshot.readbackMemory.currentRetainedHostBytes,
            currentPendingNativeObservations:
                snapshot.submissionNative.currentPendingNativeObservations,
            currentEffectfulSubmittedWork:
                snapshot.submissionNative.currentEffectfulSubmittedWork,
            liveResources: snapshot.resources.length,
            liveBindLayouts: snapshot.bindLayouts.length,
            liveBindSets: snapshot.bindSets.length,
            livePipelines: snapshot.pipelines.length,
            liveReadbacks: snapshot.readbacks.length,
            liveReadbackCommands: snapshot.readbackCommands.length,
        }
        return {
            ...facts,
            isClean: Object.values(facts).every(value => value === 0),
        }
    }

    function skippedResult(name, capabilityFact, contracts) {

        return {
            name,
            status: 'skipped',
            capabilityFact,
            ...contracts,
        }
    }

    function failedCapabilityResult(name, capabilityFact, contracts) {

        return {
            name,
            status: 'failed',
            capabilityFact,
            ...contracts,
        }
    }

    function serializeFailure(error) {

        return {
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            diagnostic: error?.diagnostic,
            report: error?.report,
            incident: error?.incident,
        }
    }

    function serializeGpuError(error) {

        return {
            name: error?.constructor?.name ?? 'GPUError',
            message: error?.message ?? String(error),
        }
    }

    function aggregateProofs(proofs) {

        const executed = proofs.filter(proof => proof?.status !== 'skipped')
        const passed = proofs.filter(proof => proof?.status === 'passed')
        const skipped = proofs.filter(proof => proof?.status === 'skipped')
        const failed = proofs.filter(proof => proof?.status === 'failed')
        return {
            proofCount: proofs.length,
            executedCount: executed.length,
            passedCount: passed.length,
            skippedCount: skipped.length,
            failedCount: failed.length,
            capturedValidationErrors: executed.reduce(
                (sum, proof) =>
                    sum +
                    (proof.observations?.capturedValidationErrors ?? 0),
                0
            ),
            capturedOutOfMemoryErrors: executed.reduce(
                (sum, proof) =>
                    sum +
                    (proof.observations?.capturedOutOfMemoryErrors ?? 0),
                0
            ),
            capturedNativeFailures: executed.reduce(
                (sum, proof) =>
                    sum +
                    (proof.observations?.capturedNativeFailures ?? 0),
                0
            ),
            uncapturedErrors: executed.reduce(
                (sum, proof) => sum + (proof.uncaptured?.length ?? 0),
                0
            ),
            deviceLosses: executed.reduce(
                (sum, proof) =>
                    sum + (proof.observations?.deviceLosses ?? 0),
                0
            ),
            allExecutedTerminalsClean: executed.every(
                proof => proof.terminal?.isClean === true
            ),
            failedNames: failed.map(proof => proof.name),
            skippedFacts: skipped.map(proof => ({
                name: proof.name,
                capabilityFact: proof.capabilityFact,
            })),
        }
    }

    function emptyAggregate() {

        return {
            proofCount: 0,
            executedCount: 0,
            passedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            capturedValidationErrors: 0,
            capturedOutOfMemoryErrors: 0,
            capturedNativeFailures: 0,
            uncapturedErrors: 0,
            deviceLosses: 0,
            allExecutedTerminalsClean: true,
            failedNames: [],
            skippedFacts: [],
        }
    }

    function numberOrUndefined(value) {

        return typeof value === 'number' ? value : undefined
    }
}

function validateResult({
    probe: current,
    fatalError: fatal,
    cleanupError: cleanup,
    serverClosed: closed,
    pageEvents: events,
}) {

    const failures = []
    if (fatal !== undefined) failures.push(`fatal: ${fatal}`)
    if (cleanup !== undefined) failures.push(`cleanup: ${cleanup}`)
    if (!closed) failures.push('Vite port remained open after cleanup')
    if (events.pageErrors.length > 0) {
        failures.push(`${events.pageErrors.length} page errors`)
    }
    if (events.consoleErrors.length > 0) {
        failures.push(`${events.consoleErrors.length} console errors`)
    }
    if (events.requestFailures.length > 0) {
        failures.push(`${events.requestFailures.length} request failures`)
    }
    if (current === undefined) return failures
    if (
        current.capabilities.navigatorGpu !== true ||
        current.capabilities.adapterAvailable !== true
    ) {
        failures.push('WebGPU adapter unavailable')
        return failures
    }

    if (
        current.capabilities.adapterSelection?.powerPreference !==
            adapterPowerPreference ||
        current.capabilities.discoveryRequestFacts?.adapter?.powerPreference !==
            adapterPowerPreference
    ) {
        failures.push('capability discovery did not use the fixed adapter selection')
    }
    if (current.capabilities.discoveryTerminal?.isClean !== true) {
        failures.push('capability discovery runtime retained live state')
    }

    const enableProofs = Array.isArray(current.enableExtensions)
        ? current.enableExtensions
        : []
    const languageProofs = Array.isArray(current.languageExtensions)
        ? current.languageExtensions
        : []
    if (!sameStrings(
        enableProofs.map(proof => proof.name),
        expectedEnableProofNames
    )) {
        failures.push('enable-extension proof set is incomplete or reordered')
    }
    if (!sameStrings(
        languageProofs.map(proof => proof.name),
        expectedLanguageProofNames
    )) {
        failures.push('language-extension proof set is incomplete or reordered')
    }
    const nestedMatrix = current.layoutProofs?.nestedMatrix
    const proofs = [
        ...enableProofs,
        ...languageProofs,
        nestedMatrix,
    ].filter(proof => proof !== undefined)
    if (
        proofs.length !== 19 ||
        new Set(proofs.map(proof => proof.name)).size !== 19
    ) {
        failures.push('capability proof matrix must contain 19 unique proofs')
    }

    for (const proof of proofs) {
        const expectedDeviceFeatures =
            expectedDeviceFeaturesByProof[proof.name] ?? []
        const expectedLanguageFeatures =
            expectedLanguageProofNames.includes(proof.name)
                ? [ proof.name ]
                : []
        if (!sameStrings(
            proof.requestedDeviceFeatures ?? [],
            expectedDeviceFeatures
        )) {
            failures.push(`${proof.name}: requested device features drifted`)
        }
        if (!sameStrings(
            proof.requiredLanguageFeatures ?? [],
            expectedLanguageFeatures
        )) {
            failures.push(`${proof.name}: required language features drifted`)
        }
        if (proof.status === 'failed') {
            failures.push(`${proof.name}: ${proof.failure?.message ?? 'failed'}`)
        }
        if (
            proof.status === 'skipped' &&
            (
                proof.capabilityFact === undefined ||
                typeof proof.capabilityFact.kind !== 'string'
            )
        ) {
            failures.push(`${proof.name}: skip lacks capability fact`)
        }
        if (proof.status === 'skipped') {
            validateSkipFact(
                proof,
                expectedDeviceFeatures,
                expectedLanguageFeatures,
                failures
            )
            continue
        }
        if (proof.status !== 'passed') {
            failures.push(`${proof.name}: unexpected status ${proof.status}`)
            continue
        }
        validatePassedProof(
            proof,
            current.capabilities,
            expectedDeviceFeatures,
            expectedLanguageFeatures,
            failures
        )
    }
    if (nestedMatrix?.status !== 'passed') {
        failures.push('nested matrix proof did not pass')
    }
    const f16 = enableProofs.find(proof => proof.name === 'f16')
    const bufferView = languageProofs.find(
        proof => proof.name === 'buffer_view'
    )
    if (
        current.layoutProofs?.f16?.name !== f16?.name ||
        current.layoutProofs?.f16?.status !== f16?.status
    ) {
        failures.push('f16 layout proof alias does not match the matrix row')
    }
    if (
        current.layoutProofs?.bufferView?.name !== bufferView?.name ||
        current.layoutProofs?.bufferView?.status !== bufferView?.status
    ) {
        failures.push('buffer_view layout proof alias does not match the matrix row')
    }
    if (current.aggregateObservations.proofCount !== 19) {
        failures.push('aggregate proof count is not 19')
    }
    if (current.aggregateObservations.failedCount !== 0) {
        failures.push(
            `${current.aggregateObservations.failedCount} capability proofs failed`
        )
    }
    if (current.aggregateObservations.uncapturedErrors !== 0) {
        failures.push(
            `${current.aggregateObservations.uncapturedErrors} uncaptured WebGPU errors`
        )
    }
    if (!current.aggregateObservations.allExecutedTerminalsClean) {
        failures.push('one or more capability proof terminals retained live state')
    }
    return failures
}

function validateSkipFact(
    proof,
    expectedDeviceFeatures,
    expectedLanguageFeatures,
    failures
) {

    const fact = proof.capabilityFact
    if (fact?.kind === 'adapter-feature-missing') {
        if (
            !Array.isArray(fact.missingAdapterFeatures) ||
            fact.missingAdapterFeatures.length === 0 ||
            fact.missingAdapterFeatures.some(feature =>
                !expectedDeviceFeatures.includes(feature)
            )
        ) {
            failures.push(`${proof.name}: adapter skip fact is not capability-specific`)
        }
        return
    }
    if (fact?.kind === 'wgsl-language-feature-missing') {
        if (
            expectedLanguageFeatures.length !== 1 ||
            fact.missingLanguageFeature !== expectedLanguageFeatures[0]
        ) {
            failures.push(`${proof.name}: WGSL skip fact names the wrong feature`)
        }
        return
    }
    if (
        fact?.kind === 'limit-missing' &&
        proof.name === 'immediate_address_space' &&
        fact.limit === 'maxImmediateSize'
    ) {
        return
    }
    failures.push(`${proof.name}: unsupported skip fact ${fact?.kind}`)
}

function validatePassedProof(
    proof,
    capabilities,
    expectedDeviceFeatures,
    expectedLanguageFeatures,
    failures
) {

    const execution = proof.execution
    if (
        typeof execution?.compilationInfo !== 'object' ||
        typeof execution?.pipelineCreation !== 'object' ||
        execution?.submission?.status !== 'observed-succeeded' ||
        !Array.isArray(execution?.readback?.values) ||
        execution.readback.values.length === 0
    ) {
        failures.push(
            `${proof.name}: pass lacks compilation, pipeline, submission, or readback evidence`
        )
    }
    if (
        !sameStrings(
            execution?.programContracts?.requiredFeatures ?? [],
            expectedDeviceFeatures
        ) ||
        !sameStrings(
            execution?.programContracts?.requiredLanguageFeatures ?? [],
            expectedLanguageFeatures
        )
    ) {
        failures.push(`${proof.name}: Program contracts do not match the proof`)
    }
    if (
        proof.runtimeRequestFacts?.adapter?.powerPreference !==
            adapterPowerPreference ||
        !sameStrings(
            proof.runtimeRequestFacts?.device?.requiredFeatures ?? [],
            expectedDeviceFeatures
        )
    ) {
        failures.push(`${proof.name}: Runtime request facts do not match the proof`)
    }
    if (
        !sameAdapterInfo(
            proof.runtimeCapabilities?.adapterInfo,
            capabilities.adapterInfo
        ) ||
        !sameStrings(
            proof.runtimeCapabilities?.adapterFeatures ?? [],
            capabilities.adapterFeatures
        )
    ) {
        failures.push(`${proof.name}: execution adapter differs from discovery`)
    }
    if (expectedDeviceFeatures.some(feature =>
        !proof.runtimeCapabilities?.deviceFeatures?.includes(feature)
    )) {
        failures.push(`${proof.name}: device omitted a requested feature`)
    }
    if (expectedLanguageFeatures.some(feature =>
        !proof.runtimeCapabilities?.wgslLanguageFeatures?.includes(feature)
    )) {
        failures.push(`${proof.name}: Runtime omitted a required WGSL feature`)
    }
    if (
        proof.observations?.capturedValidationErrors !== 0 ||
        proof.observations?.capturedOutOfMemoryErrors !== 0 ||
        proof.observations?.capturedNativeFailures !== 0 ||
        proof.observations?.uncapturedErrors !== 0 ||
        proof.observations?.deviceLosses !== 0 ||
        proof.uncaptured?.length !== 0 ||
        proof.terminal?.isClean !== true
    ) {
        failures.push(`${proof.name}: execution retained errors or live state`)
    }
}

function sameStrings(left, right) {

    return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    )
}

function sameAdapterInfo(left, right) {

    const fields = [
        'vendor',
        'architecture',
        'device',
        'description',
        'subgroupMinSize',
        'subgroupMaxSize',
        'isFallbackAdapter',
    ]
    return (
        left !== undefined &&
        right !== undefined &&
        fields.every(field => left[field] === right[field])
    )
}

function observePage(page, events) {

    page.on('console', message => {
        if (message.type() === 'error') {
            events.consoleErrors.push(message.text())
        }
    })
    page.on('pageerror', error => events.pageErrors.push(error.message))
    page.on('requestfailed', request => {
        events.requestFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText ?? 'unknown',
        })
    })
}

function startVite(activePort) {

    const child = spawn(process.execPath, [
        viteEntry,
        '--host',
        '127.0.0.1',
        '--port',
        String(activePort),
        '--strictPort',
    ], {
        cwd: examplesRoot,
        stdio: [ 'ignore', 'pipe', 'pipe' ],
    })
    const state = { child, stdout: '', stderr: '', spawnError: undefined }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { state.stdout += chunk })
    child.stderr.on('data', chunk => { state.stderr += chunk })
    child.on('error', error => { state.spawnError = error })
    return state
}

async function waitForVite(state, url) {

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeout) {
        if (state.spawnError !== undefined) throw state.spawnError
        if (state.child.exitCode !== null) {
            throw new Error(
                `Vite exited before readiness with code ${state.child.exitCode}.`
            )
        }
        try {
            const response = await fetch(url)
            if (response.ok) return
        } catch {
            // Retry until the bounded readiness deadline.
        }
        await delay(100)
    }
    throw new Error(`Vite did not become ready at ${url}.`)
}

async function stopVite(state) {

    if (state.child.exitCode !== null || state.child.signalCode !== null) return
    state.child.kill('SIGTERM')
    try {
        await waitForExit(state.child, 5_000)
    } catch {
        state.child.kill('SIGKILL')
        await waitForExit(state.child, 5_000)
    }
}

async function waitForExit(child, duration) {

    if (child.exitCode !== null || child.signalCode !== null) return
    await withTimeout(new Promise((resolveExit, rejectExit) => {
        child.once('exit', resolveExit)
        child.once('error', rejectExit)
    }), duration, 'Vite shutdown')
}

async function findAvailablePort() {

    const server = createServer()
    await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    const activePort = typeof address === 'object' && address !== null
        ? address.port
        : undefined
    await new Promise((resolveClose, rejectClose) => {
        server.close(error => error === undefined
            ? resolveClose()
            : rejectClose(error)
        )
    })
    if (activePort === undefined) {
        throw new Error('Failed to allocate a browser proof port.')
    }
    return activePort
}

async function waitForPortClosed(activePort) {

    for (let attempt = 0; attempt < 50; attempt++) {
        if (!await portIsOpen(activePort)) return true
        await delay(100)
    }
    return false
}

async function portIsOpen(activePort) {

    return await new Promise(resolveOpen => {
        const socket = createConnection({
            host: '127.0.0.1',
            port: activePort,
        })
        socket.once('connect', () => {
            socket.destroy()
            resolveOpen(true)
        })
        socket.once('error', () => resolveOpen(false))
        socket.setTimeout(250, () => {
            socket.destroy()
            resolveOpen(false)
        })
    })
}

async function withTimeout(promise, duration, label) {

    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out.`)),
                    duration
                )
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

function positiveInteger(value, fallback) {

    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return parsed
}

function serializeError(error) {

    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
}

function delay(duration) {

    return new Promise(resolveDelay => setTimeout(resolveDelay, duration))
}
