import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import {
    canonicalManifestJson,
    normativeBaseline,
    sha256,
    validateNormativeInventory,
} from '../../scripts/scratch-webgpu-wgsl-normative-inventory.mjs'
import {
    normativeArtifactPaths,
    readPinnedNormativeSources,
} from '../../scripts/refresh-scratch-webgpu-wgsl-baseline.mjs'
import {
    currentCoverageManifestPath,
} from '../../scripts/scratch-webgpu-wgsl-current-coverage.mjs'
import {
    structuredProofKinds,
    validateCoverageManifestV4,
    verifyCoverageManifestProofs,
} from '../../scripts/scratch-webgpu-wgsl-structured-proof.mjs'

const root = process.cwd()
const webgpu = readJson(normativeArtifactPaths.webgpu)
const wgsl = readJson(normativeArtifactPaths.wgsl)
const dependencies = readJson(normativeArtifactPaths.dependencies)
const proposals = readJson(normativeArtifactPaths.proposals)
const current = readJson(currentCoverageManifestPath)
const structuredCoverageFailure = captureFailure(() => {

    validateCoverageManifestV4(current)
    verifyCoverageManifestProofs(current, { root })
})

const checks = {
    pinnedSourceFactsMatch:
        pinnedSourceFactsMatch(),
    partialOneShotRefreshIsRecorded:
        partialOneShotRefreshIsRecorded(),
    installedTypesDeclarationMatches:
        installedTypesDeclarationMatches(),
    normativeArtifactsAreCanonical:
        Object.values(normativeArtifactPaths).every(
            artifactIsCanonical
        ),
    normativeInventoriesAreComplete:
        normativeInventoriesAreComplete(),
    webGpuSpecAndTypesCrossCheckMatches:
        webGpuSpecAndTypesCrossCheckMatches(),
    wgslInventoryIsFineGrained:
        wgslInventoryIsFineGrained(),
    livingCoverageClosesNormativeUnion:
        livingCoverageClosesNormativeUnion(),
    dependencyInventoryIsComplete:
        dependencyInventoryIsComplete(),
    runtimePreflightMatchesCallerCompanions:
        runtimePreflightMatchesCallerCompanions(),
    proposalWatchlistIsNonNormative:
        proposalWatchlistIsNonNormative(),
    ordinaryAuditPathIsOffline:
        ordinaryAuditPathIsOffline(),
    structuredRegistryAndEntryBindingsAreClosed:
        structuredRegistryAndEntryBindingsAreClosed(),
}

