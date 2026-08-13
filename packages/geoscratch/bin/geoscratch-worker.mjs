#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const command = process.argv[2]
if (command !== 'build') fail('Usage: geoscratch-worker build --config <file>')
const configArgument = optionValue(process.argv.slice(3), '--config')
if (configArgument === undefined) fail('Worker module build requires --config <file>.')

const workingDirectory = process.cwd()
const configPath = path.resolve(workingDirectory, configArgument)
const configModule = await loadConfigModule(configPath)
const config = configModule.default
validateBuildConfig(config)

const configDirectory = path.dirname(configPath)
const outDir = path.resolve(configDirectory, config.outDir)
await assertSafeOutputDirectory(outDir, workingDirectory)
await assertReplaceableOutputDirectory(outDir)
const temporaryOutDir = `${outDir}.tmp-${process.pid}-${Date.now()}`
const previousOutDir = `${outDir}.previous-${process.pid}-${Date.now()}`

try {
    await mkdir(path.dirname(outDir), { recursive: true })
    await rm(temporaryOutDir, { recursive: true, force: true })
    await mkdir(temporaryOutDir, { recursive: true })
    const modules = []
    for (const descriptor of config.modules) {
        modules.push(await buildModule(descriptor, configDirectory, temporaryOutDir))
    }
    modules.sort((left, right) =>
        left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
    )
    const manifest = Object.freeze({
        kind: 'geoscratch-worker-module-manifest',
        schemaVersion: 1,
        modules: Object.freeze(modules),
    })
    await writeFile(
        path.join(temporaryOutDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
    )
    await assertSafeOutputDirectory(outDir, workingDirectory)
    await assertReplaceableOutputDirectory(outDir)
    await replaceOutputDirectory(temporaryOutDir, outDir, previousOutDir)
    process.stdout.write(`${JSON.stringify({
        kind: 'geoscratch-worker-module-build-result',
        schemaVersion: 1,
        moduleCount: modules.length,
        outDir,
    })}\n`)
} catch (error) {
    await rm(temporaryOutDir, { recursive: true, force: true })
    throw error
}

async function buildModule(descriptor, configDirectory, outputDirectory) {

    const entry = path.resolve(configDirectory, descriptor.entry)
    await requireFile(entry, `Worker module ${descriptor.contract.id} source entry`)
    const identity = JSON.stringify({
        id: descriptor.contract.id,
        version: descriptor.contract.version,
    })
    const output = await build({
        stdin: {
            contents: `
                import workerModule from ${JSON.stringify(entry)}
                const expected = ${identity}
                if (workerModule === null || typeof workerModule !== 'object' ||
                    workerModule.id !== expected.id || workerModule.version !== expected.version ||
                    workerModule.operations === null || typeof workerModule.operations !== 'object') {
                    throw new TypeError(
                        'Worker module artifact identity does not match ' +
                        expected.id + '@' + expected.version + '.'
                    )
                }
                export default workerModule
            `,
            resolveDir: configDirectory,
            sourcefile: `${safeFileName(descriptor.contract.id)}.worker-entry.js`,
            loader: 'js',
        },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: [ 'es2022' ],
        write: false,
        sourcemap: 'external',
        sourcesContent: true,
        legalComments: 'none',
        treeShaking: true,
        outfile: path.join(outputDirectory, 'module.js'),
    })
    const javascript = output.outputFiles.find(file => file.path.endsWith('.js'))
    const sourceMap = output.outputFiles.find(file => file.path.endsWith('.js.map'))
    if (javascript === undefined || sourceMap === undefined) {
        throw new Error(`Worker module ${descriptor.contract.id} did not emit ESM and source map artifacts.`)
    }
    const source = javascript.text
    const sourceMapBytes = Buffer.from(sourceMap.contents)
    const sourceMapDigest = sha256(sourceMapBytes)
    const sourceMapName = `${safeFileName(descriptor.contract.id)}-${sourceMapDigest.slice(0, 12)}.js.map`
    const sourceWithMap = `${source.trimEnd()}\n//# sourceMappingURL=${sourceMapName}\n`
    const sourceBytes = Buffer.from(sourceWithMap)
    const digest = sha256(sourceBytes)
    const baseName = `${safeFileName(descriptor.contract.id)}-${digest.slice(0, 12)}.js`
    await writeFile(path.join(outputDirectory, baseName), sourceBytes)
    await writeFile(path.join(outputDirectory, sourceMapName), sourceMapBytes)
    return Object.freeze({
        id: descriptor.contract.id,
        version: descriptor.contract.version,
        url: `./${baseName}`,
        byteLength: sourceBytes.byteLength,
        sha256: sha256(sourceBytes),
        sourceMap: Object.freeze({
            url: `./${sourceMapName}`,
            byteLength: sourceMapBytes.byteLength,
            sha256: sha256(sourceMapBytes),
        }),
    })
}

async function loadConfigModule(configPath) {

    if (!/\.(?:ts|mts|cts)$/.test(configPath)) {
        return import(`${pathToFileURL(configPath).href}?build=${Date.now()}`)
    }
    const output = await build({
        entryPoints: [ configPath ],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: [ 'node18' ],
        write: false,
        sourcemap: false,
        legalComments: 'none',
        outfile: 'worker-build.config.mjs',
    })
    const source = output.outputFiles.find(file => file.path.endsWith('.mjs'))
    if (source === undefined) throw new Error(`Worker build config did not compile: ${configPath}`)
    return import(`data:text/javascript;base64,${Buffer.from(source.contents).toString('base64')}`)
}

function validateBuildConfig(config) {

    if (config?.kind !== 'worker-module-build' || typeof config.outDir !== 'string' ||
        !Array.isArray(config.modules) || config.modules.length === 0) {
        fail('Worker module build config must be created by defineWorkerModuleBuild().')
    }
    const identities = new Set()
    for (const descriptor of config.modules) {
        if (descriptor?.contract?.kind !== 'worker-module-contract' ||
            typeof descriptor.entry !== 'string' || descriptor.entry.length === 0) {
            fail('Worker module build entries require a contract and source entry.')
        }
        const key = `${descriptor.contract.id}\u0000${descriptor.contract.version}`
        if (identities.has(key)) fail(`Duplicate Worker module ${descriptor.contract.id}@${descriptor.contract.version}.`)
        identities.add(key)
    }
}

async function assertSafeOutputDirectory(outputDirectory, projectDirectory) {

    const relative = path.relative(projectDirectory, outputDirectory)
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('Worker module output must be a child directory of the command working directory.')
    }
    const [ canonicalProject, canonicalOutput ] = await Promise.all([
        realpath(projectDirectory),
        prospectiveRealPath(outputDirectory),
    ])
    const canonicalRelative = path.relative(canonicalProject, canonicalOutput)
    if (canonicalRelative.length === 0 || canonicalRelative.startsWith('..') ||
        path.isAbsolute(canonicalRelative)) {
        fail('Worker module output must resolve inside the command working directory.')
    }
}

