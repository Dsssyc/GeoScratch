import fs from 'node:fs'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const jsBaseline = '20bb393df570ff1914a6789e9bd422d59ddfecc8'
const goalBaseline = 'f3e73062bb352009a2118bf9960de062b1296ebe'
const files = [ 'readback', 'command', 'submission', 'runtime' ]
const supportFiles = [
    'gpu-operation',
    'readback-mapping',
    'readback-ownership',
    'readback-staging',
    'runtime-diagnostics',
]
assertAncestor(goalBaseline)
const oldJsReadback = gitShow(jsBaseline, 'packages/geoscratch/src/scratch/readback.js')
const goalSources = Object.fromEntries(files.map(file => [
    file,
    gitShow(goalBaseline, `packages/geoscratch/src/scratch/${file}.ts`),
]))
const currentSources = Object.fromEntries(files.map(file => [
    file,
    fs.readFileSync(`packages/geoscratch/src/scratch/${file}.ts`, 'utf8'),
]))
const currentSupportSources = Object.fromEntries(supportFiles.map(file => [
    file,
    fs.readFileSync(`packages/geoscratch/src/scratch/${file}.ts`, 'utf8'),
]))
const currentCombined = [
    ...Object.values(currentSources),
    ...Object.values(currentSupportSources),
].join('\n')
const oldDiagnosticCodes = unique(oldJsReadback.match(/SCRATCH_[A-Z0-9_]+/g) ?? [])
const replacedDiagnosticCodes = Object.freeze({
    SCRATCH_READBACK_MAP_FAILED: Object.freeze([
        'SCRATCH_READBACK_COPY_ISSUE_FAILED',
        'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED',
        'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED',
        'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY',
        'SCRATCH_READBACK_MAPPING_SCOPE_FAILED',
        'SCRATCH_READBACK_MAPPING_REJECTED',
        'SCRATCH_READBACK_MAPPED_RANGE_FAILED',
        'SCRATCH_READBACK_HOST_COPY_FAILED',
        'SCRATCH_READBACK_CLEANUP_FAILED',
    ]),
})

for (const code of oldDiagnosticCodes) {
    if (code in replacedDiagnosticCodes) {
        for (const replacement of replacedDiagnosticCodes[code]) {
            assertParity(currentCombined.includes(replacement), `${code} replacement ${replacement} is missing`)
        }
    } else {
        assertParity(currentCombined.includes(code), `legacy diagnostic ${code} is missing`)
    }
}

