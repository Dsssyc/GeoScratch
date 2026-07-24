import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import {
    baseline,
    classificationValues,
    createWebGpuManifest,
    createWgslManifest,
    targetFamilies,
    webGpuManifestPath,
    wgslManifestPath,
} from '../../scripts/scratch-webgpu-wgsl-parity-manifest.mjs'

const root = process.cwd()
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src', 'scratch')
const webGpuManifest = readJson(webGpuManifestPath)
const wgslManifest = readJson(wgslManifestPath)
const generatedWebGpuManifest = createWebGpuManifest()
const generatedWgslManifest = createWgslManifest()
const nativeCalls = scanNativeCalls(scratchRoot)
const publicExports = {
    scratch: scanExports(path.join(scratchRoot, 'index.ts')),
    package: scanExports(path.join(root, 'packages', 'geoscratch', 'src', 'index.ts')),
}
const forbiddenOldSurfaceInventory = scanOldSurfaceInventory()

const checks = Object.freeze({
    webGpuManifestReproducible:
        deepEqual(webGpuManifest, generatedWebGpuManifest),
    wgslManifestReproducible:
        deepEqual(wgslManifest, generatedWgslManifest),
    webGpuBaselineFrozen:
        webGpuManifest.baseline.sha256 === baseline.webgpu.sha256 &&
        webGpuManifest.baseline.gpuwebEditorCommit === baseline.gpuwebEditorCommit &&
        webGpuManifest.baseline.gpuwebTypesRepositoryCommit ===
            baseline.gpuwebTypesRepositoryCommit &&
        webGpuManifest.baseline.webgpuTypes.version === baseline.webgpuTypes.version,
    wgslBaselineFrozen:
        wgslManifest.baseline.sha256 === baseline.wgsl.sha256 &&
        wgslManifest.baseline.gpuwebEditorCommit === baseline.gpuwebEditorCommit,
    webGpuEntriesClassified: manifestEntriesAreClassified(webGpuManifest),
    wgslEntriesClassified: manifestEntriesAreClassified(wgslManifest),
    noDuplicateWebGpuEntries: entriesAreUnique(webGpuManifest),
    noDuplicateWgslEntries: entriesAreUnique(wgslManifest),
    noNewlyDiscoveredGap:
        webGpuManifest.summary.byClassification['newly-discovered-gap'] === 0 &&
        wgslManifest.summary.byClassification['newly-discovered-gap'] === 0,
    exactTargetFamilies:
        equalStrings(
            [
                ...webGpuManifest.targetFamilies,
                ...wgslManifest.targetFamilies,
            ],
            targetFamilies
        ),
    everyTargetFamilyHasEntries:
        targetFamilies.every(family => (
            Number(webGpuManifest.summary.byFamily[family] ?? 0) +
            Number(wgslManifest.summary.byFamily[family] ?? 0)
        ) > 0),
    completeTypesDeclarationSurface:
        webGpuManifest.summary.entryCount === 591,
    completeScopedWgslSurface:
        wgslManifest.summary.entryCount === 65,
    renderBundleAndDebugNativeCoverage:
        [
            'createRenderBundleEncoder',
            'executeBundles',
            'pushDebugGroup',
            'popDebugGroup',
            'insertDebugMarker',
        ].every(operation => nativeCalls.some(call => call.operation === operation)),
    renderBundleAndDebugPublicExports:
        [ publicExports.scratch, publicExports.package ].every(exports =>
            [
                'BundleDrawCommand',
                'BundleDrawCommandDescriptor',
                'DebugCommand',
                'DebugCommandDescriptor',
                'ExecuteRenderBundlesCommand',
                'ExecuteRenderBundlesCommandDescriptor',
                'RenderBundle',
                'RenderBundleDescriptor',
                'SubmittedRenderBundleFact',
            ].every(name => exports.some(entry => entry.name === name))
        ),
})

const failures = Object.entries(checks)
    .filter(([, passed ]) => !passed)
    .map(([ name ]) => name)
