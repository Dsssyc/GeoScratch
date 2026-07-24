import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
    canonicalManifestJson,
    compareWebGpuNormativeSources,
    createNormativeInventoryManifest,
    extractCapabilityDependencyEntries,
    extractProposalWatchlistEntries,
    extractWebGpuIdlEntries,
    extractWebGpuTypesEntries,
    extractWgslNormativeEntries,
    normativeBaseline,
    sha256,
} from './scratch-webgpu-wgsl-normative-inventory.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultManifestRoot = path.join(root, 'docs', 'review', 'manifests')

export const normativeArtifactNames = Object.freeze({
    webgpu: 'scratch-webgpu-normative-inventory-2026-07-14.json',
    wgsl: 'scratch-wgsl-normative-inventory-2026-07-16.json',
    dependencies:
        'scratch-gpu-capability-dependencies-2026-07-16.json',
    proposals:
        'gpuweb-proposal-watchlist-b33e6efb182d11156851271586563cc77575059c.json',
})

export const normativeArtifactPaths = Object.freeze(
    Object.fromEntries(
        Object.entries(normativeArtifactNames).map(([ key, name ]) => [
            key,
            path.join(defaultManifestRoot, name),
        ])
    )
)

export function createScratchNormativeArtifacts({
    sourceFacts,
    webGpuFiles,
    wgslFiles,
    typesFile,
    proposalFile,
}) {

    verifySourceGroup('WebGPU', sourceFacts.webgpu.files, webGpuFiles)
    verifySourceGroup('WGSL', sourceFacts.wgsl.files, wgslFiles)
    verifySourceGroup('types', sourceFacts.types.files, [ typesFile ])
    verifySourceGroup(
        'proposal',
        sourceFacts.proposals.files,
        [ proposalFile ]
    )

    const webGpuSource = orderedSource(
        sourceFacts.webgpu.files,
        webGpuFiles
    )
    const wgslSource = orderedSource(sourceFacts.wgsl.files, wgslFiles)
    const idl = extractWebGpuIdlEntries(webGpuSource)
    const types = extractWebGpuTypesEntries(typesFile.source)
    const comparison = compareWebGpuNormativeSources(
        idl.entries,
        types.entries
    )
    const wgsl = extractWgslNormativeEntries(wgslSource)
    const dependencies = extractCapabilityDependencyEntries({
        webGpuSource,
        wgslSource,
    })
    const proposals = extractProposalWatchlistEntries(proposalFile.source)

    const webgpuManifest = createNormativeInventoryManifest({
        id: 'scratch-webgpu-normative-inventory',
        domain: 'webgpu',
        source: {
            publicationUrl: sourceFacts.webgpu.publicationUrl,
            repositoryCommit: sourceFacts.gpuwebCommit,
            files: sourceFacts.webgpu.files,
            declarationCrossCheck: {
                package: '@webgpu/types',
                packageVersion:
                    sourceFacts.types.packageVersion ?? 'unknown',
                repositoryCommit: sourceFacts.gpuwebTypesCommit,
                files: sourceFacts.types.files,
            },
        },
        extraction: {
            entries: idl.entries,
            unresolved: [
                ...idl.unresolved.map(entry => ({
                    ...entry,
                    source: 'gpuweb-idl',
                })),
                ...types.unresolved.map(entry => ({
                    ...entry,
                    source: '@webgpu/types',
                })),
            ],
        },
        comparison,
    })
    const wgslManifest = createNormativeInventoryManifest({
        id: 'scratch-wgsl-normative-inventory',
        domain: 'wgsl',
        source: {
            publicationUrl: sourceFacts.wgsl.publicationUrl,
            repositoryCommit: sourceFacts.gpuwebCommit,
            files: sourceFacts.wgsl.files,
        },
        extraction: wgsl,
    })
    const dependencyManifest = createDependencyManifest({
        sourceFacts,
        dependencies,
    })
    const proposalManifest = createProposalManifest({
        sourceFacts,
        proposalEntries: proposals,
        webGpuSource,
        wgslEntries: wgsl.entries,
    })

    return {
        webgpu: webgpuManifest,
        wgsl: wgslManifest,
        dependencies: dependencyManifest,
        proposals: proposalManifest,
    }
}