const failures = Object.entries(checks)
    .filter(([, passed ]) => !passed)
    .map(([ name ]) => name)
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    checks,
    failures,
    sourceObservation: {
        observedOn: normativeBaseline.observedOn,
        gpuwebCommit: normativeBaseline.gpuwebCommit,
        gpuwebTypesCommit: normativeBaseline.gpuwebTypesCommit,
        refreshAttempt: normativeBaseline.refreshAttempt,
        webgpuPublication: normativeBaseline.webgpu.publication,
        wgslPublication: normativeBaseline.wgsl.publication,
    },
    inventories: {
        webgpu: webgpu.summary,
        wgsl: wgsl.summary,
        dependencies: dependencies.summary,
        proposals: proposals.summary,
        current: current.summary,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

function pinnedSourceFactsMatch() {

    return (
        webgpu.source.repositoryCommit ===
            normativeBaseline.gpuwebCommit &&
        webgpu.source.publicationUrl ===
            normativeBaseline.webgpu.publicationUrl &&
        deepEqual(
            webgpu.source.files,
            normativeBaseline.webgpu.files
        ) &&
        webgpu.source.declarationCrossCheck.package ===
            normativeBaseline.types.package &&
        webgpu.source.declarationCrossCheck.packageVersion ===
            normativeBaseline.types.packageVersion &&
        webgpu.source.declarationCrossCheck.repositoryCommit ===
            normativeBaseline.gpuwebTypesCommit &&
        deepEqual(
            webgpu.source.declarationCrossCheck.files,
            normativeBaseline.types.files
        ) &&
        wgsl.source.repositoryCommit ===
            normativeBaseline.gpuwebCommit &&
        wgsl.source.publicationUrl ===
            normativeBaseline.wgsl.publicationUrl &&
        deepEqual(wgsl.source.files, normativeBaseline.wgsl.files) &&
        dependencies.source.webgpu.repositoryCommit ===
            normativeBaseline.gpuwebCommit &&
        dependencies.source.wgsl.repositoryCommit ===
            normativeBaseline.gpuwebCommit &&
        proposals.source.repositoryCommit ===
            normativeBaseline.gpuwebCommit &&
        deepEqual(
            proposals.source.files,
            normativeBaseline.proposals.files
        )
    )
}

function partialOneShotRefreshIsRecorded() {

    return deepEqual(normativeBaseline.refreshAttempt, {
        status: 'partial',
        retryCount: 0,
        failedSource: 'W3C WebGPU publication page',
        reason:
            'The single bounded observation reached the WGSL publication and pinned GPUWeb editor, gpuweb/types, and proposal metadata, while the WebGPU publication request returned a fetch error. No network retry is permitted by the Goal; the pinned local publication hash remains authoritative.',
    })
}

function installedTypesDeclarationMatches() {

    const packageRoot = path.join(
        root,
        'node_modules',
        '@webgpu',
        'types'
    )
    const packageJson = readJson(path.join(packageRoot, 'package.json'))
    const declaration = fs.readFileSync(
        path.join(packageRoot, normativeBaseline.types.files[0].path),
        'utf8'
    )
    return (
        packageJson.version === normativeBaseline.types.packageVersion &&
        sha256(declaration) ===
            normativeBaseline.types.files[0].sha256
    )
}

function artifactIsCanonical(artifactPath) {

    const source = fs.readFileSync(artifactPath, 'utf8')
    return source === canonicalManifestJson(JSON.parse(source))
}

function normativeInventoriesAreComplete() {

    let validationPassed = true
    try {
        validateNormativeInventory(webgpu)
        validateNormativeInventory(wgsl)
    } catch {
        validationPassed = false
    }
    return (
        validationPassed &&
        webgpu.status === 'complete' &&
        wgsl.status === 'complete' &&
        dependencies.status === 'complete' &&
        proposals.status === 'complete' &&
        webgpu.unresolved.length === 0 &&
        wgsl.unresolved.length === 0 &&
        dependencies.unresolved.length === 0 &&
        proposals.unresolved.length === 0 &&
        webgpu.summary.entryCount === webgpu.entries.length &&
        wgsl.summary.entryCount === wgsl.entries.length &&
        dependencies.summary.entryCount === dependencies.entries.length &&
        proposals.summary.entryCount === proposals.entries.length
    )
}

function webGpuSpecAndTypesCrossCheckMatches() {

    const comparison = webgpu.crossSourceComparison
    return (
        comparison.status === 'matched' &&
        comparison.specOnlyIds.length === 0 &&
        comparison.typesOnlyIds.length === 0 &&
        comparison.matchedIds.length === 543 &&
        comparison.representationDifferences.length === 6 &&
        comparison.ignoredSpecIds.length === 39 &&
        comparison.ignoredTypesIds.length === 53
    )
}

function wgslInventoryIsFineGrained() {

    const ids = new Set(wgsl.entries.map(entry => entry.id))
    const ordinaryValue = wgsl.entries.find(
        entry => entry.id === 'built-in-value.position'
    )
    const subgroupValue = wgsl.entries.find(
        entry => entry.id === 'built-in-value.subgroup_id'
    )
    return (
        wgsl.entries.length === 662 &&
        wgsl.summary.enableExtensionCount === 6 &&
        wgsl.summary.languageExtensionCount === 12 &&
        wgsl.summary.byKind['built-in-function'] === 167 &&
        wgsl.summary.byKind['built-in-value'] === 20 &&
        wgsl.summary.byKind['grammar-production'] === 124 &&
        ids.has('built-in-function.textureSample') &&
        ids.has('built-in-function.atomicCompareExchangeWeak') &&
        !ids.has('built-in-function.builtin') &&
        ![ ...ids ].some(id => id.startsWith('shader-domain.')) &&
        deepEqual(
            ordinaryValue.requirements.deviceFeatures,
            []
        ) &&
        deepEqual(
            subgroupValue.requirements.deviceFeatures,
            [ 'subgroups' ]
        ) &&
        deepEqual(
            subgroupValue.requirements.languageFeatures,
            [ 'subgroup_id' ]
        )
    )
}

function livingCoverageClosesNormativeUnion() {

    const expected = [
        ...webgpu.entries.map(entry => ({
            id: entry.id,
            domain: 'webgpu',
            anchor: entry.sourceAnchor,
            manifest: relative(normativeArtifactPaths.webgpu),
        })),
        ...wgsl.entries.map(entry => ({
            id: entry.id,
            domain: 'wgsl',
            anchor: entry.sourceAnchor,
            manifest: relative(normativeArtifactPaths.wgsl),
        })),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const actual = current.entries.map(entry => ({
        id: entry.id,
        domain: entry.domain,
        anchor: entry.source.anchor,
        manifest: entry.source.normativeManifest,
    }))
    return (
        current.summary.entryCount === 1244 &&
        current.summary.unresolvedCount === 0 &&
        current.summary.byStatus.managed === 1242 &&
        current.summary.byStatus['not-applicable'] === 2 &&
        deepEqual(actual, expected)
    )
}

function dependencyInventoryIsComplete() {

    const expectedKinds = [
        'adapter-support-prerequisite',
        'caller-declared-companion',
        'enable-to-device-feature',
        'feature-alternatives',
        'format-specific-condition',
        'language-to-device-prerequisite',
        'language-to-enable-prerequisite',
        'limit-bound-capability',
        'native-feature-implication',
    ]
    const actualKinds = [
        ...new Set(dependencies.entries.map(entry => entry.kind)),
    ].sort()
    const callerPreflight = dependencies.entries.filter(
        entry => entry.callerPreflight
    )
    return (
        deepEqual(actualKinds, expectedKinds) &&
        dependencies.entries.length === 155 &&
        dependencies.summary.callerPreflightCount === 7 &&
        dependencies.summary.callerCompanionPreflightCount === 1 &&
        callerPreflight.every(entry =>
            entry.kind === 'enable-to-device-feature' ||
            entry.kind === 'caller-declared-companion'
        ) &&
        dependencies.entries
            .filter(entry =>
                entry.kind === 'native-feature-implication'
            )
            .every(entry => entry.callerPreflight === false) &&
        dependencies.entries
            .filter(entry =>
                entry.kind === 'format-specific-condition'
            )
            .some(entry =>
                entry.format === 'depth32float-stencil8' &&
                entry.requiredFeatures.includes(
                    'depth32float-stencil8'
                )
            )
    )
}

function runtimePreflightMatchesCallerCompanions() {

    const expected = dependencies.entries
        .filter(entry =>
            entry.kind === 'caller-declared-companion' &&
            entry.callerPreflight
        )
        .map(entry => ({
            feature: entry.feature,
            requiredFeature: entry.requiredFeature,
        }))
    const sourceFile = parseTypeScriptSource(
        'packages/geoscratch/src/scratch/feature-contract.ts'
    )
    const actual = staticFrozenObjectArray(
        sourceFile,
        'featureDependencies'
    )
    return deepEqual(actual, expected)
}

function proposalWatchlistIsNonNormative() {

    return (
        proposals.normative === false &&
        proposals.boundary ===
            'Proposal entries are non-normative observations and never contribute to Scratch coverage.' &&
        deepEqual(proposals.summary.byStatus, {
            draft: 11,
            inactive: 2,
            merged: 8,
            obsolete: 2,
        }) &&
        proposals.entries.every(entry => entry.normative === false) &&
        deepEqual(
            proposals.conflicts.map(entry => entry.proposal),
            [ 'subgroup-id' ]
        ) &&
        current.normativeManifests.proposals ===
            relative(normativeArtifactPaths.proposals)
    )
}

function ordinaryAuditPathIsOffline() {

    const auditedSources = [
        'scripts/scratch-webgpu-wgsl-normative-inventory.mjs',
        'scripts/refresh-scratch-webgpu-wgsl-baseline.mjs',
        'scripts/scratch-webgpu-wgsl-current-coverage.mjs',
    ].map(parseTypeScriptSource)
    return (
        auditedSources.every(sourceFile =>
            !importsNetworkModule(sourceFile) &&
            !callsIdentifier(sourceFile, 'fetch')
        ) &&
        captureFailure(() => readPinnedNormativeSources({}))
            ?.message === 'A local --gpuweb-root is required'
    )
}

function structuredRegistryAndEntryBindingsAreClosed() {

    const forbiddenCoverageRuleIds = new Set([
        'webgpu:descriptor-values',
        'wgsl:shader-semantic-domain',
    ])
    const forbiddenEvidenceIds = new Set([
        'webgpu-descriptor-values',
        'wgsl-shader-semantic-domain',
    ])
    const fallbackAdapter = current.entries.find(entry =>
        entry.id === 'GPUAdapterInfo.isFallbackAdapter'
    )
    return (
        structuredCoverageFailure === undefined &&
        current.schemaVersion === 4 &&
        deepEqual(
            current.proofSystem.selectorKinds,
            structuredProofKinds
        ) &&
        current.entries.every(entry =>
            !forbiddenCoverageRuleIds.has(entry.coverageRule)
        ) &&
        current.evidence.every(record =>
            !forbiddenEvidenceIds.has(record.id)
        ) &&
        fallbackAdapter?.current.status === 'managed' &&
        fallbackAdapter.current.classification ===
            'managed-first-class' &&
        Object.keys(current.normativeManifests).length === 4 &&
        Object.keys(current.frozenManifests).length === 2
    )
}

function parseTypeScriptSource(relativePath) {

    const source = readText(relativePath)
    const file = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    )
    if (file.parseDiagnostics.length > 0) {
        throw new Error(`${relativePath} has parse diagnostics`)
    }
    return file
}

function staticFrozenObjectArray(sourceFile, variableName) {

    const declarations = []
    visitTypeScript(sourceFile, node => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === variableName &&
            node.initializer !== undefined
        ) {
            declarations.push(node.initializer)
        }
    })
    if (declarations.length !== 1) return []
    const array = unwrapObjectFreeze(declarations[0])
    if (!ts.isArrayLiteralExpression(array)) return []
    const values = []
    for (const element of array.elements) {
        const object = unwrapObjectFreeze(element)
        if (!ts.isObjectLiteralExpression(object)) return []
        const value = {}
        for (const property of object.properties) {
            if (
                !ts.isPropertyAssignment(property) ||
                !ts.isStringLiteral(property.initializer)
            ) {
                return []
            }
            const name = staticPropertyName(property.name)
            if (name === undefined) return []
            value[name] = property.initializer.text
        }
        values.push(value)
    }
    return values
}