const legacyBehaviorChecks = [
    behavior('typed-array-readback', oldJsReadback, /async toArray\(/, currentSources.readback, /toArray\(\): Promise<Uint8Array>/),
    behavior('explicit-byte-readback', oldJsReadback, /async toBytes\(/, currentSources.readback, /toBytes\(\): Promise<Uint8Array>/),
    behavior('range-default-and-validation', oldJsReadback, /function normalizeRange\(/, currentSources.readback, /function normalizeRange\(/),
    behavior('same-runtime-after-validation', oldJsReadback, /function normalizeAfter\(/, currentSources.readback, /function normalizeAfter\(/),
    behavior('copy-source-usage-validation', oldJsReadback, /BUFFER_USAGE_COPY_SRC/, currentSources.readback, /BUFFER_USAGE_COPY_SRC/),
    behavior('captured-content-epoch', oldJsReadback, /this\.contentEpoch = this\.source\.contentEpoch/, currentSources.readback, /state\.contentEpoch = construction\.contentEpoch/),
    behavior('captured-allocation-version', oldJsReadback, /this\.allocationVersion = this\.source\.allocationVersion/, currentSources.readback, /state\.allocationVersion = construction\.allocationVersion/),
    behavior('gpu-copy-range', oldJsReadback, /copyBufferToBuffer\(/, currentSources.readback, /copyBufferToBuffer\(/),
    behavior('cancel-lifecycle', oldJsReadback, /cancel\(reason\)/, currentSources.readback, /cancel\(reason\?: string\)/),
    behavior('dispose-lifecycle', oldJsReadback, /dispose\(\)/, currentSources.readback, /dispose\(\)/),
    behavior('owned-host-copy', oldJsReadback, /mapped\.slice\(0\)/, currentSources.readback, /mapped\.slice\(0\)/),
    behavior('mapped-range-bounds', oldJsReadback, /getMappedRange\(0, this\.range\.byteLength\)/, currentSources.readback, /getMappedRange\(0, this\.range\.byteLength\)/),
]

const goalBehaviorChecks = [
    crossCheck('layout-derived-view', 'readback', /toLayoutView\(\)/),
    crossCheck('consume-on-read-retention', 'readback', /'consume-on-read'/),
    crossCheck('until-dispose-retention', 'readback', /'until-dispose'/),
    crossCheck('source-content-epoch-stale', 'readback', /SCRATCH_READBACK_SOURCE_EPOCH_STALE/),
    crossCheck('source-allocation-version-stale', 'readback', /SCRATCH_READBACK_SOURCE_ALLOCATION_STALE/),
    crossCheck('producer-epoch-lookup', 'readback', /function findSourceProducerEpoch\(/),
    crossCheck('ordered-result-exact-work', 'command', /result\(options: ReadbackCommandResultOptions\)/),
    crossCheck('ordered-range-normalization', 'command', /function normalizeReadbackCommandRange\(/),
    crossCheck('ordered-retention-normalization', 'command', /function normalizeReadbackCommandRetention\(/),
    crossCheck('ordered-throw-readiness', 'command', /normalizeReadbackCommandReadinessPolicy/),
    crossCheck('submission-readback-step', 'submission', /readback\(command: ReadbackCommand\)/),
    crossCheck('submission-read-only-access', 'submission', /commandAccessOrigin\(stepIndex, 'readback'/),
    crossCheck('producer-before-readback-step', 'submission', /producerEpoch\.producedBy\.stepIndex < pending\.stepIndex/),
    crossCheck('duplicate-command-preflight', 'submission', /SCRATCH_READBACK_COMMAND_DUPLICATE_IN_SUBMISSION/),
    crossCheck('failed-submission-cleanup', 'submission', /releaseFailedSubmissionReadbacks\(/),
    crossCheck('staged-source-disposal-boundary', 'readback', /if \(scheduledReadbackOperations\.has\(this\)\) return/),
]
const oldCancelBody = sourceBetween(oldJsReadback, '    cancel(reason)', '    dispose()')
const currentCancelBody = sourceBetween(currentSources.readback, '    cancel(reason?: string)', '    dispose()')

const intentionalReplacements = [
    replacement(
        'public operation constructor',
        /constructor\(runtime, descriptor = \{\}\)/.test(oldJsReadback),
        /private constructor\(/.test(currentSources.readback)
    ),
    replacement(
        'public stagingBuffer field',
        /this\.stagingBuffer/.test(oldJsReadback),
        !/get\s+stagingBuffer\s*\(/.test(currentSources.readback)
    ),
    replacement(
        'broad direct after.done wait',
        /await this\.after\.done/.test(goalSources.readback),
        !/await\s+(?:this\.)?after\.done/.test(currentSources.readback)
    ),
    replacement(
        'broad direct queue completion wait',
        /await queue\.onSubmittedWorkDone\(\)/.test(goalSources.readback),
        !/onSubmittedWorkDone/.test(currentSources.readback)
    ),
    replacement(
        'submission-time ordered staging allocation',
        /this\.runtime\.device\.createBuffer\(stagingDescriptor\)/.test(goalSources.command),
        !/\.createBuffer\s*\(/.test(currentSources.submission)
    ),
    replacement(
        'synchronous ordered factory',
        /return new ReadbackCommand\(this, descriptor\)/.test(goalSources.runtime),
        /async createReadbackCommand\([^)]*\): Promise<ReadbackCommand>/.test(currentSources.runtime)
    ),
    replacement(
        'generic map failure code',
        /SCRATCH_READBACK_MAP_FAILED/.test(goalSources.readback),
        !/SCRATCH_READBACK_MAP_FAILED/.test(currentSources.readback)
    ),
    replacement(
        'duplicate in-flight materialization',
        !/materialization/.test(oldJsReadback),
        /state\.materialization !== undefined/.test(currentSources.readback)
    ),
    replacement(
        'incidental retry after failed materialization',
        /this\.state = 'failed'/.test(oldJsReadback) && !/this\.state === 'failed'/.test(oldJsReadback),
        /if \(this\.state === 'failed'\)/.test(currentSources.readback)
    ),
    replacement(
        'cancel without staging release',
        !oldCancelBody.includes('stagingBuffer'),
        currentCancelBody.includes('this._releaseStagingBuffer(true)')
    ),
]

assertParity(
    legacyBehaviorChecks.every(check => check.preserved),
    `legacy JS behavior checks failed: ${failedNames(legacyBehaviorChecks, 'preserved')}`
)
assertParity(
    goalBehaviorChecks.every(check => check.preserved),
    `Goal-baseline behavior checks failed: ${failedNames(goalBehaviorChecks, 'preserved')}`
)
assertParity(
    intentionalReplacements.every(check => check.replaced),
    `intentional replacement checks failed: ${failedNames(intentionalReplacements, 'replaced')}`
)
assertParity(/buffer\.mapAsync\(GPUMapModeValue\(\), 0, byteLength\)/.test(
    currentSupportSources['readback-mapping']
), 'shared mapping transaction is missing')
assertParity(/allocateReadbackStaging\(/.test(currentSources.readback), 'direct acknowledged staging is missing')
assertParity(/allocateReadbackStaging\(/.test(currentSources.command), 'ordered acknowledged staging is missing')
assertParity(
    /version: 4/.test(currentSupportSources['gpu-operation']) &&
        !/version: [23]/.test(currentSupportSources['gpu-operation']),
    'schema v4 clean cut is missing'
)
assertParity(
    /failureStage: 'budget'/.test(currentSupportSources['runtime-diagnostics']),
    'pending-operation budget incident provenance is missing'
)
assertParity(
    /failureStage: 'queue-completion'/.test(currentSources.submission) &&
        /attribution: 'enclosing-operation-family'/.test(currentSources.submission),
    'queue-completion enclosing-family incident provenance is missing'
)
const publicIndex = fs.readFileSync('packages/geoscratch/src/index.ts', 'utf8')
const scratchIndex = fs.readFileSync('packages/geoscratch/src/scratch/index.ts', 'utf8')
for (const publicName of [ 'ReadbackCommand', 'ReadbackOperation', 'SubmittedReadbackLink' ]) {
    assertParity(
        publicIndex.includes(publicName) && scratchIndex.includes(publicName),
        `public entrypoint parity is missing ${publicName}`
    )
}
for (const internalName of [ 'ReadbackStagingSlot', 'ReadbackMappingTransaction', 'ReadbackCommandClaim' ]) {
    assertParity(
        !publicIndex.includes(internalName) && !scratchIndex.includes(internalName),
        `internal ownership type leaked through an entrypoint: ${internalName}`
    )
}

const result = {
    schemaVersion: 1,
    baselines: {
        jsSource: jsBaseline,
        goalStart: goalBaseline,
    },
    sourceHashes: {
        jsReadback: sha256(oldJsReadback),
        goalStart: Object.fromEntries(files.map(file => [ file, sha256(goalSources[file]) ])),
        current: Object.fromEntries([
            ...files.map(file => [ file, sha256(currentSources[file]) ]),
            ...supportFiles.map(file => [ file, sha256(currentSupportSources[file]) ]),
        ]),
    },
    oldDiagnosticCodes,
    replacedDiagnosticCodes,
    legacyBehaviorChecks,
    goalBehaviorChecks,
    intentionalReplacements,
    verification: {
        status: 'passed',
        oldDiagnosticCodeCount: oldDiagnosticCodes.length,
        legacyBehaviorCount: legacyBehaviorChecks.length,
        goalBehaviorCount: goalBehaviorChecks.length,
        intentionalReplacementCount: intentionalReplacements.length,
    },
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function gitShow(commit, file) {

    return execFileSync('git', [ 'show', `${commit}:${file}` ], { encoding: 'utf8' })
}

function assertAncestor(commit) {

    try {
        execFileSync('git', [ 'merge-base', '--is-ancestor', commit, 'HEAD' ])
    } catch {
        throw new Error(`Goal baseline ${commit} is not an ancestor of HEAD.`)
    }
}

function behavior(name, oldSource, oldPattern, currentSource, currentPattern) {

    const existed = oldPattern.test(oldSource)
    const exists = currentPattern.test(currentSource)
    return Object.freeze({ name, existed, exists, preserved: existed && exists })
}

function crossCheck(name, file, pattern) {

    const existed = pattern.test(goalSources[file])
    const exists = pattern.test(currentSources[file])
    return Object.freeze({ name, existed, exists, preserved: existed && exists })
}

function replacement(name, oldBehaviorPresent, replacementPresent) {

    return Object.freeze({
        name,
        oldBehaviorPresent,
        replacementPresent,
        replaced: oldBehaviorPresent && replacementPresent,
    })
}

function sha256(value) {

    return createHash('sha256').update(value).digest('hex')
}

function unique(values) {

    return [ ...new Set(values) ].sort()
}

function failedNames(checks, property) {

    return checks.filter(check => !check[property]).map(check => check.name).join(', ')
}

function sourceBetween(source, startMarker, endMarker) {

    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start + startMarker.length)
    if (start < 0 || end < 0) throw new Error(`Source markers are missing: ${startMarker}, ${endMarker}`)
    return source.slice(start, end)
}

function assertParity(condition, message) {

    if (!condition) throw new Error(message)
}
