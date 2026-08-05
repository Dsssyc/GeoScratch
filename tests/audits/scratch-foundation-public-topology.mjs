import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const root = process.cwd()
const baselineCommit = '063b543'
const manifestPath = path.join(
    root,
    'docs',
    'review',
    'manifests',
    'scratch-foundation-public-symbols.json'
)
const planPath = path.join(
    root,
    'docs',
    'superpowers',
    'plans',
    '2026-08-05-scratch-foundation-public-topology.md'
)

const baselineEntrypoints = Object.freeze({
    root: 'packages/geoscratch/src/index.ts',
    scratch: 'packages/geoscratch/src/scratch.ts',
    worker: 'packages/geoscratch/src/worker.ts',
    geometry: 'packages/geoscratch/src/geometry/index.js',
    geo: 'packages/geoscratch/src/geo/index.ts',
})
const gpuFacade = 'packages/geoscratch/src/scratch/index.ts'
const removedWorkerNames = new Set([
    'WorkerDiagnosticError',
    'WorkerDiagnosticSeverity',
    'createWorkerDiagnostic',
])
const removedGeoNames = new Set([
    'GeoQuadNode2D',
    'IndexedDbVirtualRasterPersistentStoreDescriptor',
    'MapOptions',
    'Node2D',
    'VirtualRasterCache',
    'VirtualRasterCacheDeleteOutcome',
    'VirtualRasterCacheDescriptor',
    'VirtualRasterCacheFacts',
    'VirtualRasterCacheInvalidation',
    'VirtualRasterCacheKey',
    'VirtualRasterCacheKeyDescriptor',
    'VirtualRasterCachePolicy',
    'VirtualRasterCachePutOutcome',
    'VirtualRasterCachePutStatus',
    'VirtualRasterCacheRecord',
    'VirtualRasterCacheRecordDescriptor',
    'VirtualRasterPersistentEntry',
    'VirtualRasterPersistentStorageFacts',
    'VirtualRasterPersistentStore',
    'createVirtualRasterCache',
    'openIndexedDbVirtualRasterPersistentStore',
    'virtualRasterCacheKey',
])
const scratchGeometryNames = new Set([ 'PlaneGeometry', 'SphereGeometry', 'plane', 'sphere' ])
const targetAdditions = Object.freeze([
    { targetSurface: 'scratch', name: 'CacheDeleteOutcome', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheDiagnostic', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheDiagnosticCode', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheDiagnosticInput', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheDiagnosticPhase', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheDiagnosticSubject', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheEntryDescriptor', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheGarbageCollectionOptions', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheGarbageCollectionOutcome', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheHistoryEntry', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheHistoryKind', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheInvalidation', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheMissReason', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CachePutOutcome', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CachePutStatus', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheReadOutcome', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheRecord', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheStorageErrorFacts', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'CacheStorageFacts', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'GPUDiagnostic', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'GPUDiagnosticPhase', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PersistentCache', kinds: [ 'type', 'value' ] },
    { targetSurface: 'scratch', name: 'PersistentCacheDescriptor', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PersistentCacheFacts', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PersistentCacheKey', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PersistentCacheKeyDescriptor', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PersistentCacheState', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'PlaneGeometry', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticBase', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticDomain', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticErrorContext', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticErrorOptions', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticEvidence', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticSeverity', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'ScratchDiagnosticSuggestion', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'SphereGeometry', kinds: [ 'type' ] },
    { targetSurface: 'geo', name: 'VirtualRasterCacheAddress', kinds: [ 'type' ] },
    { targetSurface: 'geo', name: 'VirtualRasterCacheAddressDescriptor', kinds: [ 'type' ] },
    { targetSurface: 'geo', name: 'VirtualRasterCacheInvalidationPrefixes', kinds: [ 'type' ] },
    { targetSurface: 'geo', name: 'VirtualRasterCacheMetadata', kinds: [ 'type' ] },
    { targetSurface: 'scratch', name: 'createCacheDiagnostic', kinds: [ 'value' ] },
    { targetSurface: 'scratch', name: 'isScratchDiagnosticError', kinds: [ 'value' ] },
    { targetSurface: 'scratch', name: 'persistentCacheKey', kinds: [ 'value' ] },
    { targetSurface: 'geo', name: 'virtualRasterCacheAddress', kinds: [ 'value' ] },
])

