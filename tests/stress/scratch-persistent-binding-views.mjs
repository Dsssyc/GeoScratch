import os from 'node:os'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { ScratchRuntime } from '../../packages/geoscratch/dist/scratch/runtime.js'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    createTestProgram,
} from '../scratch-test-utils.js'

const iterations = positiveInteger(
    process.env.SCRATCH_BINDING_STRESS_ITERATIONS,
    20_000
)
const allowShort = process.env.SCRATCH_BINDING_STRESS_ALLOW_SHORT === '1'
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4

if (!allowShort) {
    assertStress(iterations >= 20_000, 'binding stress must run at least 20,000 cycles per steady-state phase')
}

const result = await stressPersistentBindings(iterations)
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function stressPersistentBindings(cycleCount) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        diagnostics: {
            submissionScopes: 'off',
            operationCapacity: 128,
            incidentCapacity: 16,
            evidenceByteCapacity: 128 * 1024,
        },
    })
    const input = await runtime.createBuffer({
        label: 'binding stress dynamic input',
        size: 512,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const texture = await runtime.createTexture({
        label: 'binding stress sampled texture',
        size: [ 2, 2 ],
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    advanceResourceContentEpochForTest(input)
    advanceResourceContentEpochForTest(texture)
    const sampler = await runtime.createSampler({ label: 'binding stress sampler' })
    const layout = await runtime.createBindLayout({
        label: 'binding stress layout',
        group: 0,
        entries: [
            {
                binding: 0,
                name: 'values',
                type: 'read-storage',
                visibility: [ 'compute' ],
                hasDynamicOffset: true,
                minBindingSize: 16,
            },
            {
                binding: 1,
                name: 'image',
                type: 'texture',
                visibility: [ 'compute' ],
                sampleType: 'float',
                viewDimension: '2d',
            },
            {
                binding: 2,
                name: 'imageSampler',
                type: 'sampler',
                visibility: [ 'compute' ],
                samplerType: 'filtering',
            },
        ],
    })
    const logicalView = texture.view()
    const bindSet = await runtime.createBindSet(layout, {
        values: input.region({ size: 16 }),
        image: logicalView,
        imageSampler: sampler,
    }, {
        label: 'binding stress set',
    })
    const program = await createTestProgram(runtime, {
        label: 'binding stress program',
        sourceParts: [ `
            @group(0) @binding(0) var<storage, read> values: array<u32>;
            @group(0) @binding(1) var image: texture_2d<f32>;
            @group(0) @binding(2) var imageSampler: sampler;

            @compute @workgroup_size(1)
            fn main() {
                let retained = values[0] + u32(textureSampleLevel(
                    image,
                    imageSampler,
                    vec2f(0.5),
                    0.0
                ).r);
                _ = retained;
            }
        ` ],
        compute: 'main',
    })
    const pipeline = await runtime.createComputePipeline({
        label: 'binding stress pipeline',
        program,
        layout: { mode: 'explicit', bindLayouts: [ layout ] },
    })
    const pass = runtime.createComputePass({ label: 'binding stress pass' })
    const commands = [ 0, 256 ].map(offset => runtime.createDispatchCommand({
        label: `binding stress dispatch ${offset}`,
        pipeline,
        bindSets: [ {
            set: bindSet,
            dynamicOffsets: { values: offset },
        } ],
        count: { workgroups: [ 1 ] },
        resources: {
            read: [
                { resource: input, contentEpoch: input.contentEpoch },
                { resource: texture, contentEpoch: texture.contentEpoch },
            ],
            write: [],
        },
        whenMissing: 'throw',
    }))

    const initial = captureBindingFacts(runtime, fake, bindSet)
    assertStress(initial.bindGroupCount === 1, 'initial preparation must create exactly one bind group')
    assertStress(initial.textureViewCount === 1, 'initial preparation must create exactly one native texture view')
    assertStress(initial.prepareGeneration === 1, 'initial preparation generation must be one')
    assertStress(initial.preparationOperationCount === 1, 'initial preparation must record one operation')
    assertStress(bindSet.preparationState === 'prepared', 'initial BindSet must be prepared')

    const firstNativeBindGroup = fake.calls.bindGroups[0]
    const firstNativeView = textureViewFromBindGroup(firstNativeBindGroup)
    const first = runSteadyState({
        cycleCount,
        commands,
        pass,
        bindSet,
        expectedBindGroup: firstNativeBindGroup,
    })
    const afterFirst = captureBindingFacts(runtime, fake, bindSet)
    assertNoPreparationDelta(initial, afterFirst, 'first steady state')

    const commandEncoderCountBeforeStaleSubmit = fake.calls.commandEncoders.length
    const generationBeforeReplacement = bindSet.prepareGeneration
    const snapshotBeforeReplacement = bindSet.preparedSnapshotHash
    const allocationVersionBeforeReplacement = texture.allocationVersion
    await texture.resize([ 4, 4 ])
    const allocationVersionAfterReplacement = texture.allocationVersion
    assertStress(
        allocationVersionAfterReplacement === allocationVersionBeforeReplacement + 1,
        'texture replacement must advance allocationVersion exactly once'
    )
    assertStress(bindSet.preparationState === 'stale', 'replacement must make every affected BindSet stale')

    const staleFailure = captureSynchronousFailure(() => runtime.createSubmission()
        .compute(pass, [ commands[0] ])
        .submit())
    assertStress(
        staleFailure?.diagnostic?.code === 'SCRATCH_BIND_SET_STALE',
        'stale submission must fail with SCRATCH_BIND_SET_STALE'
    )
    assertStress(
        fake.calls.commandEncoders.length === commandEncoderCountBeforeStaleSubmit,
        'stale submission must fail before command encoder creation'
    )

    const beforePrepare = captureBindingFacts(runtime, fake, bindSet)
    const firstPrepare = bindSet.prepare()
    const sameSnapshotPrepare = bindSet.prepare()
    assertStress(firstPrepare === sameSnapshotPrepare, 'same-snapshot concurrent prepare must share one Promise')
    await firstPrepare
    const afterPrepare = captureBindingFacts(runtime, fake, bindSet)
    assertStress(bindSet.preparationState === 'prepared', 'explicit prepare must restore prepared state')
    assertStress(
        bindSet.prepareGeneration === generationBeforeReplacement + 1,
        'successful replacement preparation must advance generation exactly once'
    )
    assertStress(
        bindSet.preparedSnapshotHash !== snapshotBeforeReplacement,
        'replacement preparation must commit a different allocation snapshot'
    )
    assertStress(
        afterPrepare.bindGroupCount === beforePrepare.bindGroupCount + 1,
        'single-flight replacement preparation must create one bind group'
    )
    assertStress(
        afterPrepare.textureViewCount === beforePrepare.textureViewCount + 1,
        'single-flight replacement preparation must create one candidate-local texture view'
    )
    assertStress(
        afterPrepare.preparationOperationCount === beforePrepare.preparationOperationCount + 1,
        'single-flight replacement preparation must record one preparation operation'
    )

    const replacementBindGroup = fake.calls.bindGroups.at(-1)
    const replacementNativeView = textureViewFromBindGroup(replacementBindGroup)
    assertStress(replacementBindGroup !== firstNativeBindGroup, 'replacement must commit a new native bind group')
    assertStress(replacementNativeView !== firstNativeView, 'replacement must commit a new candidate-local view')

    const second = runSteadyState({
        cycleCount,
        commands,
        pass,
        bindSet,
        expectedBindGroup: replacementBindGroup,
    })
    const afterSecond = captureBindingFacts(runtime, fake, bindSet)
    assertNoPreparationDelta(afterPrepare, afterSecond, 'second steady state')

    const terminal = {
        pendingOperationCount: runtime.diagnostics.snapshot().pendingOperations.length,
        preparationState: bindSet.preparationState,
        prepareGeneration: bindSet.prepareGeneration,
        bindGroupCount: fake.calls.bindGroups.length,
        textureViewCount: fake.calls.textureViews.length,
        commandEncoderCount: fake.calls.commandEncoders.length,
    }
    assertStress(terminal.pendingOperationCount === 0, 'stress run retained pending GPU operations')

    const output = {
        schemaVersion: 1,
        environment: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            cpu: os.cpus()[0]?.model ?? 'unknown',
            logicalCpuCount: os.cpus().length,
            iterationsPerSteadyState: cycleCount,
        },
        measurementBoundary: {
            device: 'deterministic in-process fake GPUDevice',
            cycle: 'preconstructed DispatchCommand.validateForPass() plus encode() against a minimal pass encoder',
            staleGate: 'one complete SubmissionBuilder preflight through synchronous failure',
            bindingAllocation: 'native bind group, candidate-local native texture view, scopes, diagnostics operation, generation, and identity counters',
            dynamicOffsets: 'pre-lowered native offset-array identity and zero reads of the frozen public name map',
            excludes: [
                'browser IPC',
                'driver execution',
                'physical GPU work',
                'command encoder and command buffer allocation',
                'general JavaScript garbage-collection guarantees',
            ],
        },
        initial,
        firstSteadyState: {
            ...first,
            countersBefore: initial,
            countersAfter: afterFirst,
        },
        replacement: {
            allocationVersionBefore: allocationVersionBeforeReplacement,
            allocationVersionAfter: allocationVersionAfterReplacement,
            staleDiagnosticCode: staleFailure?.diagnostic?.code,
            commandEncodersCreatedByStaleSubmission:
                fake.calls.commandEncoders.length - commandEncoderCountBeforeStaleSubmit,
            concurrentPromiseShared: firstPrepare === sameSnapshotPrepare,
            generationBefore: generationBeforeReplacement,
            generationAfter: bindSet.prepareGeneration,
            snapshotChanged: bindSet.preparedSnapshotHash !== snapshotBeforeReplacement,
            bindGroupsCreated: afterPrepare.bindGroupCount - beforePrepare.bindGroupCount,
            textureViewsCreated: afterPrepare.textureViewCount - beforePrepare.textureViewCount,
            preparationOperationsCreated:
                afterPrepare.preparationOperationCount - beforePrepare.preparationOperationCount,
            nativeBindGroupChanged: replacementBindGroup !== firstNativeBindGroup,
            candidateLocalViewChanged: replacementNativeView !== firstNativeView,
        },
        secondSteadyState: {
            ...second,
            countersBefore: afterPrepare,
            countersAfter: afterSecond,
        },
        terminal,
        verification: {
            status: 'passed',
            minimumEnforced: !allowShort,
            minimumCyclesPerSteadyState: allowShort ? 1 : 20_000,
        },
    }

    for (const command of commands) command.dispose()
    pass.dispose()
    pipeline.dispose()
    program.dispose()
    bindSet.dispose()
    layout.dispose()
    sampler.dispose()
    texture.dispose()
    input.dispose()
    runtime.dispose()

    return output
}

function runSteadyState({ cycleCount, commands, pass, bindSet, expectedBindGroup }) {

    const publicNameMaps = new Set(commands.map(command => command.bindSets[0].dynamicOffsets))
    const bindSetStateBefore = captureBindSetPublicState(bindSet)
    const nativeOffsetReferences = new Map()
    let activeCommand
    let nameMapReads = 0
    let snapshotSerializations = 0
    let bindingOrderSorts = 0
    let bindGroupIdentityChanges = 0
    let nativeOffsetIdentityChanges = 0
    let setBindGroupCalls = 0
    const originalObjectKeys = Object.keys
    const originalObjectEntries = Object.entries
    const originalObjectValues = Object.values
    const originalReflectOwnKeys = Reflect.ownKeys
    const originalStringify = JSON.stringify
    const originalSort = Array.prototype.sort
    Object.keys = function(value) {

        if (publicNameMaps.has(value)) nameMapReads++
        return originalObjectKeys(value)
    }
    Object.entries = function(value) {

        if (publicNameMaps.has(value)) nameMapReads++
        return originalObjectEntries(value)
    }
    Object.values = function(value) {

        if (publicNameMaps.has(value)) nameMapReads++
        return originalObjectValues(value)
    }
    Reflect.ownKeys = function(value) {

        if (publicNameMaps.has(value)) nameMapReads++
        return originalReflectOwnKeys(value)
    }
    JSON.stringify = function(value, ...parameters) {

        if (
            value?.bindLayoutId === bindSet.layout.id &&
            Array.isArray(value.bindings)
        ) snapshotSerializations++
        return originalStringify.call(JSON, value, ...parameters)
    }
    Array.prototype.sort = function(...parameters) {

        if (
            this.length > 0 &&
            this.every(value => Number.isInteger(value?.binding))
        ) bindingOrderSorts++
        return originalSort.apply(this, parameters)
    }

    const encoder = {
        setPipeline() {},
        setBindGroup(group, bindGroup, dynamicOffsets) {

            setBindGroupCalls++
            if (group !== bindSet.layout.group || bindGroup !== expectedBindGroup) {
                bindGroupIdentityChanges++
            }
            const previous = nativeOffsetReferences.get(activeCommand)
            if (previous === undefined) {
                nativeOffsetReferences.set(activeCommand, dynamicOffsets)
            } else if (previous !== dynamicOffsets) {
                nativeOffsetIdentityChanges++
            }
        },
        dispatchWorkgroups() {},
    }
    const startedAt = performance.now()
    try {
        for (let index = 0; index < cycleCount; index++) {
            activeCommand = commands[index % commands.length]
            activeCommand.validateForPass(pass)
            activeCommand.encode(encoder)
        }
    } finally {
        Object.keys = originalObjectKeys
        Object.entries = originalObjectEntries
        Object.values = originalObjectValues
        Reflect.ownKeys = originalReflectOwnKeys
        JSON.stringify = originalStringify
        Array.prototype.sort = originalSort
    }
    const elapsedMs = performance.now() - startedAt
    const bindSetStateAfter = captureBindSetPublicState(bindSet)
    const bindSetMutated = !sameBindSetPublicState(bindSetStateBefore, bindSetStateAfter)

    assertStress(setBindGroupCalls === cycleCount, 'each steady-state cycle must bind exactly once')
    assertStress(bindGroupIdentityChanges === 0, 'steady-state native bind group identity changed')
    assertStress(nativeOffsetIdentityChanges === 0, 'native dynamic-offset sequence was reconstructed')
    assertStress(nativeOffsetReferences.size === commands.length, 'not every preconstructed Command encoded')
    assertStress(nameMapReads === 0, 'submission-time binding work read or sorted a dynamic-offset name map')
    assertStress(snapshotSerializations === 0, 'steady-state binding work reconstructed a preparation snapshot')
    assertStress(bindingOrderSorts === 0, 'steady-state binding work sorted bindings into native order')
    assertStress(!bindSetMutated, 'steady-state use mutated public BindSet facts or identities')
    assertStress(bindSet.preparationState === 'prepared', 'steady-state use changed BindSet preparation state')

    return {
        cycles: cycleCount,
        elapsedMs,
        microsecondsPerCycle: elapsedMs * 1_000 / cycleCount,
        setBindGroupCalls,
        bindGroupIdentityChanges,
        nativeOffsetIdentityChanges,
        stableNativeOffsetSequenceCount: nativeOffsetReferences.size,
        dynamicOffsetNameMapReads: nameMapReads,
        snapshotSerializations,
        bindingOrderSorts,
        bindSetMutated,
    }
}

function captureBindSetPublicState(bindSet) {

    return {
        bindSet,
        bindings: bindSet.bindings,
        bindingEntries: [ ...bindSet.bindings.entries() ].map(([ name, binding ]) => ({
            name,
            binding,
            entry: binding.entry,
            resource: binding.resource,
        })),
        preparationState: bindSet.preparationState,
        prepareGeneration: bindSet.prepareGeneration,
        preparedSnapshotHash: bindSet.preparedSnapshotHash,
    }
}

function sameBindSetPublicState(left, right) {

    if (
        left.bindSet !== right.bindSet ||
        left.bindings !== right.bindings ||
        left.preparationState !== right.preparationState ||
        left.prepareGeneration !== right.prepareGeneration ||
        left.preparedSnapshotHash !== right.preparedSnapshotHash ||
        left.bindingEntries.length !== right.bindingEntries.length
    ) return false

    for (let index = 0; index < left.bindingEntries.length; index++) {
        const before = left.bindingEntries[index]
        const after = right.bindingEntries[index]
        if (
            before.name !== after.name ||
            before.binding !== after.binding ||
            before.entry !== after.entry ||
            before.resource !== after.resource
        ) return false
    }
    return true
}

function captureBindingFacts(runtime, fake, bindSet) {

    const snapshot = runtime.diagnostics.snapshot()
    return {
        bindGroupCount: fake.calls.bindGroups.length,
        textureViewCount: fake.calls.textureViews.length,
        scopePushCount: fake.calls.errorScopes.filter(call => call.action === 'push').length,
        scopePopCount: fake.calls.errorScopes.filter(call => call.action === 'pop').length,
        preparationOperationCount: runtime.diagnostics.operations({
            kind: 'bind-set-preparation',
            bindSetId: bindSet.id,
        }).length,
        allocationAttemptCount: snapshot.aggregates.allocationAttempts,
        prepareGeneration: bindSet.prepareGeneration,
        preparedSnapshotHash: bindSet.preparedSnapshotHash,
        preparationState: bindSet.preparationState,
    }
}

function assertNoPreparationDelta(before, after, label) {

    for (const key of [
        'bindGroupCount',
        'textureViewCount',
        'scopePushCount',
        'scopePopCount',
        'preparationOperationCount',
        'allocationAttemptCount',
        'prepareGeneration',
        'preparedSnapshotHash',
    ]) {
        assertStress(after[key] === before[key], `${label} changed ${key}`)
    }
    assertStress(after.preparationState === 'prepared', `${label} left BindSet unprepared`)
}

function textureViewFromBindGroup(bindGroup) {

    const entry = bindGroup?.descriptor?.entries?.find(candidate => candidate.binding === 1)
    assertStress(entry?.resource?.type === 'textureView', 'prepared bind group lacks sampled texture view')
    return entry.resource
}

function captureSynchronousFailure(action) {

    try {
        action()
        return undefined
    } catch (error) {
        return error
    }
}

function positiveInteger(value, fallback) {

    const candidate = value === undefined ? fallback : Number(value)
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new TypeError(`Expected a positive integer, received ${value}.`)
    }
    return candidate
}

function assertStress(condition, message) {

    if (!condition) throw new Error(message)
}
