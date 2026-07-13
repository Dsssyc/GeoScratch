import fs from 'node:fs'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const goalBaseline = 'a69c79a2f6789330f108aff5031a6d5e11fd59c4'
const sourcePaths = Object.freeze({
    submission: 'packages/geoscratch/src/scratch/submission.ts',
    command: 'packages/geoscratch/src/scratch/command.ts',
    binding: 'packages/geoscratch/src/scratch/binding.ts',
    readback: 'packages/geoscratch/src/scratch/readback.ts',
    runtimeDiagnostics: 'packages/geoscratch/src/scratch/runtime-diagnostics.ts',
    runtime: 'packages/geoscratch/src/scratch/runtime.ts',
    resource: 'packages/geoscratch/src/scratch/resource.ts',
    querySet: 'packages/geoscratch/src/scratch/query-set.ts',
    gpuOperation: 'packages/geoscratch/src/scratch/gpu-operation.ts',
    fakeGpu: 'tests/scratch-test-utils.js',
    publicIndex: 'packages/geoscratch/src/index.ts',
    scratchIndex: 'packages/geoscratch/src/scratch/index.ts',
})
const supportPaths = Object.freeze({
    nativeObservation: 'packages/geoscratch/src/scratch/submission-native-observation.ts',
})
const legacyExamples = Object.freeze([
    'examples/m_demLayer/main.js',
    'examples/m_flowLayer/main.js',
    'examples/x_helloGAW/main.js',
])
const fakeGpuBaselineMarkers = Object.freeze([
    'errorScopes: []',
    'nativeTimeline: []',
    'queueTimeline: []',
    'queueSubmissions: []',
    'failNext(method, filter, error)',
    'throwNext(method, error)',
    'settlePop(index)',
    'rejectPop(index, error',
    'emitUncaptured(error)',
    'loseDevice(info',
    'setNextCompilationInfo(info)',
    'rejectNextPipeline(kind, error',
    'rejectNextMap(error',
    'resolveQueueCompletion(index, value)',
    'rejectQueueCompletion(index, error',
])

assertAncestor(goalBaseline)

const baseline = loadSourcesAt(goalBaseline, sourcePaths)
const current = loadCurrentSources(sourcePaths)
const support = loadCurrentSources(supportPaths)

const unchangedSourceChecks = [
    unchangedSource('command.ts native command model', baseline.command, current.command),
    unchangedSource('binding.ts lazy binding model', baseline.binding, current.binding),
    ...legacyExamples.map(path => unchangedSource(
        path,
        gitShow(goalBaseline, path),
        fs.readFileSync(path, 'utf8')
    )),
]