function createPackageProgram() {

    const configPath = path.join(root, 'packages', 'geoscratch', 'tsconfig.build.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error !== undefined) throw new Error(formatDiagnostics([ config.error ]))
    const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath
    )
    if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors))
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const diagnostics = ts.getPreEmitDiagnostics(program)
        .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics))
    return program
}

function formatDiagnostics(diagnostics) {

    return ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: fileName => fileName,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
    })
}

function collectExports(program, relativePath) {

    const checker = program.getTypeChecker()
    const sourceFile = program.getSourceFile(path.join(root, relativePath))
    if (sourceFile === undefined) throw new Error(`Missing public entrypoint: ${relativePath}`)
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) throw new Error(`Missing module symbol: ${relativePath}`)

    return checker.getExportsOfModule(moduleSymbol)
        .map(symbol => {
            const target = (symbol.flags & ts.SymbolFlags.Alias) === 0
                ? symbol
                : checker.getAliasedSymbol(symbol)
            const kinds = []
            if ((target.flags & ts.SymbolFlags.Value) !== 0) kinds.push('value')
            if ((target.flags & ts.SymbolFlags.Type) !== 0) kinds.push('type')
            if (kinds.length === 0 && (target.flags & ts.SymbolFlags.Namespace) !== 0) {
                kinds.push('value')
            }
            if (kinds.length === 0) {
                throw new Error(`Unclassified symbol flags for ${relativePath}:${symbol.name}`)
            }
            return Object.freeze({ name: symbol.name, kinds: Object.freeze(kinds.sort()) })
        })
        .sort(compareSymbols)
}

function compareSymbols(left, right) {

    return left.name.localeCompare(right.name) || left.kinds.join(',').localeCompare(right.kinds.join(','))
}

function renameMapFromPlan() {

    const source = fs.readFileSync(planPath, 'utf8')
    const entries = [ ...source.matchAll(/^([A-Za-z][A-Za-z0-9]*)\s+->\s+([A-Za-z][A-Za-z0-9]*)$/gm) ]
    const result = new Map()
    for (const match of entries) {
        const previous = result.get(match[1])
        if (previous !== undefined && previous !== match[2]) {
            throw new Error(`Conflicting rename for ${match[1]}: ${previous} / ${match[2]}`)
        }
        result.set(match[1], match[2])
    }
    return result
}

function classify(surface, symbol, gpuNames, renames) {

    const targetName = renames.get(symbol.name) ?? symbol.name
    if (surface === 'worker') {
        if (removedWorkerNames.has(symbol.name)) return disposition('remove', symbol)
        return disposition('move', symbol, 'scratch', targetName)
    }
    if (surface === 'geometry') {
        return disposition('move', symbol, 'scratch', targetName)
    }
    if (surface === 'geo') {
        if (removedGeoNames.has(symbol.name)) return disposition('remove', symbol)
        return disposition(targetName === symbol.name ? 'preserve' : 'rename', symbol, 'geo', targetName)
    }
    if (renames.has(symbol.name)) {
        return disposition('rename', symbol, 'scratch', targetName)
    }
    if (gpuNames.has(symbol.name)) {
        return disposition(targetName === symbol.name ? 'move' : 'rename', symbol, 'scratch', targetName)
    }
    if (scratchGeometryNames.has(symbol.name)) {
        return disposition('move', symbol, 'scratch', targetName)
    }
    if (symbol.name === 'MercatorCoordinate') {
        return disposition('move', symbol, 'geo', symbol.name)
    }
    return disposition('remove', symbol)
}

function disposition(kind, symbol, targetSurface, targetName) {

    return Object.freeze({
        disposition: kind,
        ...(targetSurface === undefined ? {} : { targetSurface }),
        ...(targetName === undefined ? {} : { targetName }),
        kinds: symbol.kinds,
    })
}