const result = {
    schemaVersion: 1,
    status: failures.length === 0 ? 'passed' : 'failed',
    checks,
    failures,
    baseline,
    manifests: {
        webgpu: {
            path: relative(webGpuManifestPath),
            summary: webGpuManifest.summary,
        },
        wgsl: {
            path: relative(wgslManifestPath),
            summary: wgslManifest.summary,
        },
    },
    currentImplementationInventory: {
        nativeCalls,
        publicExports,
        forbiddenOldSurfaceInventory,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

function manifestEntriesAreClassified(manifest) {

    const allowed = new Set(classificationValues)
    return manifest.entries.every(entry => (
        typeof entry.id === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.classification === 'object' &&
        entry.classification !== null &&
        allowed.has(entry.classification.status) &&
        typeof entry.classification.rationale === 'string' &&
        entry.classification.rationale.length > 0 &&
        (
            entry.classification.status !== 'known-target-gap' ||
            targetFamilies.includes(entry.classification.family)
        )
    ))
}

function entriesAreUnique(manifest) {

    return new Set(manifest.entries.map(entry => entry.id)).size ===
        manifest.entries.length
}

function scanNativeCalls(directory) {

    const selectedMethods = new Set([
        'beginComputePass',
        'beginRenderPass',
        'clearBuffer',
        'copyBufferToBuffer',
        'copyBufferToTexture',
        'copyExternalImageToTexture',
        'copyTextureToBuffer',
        'copyTextureToTexture',
        'createBindGroup',
        'createBindGroupLayout',
        'createBuffer',
        'createCommandEncoder',
        'createComputePipeline',
        'createComputePipelineAsync',
        'createPipelineLayout',
        'createQuerySet',
        'createRenderBundleEncoder',
        'createRenderPipeline',
        'createRenderPipelineAsync',
        'createSampler',
        'createShaderModule',
        'createTexture',
        'executeBundles',
        'finish',
        'getBindGroupLayout',
        'getCurrentTexture',
        'getMappedRange',
        'importExternalTexture',
        'insertDebugMarker',
        'mapAsync',
        'popDebugGroup',
        'popErrorScope',
        'pushDebugGroup',
        'pushErrorScope',
        'resolveQuerySet',
        'setImmediates',
        'submit',
        'unmap',
        'writeBuffer',
        'writeTexture',
    ])
    const calls = []
    for (const absolute of sourceFiles(directory)) {
        const source = fs.readFileSync(absolute, 'utf8')
        const sourceFile = ts.createSourceFile(
            absolute,
            source,
            ts.ScriptTarget.Latest,
            true,
            absolute.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
        )
        visit(sourceFile)

        function visit(node) {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                selectedMethods.has(node.expression.name.text)
            ) {
                const position = sourceFile.getLineAndCharacterOfPosition(
                    node.expression.name.getStart(sourceFile)
                )
                calls.push({
                    path: relative(absolute),
                    line: position.line + 1,
                    operation: node.expression.name.text,
                })
            }
            ts.forEachChild(node, visit)
        }
    }
    return calls.sort(compareInventory)
}

function scanExports(absolute) {

    const source = fs.readFileSync(absolute, 'utf8')
    const sourceFile = ts.createSourceFile(
        absolute,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const exports = []
    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)) continue
        const module = statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined
        if (statement.exportClause === undefined) {
            exports.push({ kind: 'star', module })
            continue
        }
        if (!ts.isNamedExports(statement.exportClause)) continue
        for (const element of statement.exportClause.elements) {
            exports.push({
                kind: statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
                name: element.name.text,
                ...(element.propertyName === undefined
                    ? {}
                    : { importedName: element.propertyName.text }),
                module,
            })
        }
    }
    return exports.sort((left, right) => (
        (left.name ?? '').localeCompare(right.name ?? '') ||
        (left.module ?? '').localeCompare(right.module ?? '') ||
        left.kind.localeCompare(right.kind)
    ))
}

function scanOldSurfaceInventory() {

    const programPath = path.join(scratchRoot, 'program.ts')
    const pipelineCompilationPath = path.join(scratchRoot, 'pipeline-compilation.ts')
    const program = parse(programPath)
    const pipelineCompilation = parse(pipelineCompilationPath)
    return {
        programDescriptorModules: findTypeMember(
            program,
            'ProgramDescriptor',
            'modules'
        ),
        pipelineCompilationShaderModuleCalls: countMethodCalls(
            pipelineCompilation,
            'createShaderModule'
        ),
    }
}

function findTypeMember(sourceFile, typeName, memberName) {

    let found = false
    visit(sourceFile)
    return found

    function visit(node) {
        if (
            (
                ts.isTypeAliasDeclaration(node) ||
                ts.isInterfaceDeclaration(node)
            ) &&
            node.name.text === typeName
        ) {
            const members = ts.isTypeAliasDeclaration(node) &&
                ts.isTypeLiteralNode(node.type)
                ? node.type.members
                : ts.isInterfaceDeclaration(node)
                    ? node.members
                    : []
            found = members.some(member => (
                member.name !== undefined &&
                member.name.getText(sourceFile) === memberName
            ))
        }
        ts.forEachChild(node, visit)
    }
}

function countMethodCalls(sourceFile, methodName) {

    let count = 0
    visit(sourceFile)
    return count

    function visit(node) {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === methodName
        ) count += 1
        ts.forEachChild(node, visit)
    }
}

function parse(absolute) {

    return ts.createSourceFile(
        absolute,
        fs.readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
}

function sourceFiles(directory) {

    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) files.push(...sourceFiles(absolute))
        else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) files.push(absolute)
    }
    return files
}

function readJson(absolute) {

    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
}

function deepEqual(left, right) {

    try {
        assert.deepStrictEqual(left, right)
        return true
    } catch {
        return false
    }
}

function equalStrings(left, right) {

    return left.length === right.length &&
        left.every((value, index) => value === right[index])
}

function compareInventory(left, right) {

    return (
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.operation.localeCompare(right.operation)
    )
}

function relative(absolute) {

    return path.relative(root, absolute).split(path.sep).join('/')
}