const preservedBehaviorChecks = [
    preserved(
        'queue-order',
        'preflight precedes the first native side effect',
        appearsInOrder(baseline.submission, [
            'const resolvedPlan = resolveSubmissionBeforeEncoding(this)',
            'applySubmissionValidationDisposition(this, resolvedPlan.report)',
            'validateUploadCommandQueueAction(step.command, this.runtime.queue)',
            'readbackClaims.set(stepIndex, claimReadbackCommand(',
            'const trackSegmentResourceWrite = (resource: Resource)',
        ]),
        appearsInOrder(current.submission, [
            'const resolvedPlan = resolveSubmissionBeforeEncoding(this)',
            'applySubmissionValidationDisposition(this, resolvedPlan.report)',
            'validateUploadCommandQueueAction(step.command, this.runtime.queue)',
            'readbackClaims.set(stepIndex, claimReadbackCommand(',
            'nativeObservation = beginSubmissionNativeObservation({',
        ])
    ),
    preserved(
        'queue-order',
        'SubmissionBuilder steps remain the physical queue timeline',
        hasAll(baseline.submission, [
            'const queueTimeline: PreparedQueueAction[] = []',
            'for (const action of queueTimeline)',
            'this.runtime.queue.submit([ action.commandBuffer ])',
            'writeUploadCommandQueueAction(action.command, this.runtime.queue)',
            'applyPreparedQueueEffects(action.effects)',
        ]),
        hasAll(current.submission, [
            'const queueTimeline: PreparedQueueAction[] = []',
            'for (const [ actionIndex, action ] of queueTimeline.entries())',
            'this.runtime.queue.submit([ action.commandBuffer ])',
            'writeUploadCommandQueueAction(action.command, this.runtime.queue)',
            'applyPreparedQueueEffects(action.effects)',
        ])
    ),
    preserved(
        'segmentation',
        'queue actions split command-encoder segments without reordering',
        hasAll(baseline.submission, [
            'const finishEncoderSegment = () =>',
            "if (step.kind === 'upload')",
            'finishEncoderSegment()',
            'queueTimeline.push(createPreparedUploadQueueAction',
        ]),
        hasAll(current.submission, [
            'const finishEncoderSegment = () =>',
            "if (step.kind === 'upload')",
            'finishEncoderSegment()',
            'queueTimeline.push(createPreparedUploadQueueAction',
        ])
    ),
    preserved(
        'partial-replay',
        'already submitted readbacks and effects remain distinct from unreplayed work',
        hasAll(baseline.submission, [
            'submittedReadbacks.add(pending)',
            'applyPreparedQueueEffects(action.effects)',
            'releaseFailedSubmissionReadbacks(this.runtime.queue, pendingReadbacks, submittedReadbacks)',
        ]),
        hasAll(current.submission, [
            'submittedReadbacks.add(pending)',
            'applyPreparedQueueEffects(action.effects)',
            'releaseFailedSubmissionReadbacks(this.runtime.queue, pendingReadbacks, submittedReadbacks)',
        ])
    ),
    preserved(
        'synchronous-exceptions',
        'submit remains synchronous and releases unsubmitted readback claims',
        synchronousSubmit(baseline.submission) && hasAll(baseline.submission, [
            'releaseUnsubmittedReadbackClaims(readbackClaims.values())',
            'throw cause',
        ]),
        synchronousSubmit(current.submission) && hasAll(current.submission, [
            'releaseUnsubmittedReadbackClaims(readbackClaims.values())',
            'nativeObservation.finish()',
            'throw cause',
        ])
    ),
    preserved(
        'readiness',
        'readiness resolution and validation disposition remain pre-encoding',
        hasAll(baseline.submission, [
            'resolveSubmissionBeforeEncoding(this)',
            'applySubmissionValidationDisposition(this, resolvedPlan.report)',
            'resolveComputeReadiness(',
            'resolveRenderReadiness(',
        ]),
        hasAll(current.submission, [
            'resolveSubmissionBeforeEncoding(this)',
            'applySubmissionValidationDisposition(this, resolvedPlan.report)',
            'resolveComputeReadiness(',
            'resolveRenderReadiness(',
        ])
    ),
    preserved(
        'epochs',
        'logical writes use snapshot, restore, and per-action commit',
        hasAll(baseline.submission, [
            'captureResourceContentSnapshot(',
            'restorePreparedContentState(resourceSnapshots, querySlotSnapshots)',
            'applyPreparedQueueEffects(action.effects)',
            'completeResourceAccesses(resourceAccesses,',
        ]),
        hasAll(current.submission, [
            'captureResourceContentSnapshot(',
            'restorePreparedContentState(resourceSnapshots, querySlotSnapshots)',
            'applyPreparedQueueEffects(action.effects)',
            'completeResourceAccesses(resourceAccesses,',
        ])
    ),
    preserved(
        'queries',
        'timestamp, occlusion, and resolve epoch behavior remains explicit',
        hasAll(baseline.submission, [
            'validateResolveReadiness(',
            'step.passSpec.advanceTimestampWriteEpochs()',
            'activeOcclusionQueryCommand?.querySet._advanceSlotContentEpoch(',
            'markSimulatedQuerySlotReady(',
        ]),
        hasAll(current.submission, [
            'validateResolveReadiness(',
            'step.passSpec.advanceTimestampWriteEpochs()',
            'advanceQuerySlotContentEpoch(',
            'markSimulatedQuerySlotReady(',
        ])
    ),
    preserved(
        'readback',
        'ordered claims, immutable links, producer lookup, and result registration remain',
        hasAll(baseline.submission, [
            'claimReadbackCommand(',
            'freezeSubmittedReadbackLinks(',
            'findReadbackProducerEpoch(',
            'registerReadbackCommandResult(',
        ]),
        hasAll(current.submission, [
            'claimReadbackCommand(',
            'freezeSubmittedReadbackLinks(',
            'findReadbackProducerEpoch(',
            'registerReadbackCommandResult(',
        ])
    ),
    preserved(
        'readback',
        'mapping, host-copy, retention, and layout-view public behavior remains',
        hasAll(baseline.readback, [
            'toBytes(): Promise<Uint8Array>',
            'toArray<T extends ArrayBufferView>',
            'toLayoutView(): Promise<LayoutReadbackView>',
            'completeReadbackMapping(mappingTransaction)',
            "this.retain === 'until-dispose'",
        ]),
        hasAll(current.readback, [
            'toBytes(): Promise<Uint8Array>',
            'toArray<T extends ArrayBufferView>',
            'toLayoutView(): Promise<LayoutReadbackView>',
            'completeReadbackMapping(mappingTransaction)',
            "this.retain === 'until-dispose'",
        ])
    ),
    preserved(
        'pipeline',
        'pipeline ownership, compatibility, and encode calls are source-identical',
        sha256(baseline.command) === sha256(current.command) && hasAll(baseline.command, [
            'pipeline.assertRuntime(runtime)',
            'passEncoder.setPipeline(this.pipeline.gpuPipeline)',
        ]),
        sha256(baseline.command) === sha256(current.command) && hasAll(current.submission, [
            'validatePipelineTargets(command, passSpec)',
            'validatePipelineDepthStencil(command, passSpec)',
        ])
    ),
    preserved(
        'external-upload',
        'ExternalImageUploadCommand retains its native queue call and capture-time payload',
        hasAll(baseline.command, [
            'copyExternalImageToTexture(source, destination, copySize)',
            'mutable.source = normalizeExternalImageUploadSource(',
            "mutable.uploadKind = 'external-image'",
            'lockExternalImageUploadCommandContract(this)',
        ]),
        sha256(baseline.command) === sha256(current.command) && hasAll(current.submission, [
            "case 'external-image-upload':",
            'writeUploadCommandQueueAction(action.command, this.runtime.queue)',
        ])
    ),
    preserved(
        'native-copy',
        'all four WebGPU-native buffer/texture copy directions remain source-identical',
        hasAll(baseline.command, [
            'copyBufferToBuffer(',
            'copyTextureToTexture(',
            'copyBufferToTexture(',
            'copyTextureToBuffer(',
        ]),
        sha256(baseline.command) === sha256(current.command)
    ),
    preserved(
        'binding',
        'lazy bind-group creation and allocation-version invalidation remain source-identical',
        hasAll(baseline.binding, [
            'getBindGroup(): GPUBindGroup',
            'this.runtime.device.createBindGroup(descriptor)',
            'this.boundAllocationVersions.get(binding.resource.id)',
        ]),
        sha256(baseline.binding) === sha256(current.binding)
    ),
    preserved(
        'queue-completion',
        'effectful work still registers queue completion while effect-free work resolves locally',
        hasAll(baseline.submission, [
            'queueTimeline.length === 0',
            'Promise.resolve()',
            'createDonePromise(this.runtime.queue)',
            'queue.onSubmittedWorkDone()',
        ]),
        hasAll(current.submission, [
            'queueTimeline.length === 0',
            'Promise.resolve()',
            'createDonePromise(this.runtime.queue)',
            'queue.onSubmittedWorkDone()',
        ])
    ),
    preserved(
        'fake-gpu',
        'Goal-start fake GPU controls and call inventories remain available',
        hasAll(baseline.fakeGpu, fakeGpuBaselineMarkers),
        hasAll(current.fakeGpu, fakeGpuBaselineMarkers)
    ),
    preserved(
        'public-api',
        'all Goal-start package and scratch entrypoint names remain exported',
        true,
        missingExports(baseline.publicIndex, current.publicIndex).length === 0 &&
            missingExports(baseline.scratchIndex, current.scratchIndex).length === 0
    ),
]