function buildBaselineManifest() {

    const program = createPackageProgram()
    const gpuNames = new Set(collectExports(program, gpuFacade).map(symbol => symbol.name))
    const renames = renameMapFromPlan()
    const entries = []

    for (const [ surface, entrypoint ] of Object.entries(baselineEntrypoints)) {
        for (const symbol of collectExports(program, entrypoint)) {
            entries.push(Object.freeze({
                surface,
                name: symbol.name,
                ...classify(surface, symbol, gpuNames, renames),
            }))
        }
    }
    entries.sort((left, right) => (
        left.surface.localeCompare(right.surface) || compareSymbols(left, right)
    ))
    const groupedEntries = groupEntries(entries)
    const facets = groupedEntries.reduce(
        (count, entry) => count + entry.kinds.length * entry.surfaces.length,
        0
    )
    const inventoryHash = sha256(JSON.stringify(groupedEntries))
    return Object.freeze({
        version: 1,
        baselineCommit,
        baselineEntrypoints,
        entryCount: entries.length,
        facetCount: facets,
        inventoryHash,
        targetAdditions,
        entries: groupedEntries,
    })
}

function groupEntries(entries) {

    const grouped = new Map()
    for (const { surface, ...entry } of entries) {
        const key = JSON.stringify(entry)
        const current = grouped.get(key)
        if (current === undefined) {
            grouped.set(key, { surfaces: [ surface ], ...entry })
        } else {
            current.surfaces.push(surface)
        }
    }
    return [ ...grouped.values() ]
        .map(entry => Object.freeze({ ...entry, surfaces: Object.freeze(entry.surfaces.sort()) }))
        .sort((left, right) => (
            left.name.localeCompare(right.name) ||
            left.surfaces.join(',').localeCompare(right.surfaces.join(',')) ||
            left.kinds.join(',').localeCompare(right.kinds.join(','))
        ))
}

function verifyManifest(manifest) {

    assertEqual(manifest.baselineCommit, baselineCommit, 'baseline commit')
    assertEqual(
        stableJson(manifest.targetAdditions),
        stableJson(targetAdditions),
        'target additions'
    )
    assertEqual(
        manifest.entries.reduce((count, entry) => count + entry.surfaces.length, 0),
        manifest.entryCount,
        'baseline entry count'
    )
    assertEqual(
        manifest.entries.reduce(
            (count, entry) => count + entry.kinds.length * entry.surfaces.length,
            0
        ),
        manifest.facetCount,
        'baseline facet count'
    )
    assertEqual(sha256(JSON.stringify(manifest.entries)), manifest.inventoryHash, 'baseline inventory hash')

    const renames = renameMapFromPlan()
    const baselineFacets = new Set()
    for (const entry of manifest.entries) {
        if (![ 'preserve', 'rename', 'move', 'remove' ].includes(entry.disposition)) {
            throw new Error(`Unknown disposition for ${entry.name}: ${entry.disposition}`)
        }
        for (const surface of entry.surfaces) {
            for (const kind of entry.kinds) {
                const facet = `${surface}:${entry.name}:${kind}`
                if (baselineFacets.has(facet)) throw new Error(`Duplicate baseline facet: ${facet}`)
                baselineFacets.add(facet)
            }
        }
        const renamed = renames.get(entry.name)
        if (renamed !== undefined) {
            assertEqual(entry.disposition, 'rename', `${entry.name} disposition`)
            assertEqual(entry.targetName, renamed, `${entry.name} target name`)
        }
    }
    return Object.freeze({ mode: 'manifest', status: 'passed', ...summary(manifest) })
}

