import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function substitute(source, before, after) {
    if (!source.includes(before)) throw new Error(`Gate adapter anchor missing: ${before}`)
    return source.replace(before, after)
}

// Reuse the real browser gates without their backend rebuild or service launch.
// Only the asserted producer location/upload count changes for CPU variants.
async function gateSource(root, name, baseline) {
    const file = `tests/browser/${name}.mjs`
    return baseline === undefined ? readFile(`${root}/${file}`, 'utf8') :
        execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root }).toString()
}
export async function prepareGate(root, outputDirectory, suite, baseline) {
    if (suite === 'lifecycle') return prepareLifecycleGate(root, outputDirectory, baseline)
    const streaming = suite === 'streaming'
    const name = streaming ? 'underwater-terrain-streaming' : 'underwater-terrain-tile-wireframe'
    let source = await gateSource(root, name, baseline)
    source = substitute(source, "from 'playwright'", `from '${pathToFileURL(`${root}/node_modules/playwright/index.mjs`).href}'`)
    source = substitute(source,
        "const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')",
        `const repositoryRoot = ${JSON.stringify(root)}`)
    source = substitute(source, 'const outputDirectory = resolve(', 'let outputDirectory = resolve(')
    const serviceStart = source.indexOf('const vitePort = await findAvailablePort()')
    const functionsStart = source.indexOf('async function runProof(activeBrowser)')
    if (serviceStart < 0 || functionsStart < 0) throw new Error('Gate service boundaries changed')
    if (streaming) {
        const cameraStart = source.indexOf('const operationalAtlasPages', serviceStart)
        const launchStart = source.indexOf('await mkdir(outputDirectory', cameraStart)
        source = source.slice(0, serviceStart) +
            'let baseUrl, tileBaseUrl, cacheNamespace, expectedSelectionPath, expectedCoordinateBits\n' +
            source.slice(cameraStart, launchStart) + gateEntry(true) + source.slice(functionsStart)
        source = substitute(source,
            `facts.selectionPath !== '${baseline === undefined ? "cpu" : "gpu"}-camera-inverse-webmercatorquad-cover'`,
            'facts.selectionPath !== expectedSelectionPath')
        if (baseline !== undefined) source = substitute(source, "facts.cpuSelectionUploadCount !== '0'",
            "(expectedSelectionPath.startsWith('experimental') ? !(Number(facts.cpuSelectionUploadCount) > 0) : facts.cpuSelectionUploadCount !== '0')")
        source = substitute(source, 'virtualRaster?.coordinateBits !== 40',
            'virtualRaster?.coordinateBits !== expectedCoordinateBits')
    } else {
        source = source.slice(0, serviceStart) +
            'let baseUrl, tileBaseUrl, expectedSelectionPath\n' +
            gateEntry(false) + source.slice(functionsStart)
        source = substitute(source,
            `baseline?.graphContract?.selectionPath ===\n            '${baseline === undefined ? "cpu" : "gpu"}-camera-inverse-webmercatorquad-cover'`,
            'baseline?.graphContract?.selectionPath === expectedSelectionPath')
    }
    const file = `${outputDirectory}/${name}-adapter.mjs`
    await writeFile(file, source)
    return (await import(pathToFileURL(file).href)).runGate
}

async function prepareLifecycleGate(root, outputDirectory, baseline) {
    let source = await gateSource(root, 'scratch-underwater-terrain', baseline)
    source = substitute(source, "from 'playwright'", `from '${pathToFileURL(`${root}/node_modules/playwright/index.mjs`).href}'`)
    source = substitute(source,
        "const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')",
        `const repositoryRoot = ${JSON.stringify(root)}`)
    source = substitute(source, 'const outputDirectory = resolve(', 'let outputDirectory = resolve(')
    const portsStart = source.indexOf('const port = process.env.UNDERWATER_TERRAIN_BROWSER_PORT')
    const expectationsStart = source.indexOf('const expectedStageOrder', portsStart)
    const launchStart = source.indexOf('await mkdir(outputDirectory')
    const functionsStart = source.indexOf('async function verifyUnderwaterTerrain(activeBrowser)')
    if ([portsStart, expectationsStart, launchStart, functionsStart].some(index => index < 0)) throw new Error('Lifecycle gate boundaries changed')
    source = source.slice(0, portsStart) + 'let baseUrl, tileBaseUrl, port, tilePort, expectedCoordinateBits\n' +
        source.slice(expectationsStart, launchStart) + `
export async function runGate(activeBrowser, options) {
    baseUrl = options.baseUrl
    tileBaseUrl = options.tileBaseUrl
    port = Number(new URL(baseUrl).port)
    tilePort = Number(new URL(tileBaseUrl).port)
    expectedCoordinateBits = options.coordinateBits
    outputDirectory = options.outputDirectory
    await mkdir(outputDirectory, { recursive: true })
    const verified = await verifyUnderwaterTerrain(activeBrowser)
    const failuresOfConstruction = []
    for (const scenario of failureScenarios) failuresOfConstruction.push(await verifyFailureScenario(activeBrowser, scenario))
    const failures = validateResult({ adapter: verified.adapter, normalProof: verified.proof,
        failureProofs: failuresOfConstruction, browserClosed: true, serverClosed: true, tileServerClosed: true })
    return { failures, adapter: verified.adapter, normalProof: summarizeNormalProof(verified.proof),
        failureProofs: failuresOfConstruction.map(summarizeFailureProof) }
}
\n` + source.slice(functionsStart)
    source = substitute(source, 'virtualRaster?.coordinateBits !== 40',
        'virtualRaster?.coordinateBits !== expectedCoordinateBits')
    const file = `${outputDirectory}/terrain-lifecycle-adapter.mjs`
    await writeFile(file, source)
    return (await import(pathToFileURL(file).href)).runGate
}

function gateEntry(streaming) {
    return `
export async function runGate(browser, options) {
    baseUrl = options.baseUrl
    tileBaseUrl = options.tileBaseUrl
    outputDirectory = options.outputDirectory
    expectedSelectionPath = options.selectionPath
    ${streaming ? "cacheNamespace = 'terrain-placement-' + Date.now(); expectedCoordinateBits = options.coordinateBits" : ''}
    await mkdir(outputDirectory, { recursive: true })
    const proof = ${streaming ? 'await runProof(browser)' : '{ ...await runProof(browser), dprInvariance: await runDprInvariance(browser) }'}
    // Real process cleanup is separately checked by the owning experiment runner.
    const failures = validateProof(proof, { browserClosed: true, viteClosed: true, tileServerClosed: true })
    return { proof: ${streaming ? 'summarizeProof(proof)' : 'proof'}, failures }
}

`
}
