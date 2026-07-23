import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = process.cwd()
const scratchRoot = path.join(root, 'packages', 'geoscratch', 'src')
const examplePath = 'examples/bufferMapping/main.ts'
const expectedNativeMappingCalls = Object.freeze({
    'packages/geoscratch/src/gpu/buffer/mapBuffer.js': Object.freeze({
        getMappedRange: 1,
        mapAsync: 1,
        unmap: 1,
    }),
    'packages/geoscratch/src/scratch/buffer-mapping.ts': Object.freeze({
        getMappedRange: 2,
        mapAsync: 1,
        unmap: 1,
    }),
    'packages/geoscratch/src/scratch/readback-mapping.ts': Object.freeze({
        mapAsync: 1,
    }),
    'packages/geoscratch/src/scratch/readback-staging.ts': Object.freeze({
        unmap: 2,
    }),
    'packages/geoscratch/src/scratch/readback.ts': Object.freeze({
        getMappedRange: 1,
    }),
})

const nativeMappingCalls = scanNativeMappingCalls(scratchRoot)
const nativeInventory = summarizeNativeCalls(nativeMappingCalls)
const example = read(examplePath)
const buffer = read('packages/geoscratch/src/scratch/buffer.ts')
const mapping = read('packages/geoscratch/src/scratch/buffer-mapping.ts')
const authority = read('packages/geoscratch/src/scratch/buffer-mapping-authority.ts')
const command = read('packages/geoscratch/src/scratch/command.ts')
const readback = read('packages/geoscratch/src/scratch/readback.ts')
const submission = read('packages/geoscratch/src/scratch/submission.ts')
const runtime = read('packages/geoscratch/src/scratch/runtime.ts')
const diagnostics = read('packages/geoscratch/src/scratch/runtime-diagnostics.ts')
const scratchIndex = read('packages/geoscratch/src/scratch/index.ts')
const packageIndex = read('packages/geoscratch/src/index.ts')

const checks = Object.freeze({
    nativeMappingInventory:
        JSON.stringify(nativeInventory) === JSON.stringify(expectedNativeMappingCalls),
    ordinaryDescriptorCleanCut: hasAll(buffer, [
        "Omit<GPUBufferDescriptor, 'mappedAtCreation'>",
        "hasOwnProperty.call(descriptor, 'mappedAtCreation')",
        'SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY',
    ]),
    dedicatedMappedCreation: hasAll(mapping, [
        'createMappedBufferResource(',
        'mappedAtCreation: true',
        'getMappedRange(0, buffer.size)',
    ]) && hasAll(runtime, [
        'async createMappedBuffer(',
        'createMappedBufferResource(this, descriptor)',
    ]),
    closedAuthority: hasAll(authority, [
        'const authorityByBuffer = new WeakMap',
        'claimBufferMappingAuthority(',
        'activateBufferMappingAuthority(',
        'releaseBufferMappingAuthority(',
        'assertBufferAvailableForGpuUse(',
    ]),
    directGpuUsePreflight: hasAll(command, [
        'assertCommandBufferGpuUseAvailable(this)',
        'assertCommandBufferGpuUseAvailable(command)',
        "case 'draw':",
        "case 'dispatch':",
        "case 'upload':",
        "case 'clear':",
        "case 'copy':",
        "case 'readback':",
        "case 'resolve-query-set':",
        'validateBoundResourceAccess(',
        'validateDrawFixedFunctionReads(',
        'validateDispatchFixedFunctionReads(',
    ]),
    submissionPreflightBeforeEffects:
        ordered(submission, [
            'const resolvedPlan = resolveSubmissionBeforeEncoding(this)',
            'assertResolvedSubmissionBufferGpuUseAvailable(resolvedPlan.steps)',
            'snapshotResolvedCommandImmediates(',
            'prepareSubmissionSurfaceAttachments(resolvedPlan.steps)',
            'createSubmissionNativeIssuePlan(',
        ]),
    readbackPreflightBeforeStaging:
        ordered(readback, [
            'async _materializeBytes()',
            'this._assertBeforeMaterialization()',
            'await allocateReadbackStaging(',
            'device.createCommandEncoder(',
        ]) && hasAll(readback, [
            '_assertBeforeMaterialization()',
            'assertBufferAvailableForGpuUse(this.source.buffer, this.subject)',
        ]),
    boundedDiagnostics: hasAll(diagnostics, [
        'bufferMappings: readonly ScratchRuntimeBufferMappingFact[]',
        'currentMappings: number',
        'peakMappings: number',
        'currentSelectedBytes: number',
        'peakSelectedBytes: number',
        'this.#bufferMappingFacts.delete(id)',
        'operationCapacity',
        'incidentCapacity',
        'evidenceByteCapacity',
    ]) && !mapping.includes('new Uint8Array(view)'),
    publicExports: [ scratchIndex, packageIndex ].every(source => hasAll(source, [
        'MappedBufferLease',
        'BufferMappingDescriptor',
        'BufferMappingMode',
        'MappedBufferCreation',
        'MappedBufferResourceDescriptor',
        'MappedBufferLeaseState',
    ])),
    publicOnlyExample: hasAll(example, [
        "from 'geoscratch'",
        'runtime.createMappedBuffer(',
        'runtime.createCopyCommand(',
        'runtime.mapBuffer(',
        'writeView.byteLength === 0',
        'readView.byteLength === 0',
    ]) && !hasAny(example, [
        'gpuBuffer',
        '.mapAsync(',
        '.getMappedRange(',
        '.unmap(',
        '../packages/',
        '/src/scratch/',
    ]),
    noRawMappingInExamples:
        scanNativeMappingCalls(path.join(root, 'examples')).length === 0,
})