export function readPinnedNormativeSources({
    gpuwebRoot,
    typesPath = path.join(
        root,
        'node_modules',
        '@webgpu',
        'types',
        'dist',
        'index.d.ts'
    ),
    sourceFacts = normativeBaseline,
}) {

    if (typeof gpuwebRoot !== 'string' || gpuwebRoot.length === 0) {
        throw new TypeError('A local --gpuweb-root is required')
    }
    return {
        sourceFacts,
        webGpuFiles: readFiles(gpuwebRoot, sourceFacts.webgpu.files),
        wgslFiles: readFiles(gpuwebRoot, sourceFacts.wgsl.files),
        typesFile: {
            path: sourceFacts.types.files[0].path,
            source: fs.readFileSync(typesPath, 'utf8'),
        },
        proposalFile: {
            path: sourceFacts.proposals.files[0].path,
            source: fs.readFileSync(
                path.join(
                    gpuwebRoot,
                    sourceFacts.proposals.files[0].path
                ),
                'utf8'
            ),
        },
    }
}

export function writeScratchNormativeArtifacts(
    artifacts,
    outputDirectory = defaultManifestRoot
) {

    fs.mkdirSync(outputDirectory, { recursive: true })
    const written = {}
    for (const [ key, manifest ] of Object.entries(artifacts)) {
        const target = path.join(outputDirectory, normativeArtifactNames[key])
        fs.writeFileSync(target, canonicalManifestJson(manifest))
        written[key] = target
    }
    return written
}

export function checkScratchNormativeArtifacts(
    artifacts,
    outputDirectory = defaultManifestRoot
) {

    const mismatches = []
    for (const [ key, manifest ] of Object.entries(artifacts)) {
        const target = path.join(outputDirectory, normativeArtifactNames[key])
        const expected = canonicalManifestJson(manifest)
        const actual = fs.existsSync(target)
            ? fs.readFileSync(target, 'utf8')
            : undefined
        if (actual !== expected) mismatches.push(target)
    }
    return mismatches
}

function createDependencyManifest({ sourceFacts, dependencies }) {

    const byKind = countBy(dependencies.entries, entry => entry.kind)
    const callerPreflightEntries = dependencies.entries.filter(
        entry => entry.callerPreflight
    )
    return {
        schemaVersion: 2,
        id: 'scratch-gpu-capability-dependencies',
        status:
            dependencies.unresolved.length === 0
                ? 'complete'
                : 'unresolved',
        source: {
            webgpu: {
                publicationUrl: sourceFacts.webgpu.publicationUrl,
                repositoryCommit: sourceFacts.gpuwebCommit,
                files: sourceFacts.webgpu.files,
            },
            wgsl: {
                publicationUrl: sourceFacts.wgsl.publicationUrl,
                repositoryCommit: sourceFacts.gpuwebCommit,
                files: sourceFacts.wgsl.files,
            },
        },
        entries: dependencies.entries,
        unresolved: dependencies.unresolved,
        summary: {
            entryCount: dependencies.entries.length,
            unresolvedCount: dependencies.unresolved.length,
            callerPreflightCount: callerPreflightEntries.length,
            callerCompanionPreflightCount:
                callerPreflightEntries.filter(
                    entry => entry.kind === 'caller-declared-companion'
                ).length,
            byKind,
        },
    }
}

function createProposalManifest({
    sourceFacts,
    proposalEntries,
    webGpuSource,
    wgslEntries,
}) {

    const formalNames = new Set(
        [
            ...[ ...webGpuSource.matchAll(
                /GPUFeatureName\/"([^"]+)"/g
            ) ].map(match => normalizeCapabilityName(match[1])),
            ...wgslEntries
                .filter(entry => new Set([
                    'enable-extension',
                    'language-extension',
                ]).has(entry.kind))
                .map(entry => normalizeCapabilityName(entry.name)),
        ]
    )
    const entries = proposalEntries.map((entry) => {
        const overlapsFormal = formalNames.has(
            normalizeCapabilityName(entry.id)
        )
        return {
            ...entry,
            normative: false,
            formalOverlap: overlapsFormal,
            statusConflict: overlapsFormal && entry.status !== 'merged',
        }
    })
    const byStatus = countBy(entries, entry => entry.status)
    const requiredStatuses = [
        'merged',
        'draft',
        'inactive',
        'obsolete',
    ]
    const missingStatuses = requiredStatuses.filter(
        status => (byStatus[status] ?? 0) === 0
    )
    const statusConflicts = entries
        .filter(entry => entry.statusConflict)
        .map(entry => entry.id)

    return {
        schemaVersion: 2,
        id: 'gpuweb-proposal-watchlist',
        normative: false,
        status:
            missingStatuses.length === 0
                ? 'complete'
                : 'unresolved',
        source: {
            repositoryCommit: sourceFacts.gpuwebCommit,
            files: sourceFacts.proposals.files,
        },
        boundary:
            'Proposal entries are non-normative observations and never contribute to Scratch coverage.',
        entries,
        unresolved:
            missingStatuses.length === 0
                ? []
                : [
                    {
                        reason: 'missing-proposal-status-section',
                        statuses: missingStatuses,
                    },
                ],
        conflicts: statusConflicts.map(id => ({
            proposal: id,
            resolution:
                'The formal WebGPU/WGSL specification remains authoritative.',
        })),
        summary: {
            entryCount: entries.length,
            unresolvedCount: missingStatuses.length,
            statusConflictCount: statusConflicts.length,
            byStatus,
        },
    }
}