const intentionalReplacements = [
    replacement(
        'schema-v4-clean-cut',
        hasAll(baseline.gpuOperation, [ 'version: 3' ]) &&
            !baseline.gpuOperation.includes('version: 5'),
        hasAll(current.gpuOperation, [ 'version: 5' ]) &&
            !current.gpuOperation.includes('version: 3')
    ),
    replacement(
        'submission-target-and-native-operation',
        !baseline.gpuOperation.includes("kind: 'submission'"),
        hasAll(current.gpuOperation, [
            "kind: 'submission'",
            "| 'submission-native-observation'",
            "| 'submission-failure'",
        ])
    ),
    replacement(
        'mutable-submitted-work-construction',
        hasAll(baseline.submission, [
            'export class SubmittedWork',
            'constructor(runtime: ScratchRuntime, options:',
            'runtime: ScratchRuntime',
        ]),
        hasAll(current.submission, [
            'private constructor(',
            "SCRATCH_SUBMITTED_WORK_CONSTRUCTOR_PRIVATE",
            'Object.preventExtensions(this)',
            'Object.freeze(SubmittedWork.prototype)',
        ])
    ),
    replacement(
        'queue-only-done',
        hasAll(baseline.submission, [
            'return Promise.resolve(nativeDone).catch(',
            "SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED",
        ]) && !baseline.submission.includes('nativeSettlement: Promise<SubmissionNativeSettlement>'),
        hasAll(current.submission, [
            'const done = Promise.all([',
            'nativeSettlement,',
            'queueCompletion,',
            'lifecycle,',
            'selectSubmissionDoneFailure(',
            'compareSubmissionNativeStages(',
        ])
    ),
    replacement(
        'unobserved-submission-native-timeline',
        !baseline.submission.includes('beginSubmissionNativeObservation'),
        hasAll(current.submission, [
            'beginSubmissionNativeObservation({',
            'nativeObservation.issue(',
            'nativeObservation.finish()',
            'nativeOutcome: Promise<ScratchSubmissionNativeOutcome>',
        ])
    ),
    replacement(
        'ready-only-resource-content',
        baseline.resource.includes("'empty' | 'ready' | 'disposed'"),
        current.resource.includes("'empty' | 'ready' | 'indeterminate' | 'disposed'") &&
            current.submission.includes('markSubmissionPotentialWritesIndeterminate(')
    ),
    replacement(
        'ready-only-query-content',
        baseline.querySet.includes("'empty' | 'ready'"),
        current.querySet.includes("'empty' | 'ready' | 'indeterminate'") &&
            current.submission.includes("kind: 'query-slot-content'")
    ),
    replacement(
        'raw-direct-readback-copy-issue',
        hasAll(baseline.readback, [
            'const encoder = device.createCommandEncoder(encoderDescriptor)',
            'queue.submit([ encoder.finish() ])',
        ]),
        hasAll(current.readback, [
            'beginReadbackNativeObservation({',
            "nativeObservation.issue('command-encode'",
            "nativeObservation.issue('queue-submit'",
            'assertDirectReadbackNativeSettlement(',
        ])
    ),
    replacement(
        'ordered-readback-mapping-only-trust',
        !baseline.readback.includes('assertOrderedReadbackNativeOutcome'),
        hasAll(current.readback, [
            'assertOrderedReadbackNativeOutcome(this, await after.nativeOutcome)',
            'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED',
        ])
    ),
    replacement(
        'no-submission-observation-policy',
        !baseline.runtimeDiagnostics.includes('submissionScopes'),
        hasAll(current.runtimeDiagnostics, [
            'submissionScopes?: ScratchSubmissionScopeMode',
            'maxPendingNativeObservations',
            'currentPendingNativeObservations',
            'currentEffectfulSubmittedWork',
            "if (value === undefined) return 'summary'",
        ])
    ),
    replacement(
        'no-finite-native-detail-capture',
        !baseline.runtimeDiagnostics.includes('nativeSubmissionDetail'),
        hasAll(current.runtimeDiagnostics, [
            "nativeSubmissionDetail?: 'step'",
            'nativeSubmissionDetailOption(owner, options.nativeSubmissionDetail)',
        ]) && support.nativeObservation.includes("mode: 'detailed'")
    ),
    replacement(
        'late-failure-without-content-guard',
        !baseline.submission.includes('observeSubmissionPotentialWriteFailures'),
        hasAll(current.submission, [
            'observeSubmissionPotentialWriteFailures(',
            'observeSubmissionPotentialWriteNativeFailures(',
            'write.resource.contentEpoch !== write.contentEpoch',
            "setResourceContentState(write.resource, 'indeterminate', write.contentEpoch)",
            'querySlotContentEpoch(write.querySet, write.index) !== write.contentEpoch',
        ])
    ),
    replacement(
        'direct-readback-ready-state-only',
        !baseline.readback.includes('SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE'),
        hasAll(current.readback, [
            "operation.source.state === 'indeterminate'",
            'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE',
            'explicit later producer before direct readback',
        ])
    ),
    replacement(
        'scope-limited-submission-lifecycle',
        !baseline.submission.includes('observeSubmissionLifecycleUntilQueueCompletion'),
        hasAll(current.submission, [
            'observeSubmissionLifecycleUntilQueueCompletion(',
            'completeSubmissionLifecycleOutcome(',
            "attribution: 'temporal-correlation'",
            "failureStage: 'lifecycle-recheck'",
        ]) && hasAll(support.nativeObservation, [
            'nativeObservationAttribution(',
            "return 'temporal-correlation'",
        ])
    ),
]