function verifyRenamed(manifest) {

    verifyManifest(manifest)
    const program = createPackageProgram()
    const current = {
        scratch: new Map(collectExports(program, gpuFacade).map(symbol => [ symbol.name, symbol.kinds ])),
        geo: new Map(collectExports(program, 'packages/geoscratch/src/geo/index.ts')
            .map(symbol => [ symbol.name, symbol.kinds ])),
    }
    for (const entry of manifest.entries) {
        if (entry.disposition !== 'rename') continue
        const target = current[entry.targetSurface]
        if (target === undefined) throw new Error(`Unknown target surface: ${entry.targetSurface}`)
        const actualKinds = target.get(entry.targetName)
        if (actualKinds === undefined) {
            throw new Error(`Missing renamed target: ${entry.targetSurface}:${entry.targetName}`)
        }
        for (const kind of entry.kinds) {
            if (!actualKinds.includes(kind)) {
                throw new Error(`Missing renamed target facet: ${entry.targetSurface}:${entry.targetName}:${kind}`)
            }
        }
        if (entry.name !== entry.targetName && target.has(entry.name)) {
            throw new Error(`Old renamed symbol remains: ${entry.targetSurface}:${entry.name}`)
        }
    }
    return Object.freeze({ mode: 'renamed', status: 'passed', ...summary(manifest) })
}

function verifyTarget(manifest) {

    const program = createPackageProgram()
    const expected = { scratch: new Map(), geo: new Map() }
    for (const entry of manifest.entries) {
        if (entry.disposition === 'remove') continue
        const target = expected[entry.targetSurface]
        if (target === undefined) throw new Error(`Unknown target surface: ${entry.targetSurface}`)
        const kinds = target.get(entry.targetName) ?? new Set()
        for (const kind of entry.kinds) kinds.add(kind)
        target.set(entry.targetName, kinds)
    }
    for (const addition of manifest.targetAdditions) {
        const target = expected[addition.targetSurface]
        if (target === undefined) throw new Error(`Unknown target surface: ${addition.targetSurface}`)
        const kinds = target.get(addition.name) ?? new Set()
        for (const kind of addition.kinds) kinds.add(kind)
        target.set(addition.name, kinds)
    }

    const targetEntrypoints = {
        scratch: 'packages/geoscratch/src/scratch.ts',
        geo: 'packages/geoscratch/src/geo/index.ts',
    }
    for (const [ surface, entrypoint ] of Object.entries(targetEntrypoints)) {
        const actual = collectExports(program, entrypoint)
        const wanted = [ ...expected[surface] ]
            .map(([ name, kinds ]) => ({ name, kinds: [ ...kinds ].sort() }))
            .sort(compareSymbols)
        assertEqual(stableJson(actual), stableJson(wanted), `${surface} target exports`)
    }
    const rootExports = collectExports(program, 'packages/geoscratch/src/index.ts')
    assertEqual(stableJson(rootExports), stableJson([
        { name: 'geo', kinds: [ 'value' ] },
        { name: 'scratch', kinds: [ 'value' ] },
    ]), 'root namespace exports')
    return Object.freeze({ mode: 'target', status: 'passed', ...summary(manifest) })
}

function summary(manifest) {

    const dispositions = {}
    for (const entry of manifest.entries) {
        dispositions[entry.disposition] = (dispositions[entry.disposition] ?? 0) + entry.surfaces.length
    }
    return Object.freeze({
        baselineCommit: manifest.baselineCommit,
        entryCount: manifest.entryCount,
        facetCount: manifest.facetCount,
        inventoryHash: manifest.inventoryHash,
        targetAdditionCount: manifest.targetAdditions.length,
        dispositions,
    })
}

function stableJson(value) {

    return JSON.stringify(value, null, 2)
}

function manifestJson(manifest) {

    const { entries, ...header } = manifest
    const lines = entries.map(entry => `    ${JSON.stringify(entry)}`)
    return `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}`
}

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

function assertEqual(actual, expected, label) {

    if (actual !== expected) {
        throw new Error(`${label} mismatch\nexpected: ${expected}\nactual: ${actual}`)
    }
}

const mode = process.argv[2] ?? '--renamed'
if (mode === '--write-baseline') {
    const manifest = buildBaselineManifest()
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, `${manifestJson(manifest)}\n`)
    process.stdout.write(`${stableJson({ mode: 'write-baseline', status: 'passed', ...summary(manifest) })}\n`)
} else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const result = mode === '--target'
        ? verifyTarget(manifest)
        : mode === '--renamed'
            ? verifyRenamed(manifest)
            : verifyManifest(manifest)
    process.stdout.write(`${stableJson(result)}\n`)
}