const failures = Object.entries(checks)
    .filter(([, passed ]) => !passed)
    .map(([ name ]) => name)
const result = {
    schemaVersion: 1,
    commit: currentCommit(),
    checks,
    nativeMappingCalls,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

function scanNativeMappingCalls(directory) {

    const calls = []
    for (const absolute of sourceFiles(directory)) {
        const relative = path.relative(root, absolute).split(path.sep).join('/')
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
                [ 'mapAsync', 'getMappedRange', 'unmap' ].includes(node.expression.name.text)
            ) {
                const position = sourceFile.getLineAndCharacterOfPosition(
                    node.expression.name.getStart(sourceFile)
                )
                calls.push({
                    path: relative,
                    line: position.line + 1,
                    operation: node.expression.name.text,
                })
            }
            ts.forEachChild(node, visit)
        }
    }
    return calls.sort((left, right) => (
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.operation.localeCompare(right.operation)
    ))
}

function sourceFiles(directory) {

    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (
            entry.isDirectory() &&
            entry.name !== 'node_modules' &&
            entry.name !== 'dist'
        ) files.push(...sourceFiles(absolute))
        else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) files.push(absolute)
    }
    return files
}

function summarizeNativeCalls(calls) {

    const summary = {}
    for (const call of calls) {
        summary[call.path] ??= {}
        summary[call.path][call.operation] = (summary[call.path][call.operation] ?? 0) + 1
    }
    return Object.fromEntries(Object.entries(summary)
        .sort(([ left ], [ right ]) => left.localeCompare(right))
        .map(([ sourcePath, operations ]) => [
            sourcePath,
            Object.fromEntries(Object.entries(operations)
                .sort(([ left ], [ right ]) => left.localeCompare(right))),
        ]))
}

function read(relative) {

    return fs.readFileSync(path.join(root, relative), 'utf8')
}

function hasAll(source, values) {

    return values.every(value => source.includes(value))
}

function hasAny(source, values) {

    return values.some(value => source.includes(value))
}

function ordered(source, values) {

    let cursor = -1
    for (const value of values) {
        cursor = source.indexOf(value, cursor + 1)
        if (cursor < 0) return false
    }
    return true
}

function currentCommit() {

    return execFileSync('git', [ 'rev-parse', 'HEAD' ], {
        cwd: root,
        encoding: 'utf8',
    }).trim()
}