const baselineDiagnosticCodes = diagnosticCodes(Object.values(baseline).join('\n'))
const currentDiagnosticCodes = diagnosticCodes([
    ...Object.values(current),
    ...Object.values(support),
].join('\n'))
const missingDiagnosticCodes = baselineDiagnosticCodes.filter(
    code => !currentDiagnosticCodes.includes(code)
)
const missingPublicExports = Object.freeze({
    package: missingExports(baseline.publicIndex, current.publicIndex),
    scratch: missingExports(baseline.scratchIndex, current.scratchIndex),
})

assertParity(
    unchangedSourceChecks.every(check => check.unchanged),
    `unchanged source checks failed: ${failedNames(unchangedSourceChecks, 'unchanged')}`
)
assertParity(
    preservedBehaviorChecks.every(check => check.preserved),
    `preserved behavior checks failed: ${failedNames(preservedBehaviorChecks, 'preserved')}`
)
assertParity(
    intentionalReplacements.every(check => check.replaced),
    `intentional replacement checks failed: ${failedNames(intentionalReplacements, 'replaced')}`
)
assertParity(
    missingDiagnosticCodes.length === 0,
    `Goal-start diagnostics are missing: ${missingDiagnosticCodes.join(', ')}`
)
assertParity(
    missingPublicExports.package.length === 0 && missingPublicExports.scratch.length === 0,
    `Goal-start exports are missing: ${JSON.stringify(missingPublicExports)}`
)

