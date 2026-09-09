import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function substitute(source, before, after) {
    if (!source.includes(before)) throw new Error(`Gate adapter anchor missing: ${before}`)
    return source.replace(before, after)
}

// Reuse the real browser gates without their backend rebuild or service launch.
// Only the asserted producer location/upload count changes for CPU variants.
export async function prepareGate(root, outputDirectory, suite) {
    const streaming = suite === 'streaming'
    const name = streaming ? 'underwater-terrain-streaming' : 'underwater-terrain-tile-wireframe'
    let source = await readFile(`${root}/tests/browser/${name}.mjs`, 'utf8')
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
            "facts.selectionPath !== 'gpu-camera-inverse-webmercatorquad-cover'",
            'facts.selectionPath !== expectedSelectionPath')
        source = substitute(source, "facts.cpuSelectionUploadCount !== '0'",
            "(expectedSelectionPath.startsWith('experimental') ? !(Number(facts.cpuSelectionUploadCount) > 0) : facts.cpuSelectionUploadCount !== '0')")
        source = substitute(source, 'virtualRaster?.coordinateBits !== 40',
            'virtualRaster?.coordinateBits !== expectedCoordinateBits')
    } else {
        source = source.slice(0, serviceStart) +
            'let baseUrl, tileBaseUrl, expectedSelectionPath\n' +
            gateEntry(false) + source.slice(functionsStart)
        source = substitute(source,
            "baseline?.graphContract?.selectionPath ===\n            'gpu-camera-inverse-webmercatorquad-cover'",
            'baseline?.graphContract?.selectionPath === expectedSelectionPath')
    }
    const file = `${outputDirectory}/${name}-adapter.mjs`
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