function verifySourceGroup(name, expectedFiles, actualFiles) {

    if (!Array.isArray(actualFiles)) {
        throw new TypeError(`${name} sources must be an array`)
    }
    const actualByPath = new Map(
        actualFiles.map(file => [ file.path, file ])
    )
    const expectedPaths = expectedFiles.map(file => file.path)
    const actualPaths = [ ...actualByPath.keys() ]
    const unexpected = actualPaths.filter(
        value => !expectedPaths.includes(value)
    )
    const missing = expectedPaths.filter(
        value => !actualByPath.has(value)
    )
    if (unexpected.length > 0 || missing.length > 0) {
        throw new Error(
            `${name} source path mismatch; missing=${missing.join(',')} unexpected=${unexpected.join(',')}`
        )
    }
    for (const expected of expectedFiles) {
        const actual = actualByPath.get(expected.path)
        if (
            actual === undefined ||
            typeof actual.source !== 'string'
        ) {
            throw new TypeError(`${name} source is missing: ${expected.path}`)
        }
        const observed = sha256(actual.source)
        if (observed !== expected.sha256) {
            throw new Error(
                `${name} SHA-256 mismatch for ${expected.path}: expected ${expected.sha256}, observed ${observed}`
            )
        }
    }
}

function orderedSource(expectedFiles, actualFiles) {

    const actualByPath = new Map(
        actualFiles.map(file => [ file.path, file.source ])
    )
    return expectedFiles
        .map(file => (
            `\n<!-- normative-source:${file.path} -->\n` +
            actualByPath.get(file.path)
        ))
        .join('\n')
}

function readFiles(directory, facts) {

    return facts.map(file => ({
        path: file.path,
        source: fs.readFileSync(path.join(directory, file.path), 'utf8'),
    }))
}

function countBy(values, select) {

    const counts = {}
    for (const value of values) {
        const key = select(value)
        counts[key] = (counts[key] ?? 0) + 1
    }
    return Object.fromEntries(
        Object.entries(counts).sort(([ left ], [ right ]) =>
            left.localeCompare(right)
        )
    )
}

function normalizeCapabilityName(value) {

    return value.replaceAll('-', '_').toLowerCase()
}

function parseArguments(argv) {

    const values = {}
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--write' || argument === '--check') {
            values[argument.slice(2)] = true
            continue
        }
        if (
            new Set([
                '--gpuweb-root',
                '--types-file',
                '--output-dir',
            ]).has(argument)
        ) {
            const value = argv[index + 1]
            if (value === undefined) {
                throw new Error(`Missing value for ${argument}`)
            }
            values[argument.slice(2)] = value
            index += 1
            continue
        }
        throw new Error(`Unknown refresh argument: ${argument}`)
    }
    if (values.write === values.check) {
        throw new Error('Select exactly one of --write or --check')
    }
    if (typeof values['gpuweb-root'] !== 'string') {
        throw new Error('--gpuweb-root is required')
    }
    return values
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArguments(process.argv.slice(2))
        const inputs = readPinnedNormativeSources({
            gpuwebRoot: path.resolve(options['gpuweb-root']),
            ...(options['types-file'] === undefined
                ? {}
                : { typesPath: path.resolve(options['types-file']) }),
        })
        const artifacts = createScratchNormativeArtifacts(inputs)
        const outputDirectory = options['output-dir'] === undefined
            ? defaultManifestRoot
            : path.resolve(options['output-dir'])
        if (options.write) {
            const written = writeScratchNormativeArtifacts(
                artifacts,
                outputDirectory
            )
            process.stdout.write(`${JSON.stringify({
                status: 'written',
                files: written,
                summaries: Object.fromEntries(
                    Object.entries(artifacts).map(([ key, value ]) => [
                        key,
                        value.summary,
                    ])
                ),
            }, null, 2)}\n`)
        } else {
            const mismatches = checkScratchNormativeArtifacts(
                artifacts,
                outputDirectory
            )
            process.stdout.write(`${JSON.stringify({
                status:
                    mismatches.length === 0
                        ? 'current'
                        : 'drifted',
                mismatches,
            }, null, 2)}\n`)
            if (mismatches.length > 0) process.exitCode = 1
        }
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.stack : String(error)}\n`
        )
        process.exitCode = 1
    }
}