const result = {
    schemaVersion: 1,
    baseline: goalBaseline,
    target: currentCommit(),
    sourceHashes: {
        baseline: hashSources(sourcePaths, baseline),
        current: {
            ...hashSources(sourcePaths, current),
            ...hashSources(supportPaths, support),
        },
    },
    unchangedSourceChecks,
    preservedBehaviorChecks,
    intentionalReplacements,
    diagnostics: {
        baselineCount: baselineDiagnosticCodes.length,
        currentCount: currentDiagnosticCodes.length,
        missing: missingDiagnosticCodes,
    },
    publicExports: {
        baselinePackageCount: exportedNames(baseline.publicIndex).length,
        baselineScratchCount: exportedNames(baseline.scratchIndex).length,
        missing: missingPublicExports,
    },
    verification: {
        status: 'passed',
        unchangedSourceCount: unchangedSourceChecks.length,
        preservedBehaviorCount: preservedBehaviorChecks.length,
        intentionalReplacementCount: intentionalReplacements.length,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function loadSourcesAt(commit, paths) {

    return Object.fromEntries(Object.entries(paths).map(([ name, path ]) => [
        name,
        gitShow(commit, path),
    ]))
}

function loadCurrentSources(paths) {

    return Object.fromEntries(Object.entries(paths).map(([ name, path ]) => [
        name,
        fs.readFileSync(path, 'utf8'),
    ]))
}

function gitShow(commit, path) {

    return execFileSync('git', [ 'show', `${commit}:${path}` ], { encoding: 'utf8' })
}

function assertAncestor(commit) {

    try {
        execFileSync('git', [ 'merge-base', '--is-ancestor', commit, 'HEAD' ])
    } catch {
        throw new Error(`Goal baseline ${commit} is not an ancestor of HEAD.`)
    }
}

function currentCommit() {

    return execFileSync('git', [ 'rev-parse', 'HEAD' ], { encoding: 'utf8' }).trim()
}

function unchangedSource(name, baselineSource, currentSource) {

    const baselineHash = sha256(baselineSource)
    const currentHash = sha256(currentSource)
    return Object.freeze({
        name,
        baselineHash,
        currentHash,
        unchanged: baselineHash === currentHash,
    })
}

function preserved(category, name, baselinePresent, currentPresent) {

    return Object.freeze({
        category,
        name,
        baselinePresent,
        currentPresent,
        preserved: baselinePresent && currentPresent,
    })
}

function replacement(name, baselineBehaviorPresent, replacementPresent) {

    return Object.freeze({
        name,
        baselineBehaviorPresent,
        replacementPresent,
        replaced: baselineBehaviorPresent && replacementPresent,
    })
}

function synchronousSubmit(source) {

    return /\n    submit\(\) \{/.test(source) && !/async\s+submit\(/.test(source)
}

function hasAll(source, markers) {

    return markers.every(marker => source.includes(marker))
}

function appearsInOrder(source, markers) {

    let previous = -1
    for (const marker of markers) {
        const index = source.indexOf(marker, previous + 1)
        if (index < 0) return false
        previous = index
    }
    return true
}

function exportedNames(source) {

    const names = new Set()
    for (const match of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
        for (const item of match[1].split(',')) {
            const normalized = item.trim().replace(/^type\s+/, '')
            if (normalized.length === 0) continue
            const [ original, alias ] = normalized.split(/\s+as\s+/)
            names.add((alias ?? original).trim())
        }
    }
    return [ ...names ].sort()
}

function missingExports(baselineSource, currentSource) {

    const currentNames = new Set(exportedNames(currentSource))
    return exportedNames(baselineSource).filter(name => !currentNames.has(name))
}

function diagnosticCodes(source) {

    return [ ...new Set(source.match(/SCRATCH_[A-Z0-9_]+/g) ?? []) ].sort()
}

function hashSources(paths, sources) {

    return Object.fromEntries(Object.keys(paths).map(name => [ name, sha256(sources[name]) ]))
}

function sha256(value) {

    return createHash('sha256').update(value).digest('hex')
}

function failedNames(checks, property) {

    return checks.filter(check => !check[property]).map(check => check.name).join(', ')
}

function assertParity(condition, message) {

    if (!condition) throw new Error(message)
}