async function prospectiveRealPath(target) {

    const suffix = []
    let candidate = target
    while (true) {
        try {
            return path.resolve(await realpath(candidate), ...suffix.reverse())
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error
            const parent = path.dirname(candidate)
            if (parent === candidate) throw error
            suffix.push(path.basename(candidate))
            candidate = parent
        }
    }
}

async function assertReplaceableOutputDirectory(outputDirectory) {

    let entries
    try {
        const facts = await stat(outputDirectory)
        if (!facts.isDirectory()) refuseNonGeneratedOutput()
        entries = await readdir(outputDirectory)
    } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
    }
    if (entries.length === 0) return
    let manifest
    try {
        manifest = JSON.parse(await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8'))
    } catch {
        refuseNonGeneratedOutput()
    }
    if (manifest?.kind !== 'geoscratch-worker-module-manifest' ||
        manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules)) {
        refuseNonGeneratedOutput()
    }
}

function refuseNonGeneratedOutput() {

    fail('Worker module build refuses to replace a non-generated output directory.')
}

async function replaceOutputDirectory(temporaryDirectory, outputDirectory, previousDirectory) {

    let previousMoved = false
    try {
        await rename(outputDirectory, previousDirectory)
        previousMoved = true
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error
    }
    try {
        await rename(temporaryDirectory, outputDirectory)
    } catch (error) {
        if (previousMoved) await rename(previousDirectory, outputDirectory)
        throw error
    }
    if (previousMoved) await rm(previousDirectory, { recursive: true, force: true })
}

function optionValue(arguments_, name) {

    const index = arguments_.indexOf(name)
    if (index === -1) return undefined
    const value = arguments_[index + 1]
    if (value === undefined || value.startsWith('--')) fail(`${name} requires a value.`)
    if (arguments_.indexOf(name, index + 1) !== -1) fail(`${name} may only be provided once.`)
    return value
}

async function requireFile(file, label) {

    try {
        const facts = await stat(file)
        if (!facts.isFile()) throw new Error('not a file')
        await readFile(file)
    } catch (error) {
        throw new Error(`${label} does not exist: ${file}`, { cause: error })
    }
}

function sha256(bytes) {

    return createHash('sha256').update(bytes).digest('hex')
}

function safeFileName(id) {

    return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

function fail(message) {

    throw new TypeError(message)
}