function unwrapObjectFreeze(expression) {

    if (
        ts.isCallExpression(expression) &&
        expression.arguments.length === 1 &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === 'Object' &&
        expression.expression.name.text === 'freeze'
    ) {
        return expression.arguments[0]
    }
    return expression
}

function staticPropertyName(name) {

    if (
        ts.isIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNoSubstitutionTemplateLiteral(name)
    ) {
        return name.text
    }
    return undefined
}

function importsNetworkModule(sourceFile) {

    return sourceFile.statements.some(statement =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        (
            statement.moduleSpecifier.text === 'node:http' ||
            statement.moduleSpecifier.text === 'node:https'
        )
    )
}

function callsIdentifier(sourceFile, name) {

    let found = false
    visitTypeScript(sourceFile, node => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name
        ) {
            found = true
        }
    })
    return found
}

function visitTypeScript(node, callback) {

    callback(node)
    ts.forEachChild(node, child =>
        visitTypeScript(child, callback)
    )
}

function captureFailure(operation) {

    try {
        operation()
        return undefined
    } catch (error) {
        return error
    }
}

function readJson(file) {

    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readText(relativePath) {

    return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function deepEqual(left, right) {

    return JSON.stringify(left) === JSON.stringify(right)
}

function relative(absolute) {

    return path.relative(root, absolute).split(path.sep).join('/')
}
