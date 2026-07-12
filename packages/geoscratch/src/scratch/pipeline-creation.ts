import { createPipelineNativeErrorSerializer } from './pipeline-native-error.js'
import { createPipelineCompilationReport } from './pipeline-compilation.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuIncidentFailureStage,
    ScratchGpuIncidentOutcome,
} from './gpu-operation.js'
import type {
    PipelineCompilationReport,
    PipelineKind,
    PipelineSourceSnapshot,
} from './pipeline-compilation.js'
import type { ScratchRuntime } from './runtime.js'

export type PipelineNativeLabels = Readonly<{
    pipeline: string
    shaderModule: string
    pipelineLayout: string
}>

export type PipelineCreationIssueInput = Readonly<{
    runtime: ScratchRuntime
    pipelineId: string
    pipelineKind: PipelineKind
    sourceSnapshot: PipelineSourceSnapshot
    nativeLabels: PipelineNativeLabels
    bindGroupLayouts: readonly GPUBindGroupLayout[]
    lowerPipelineDescriptor: (
        shaderModule: GPUShaderModule,
        pipelineLayout: GPUPipelineLayout
    ) => GPURenderPipelineDescriptor | GPUComputePipelineDescriptor
}>

export type PipelineCreationObservedFailure = Readonly<{
    outcome: ScratchGpuIncidentOutcome
    cause?: unknown
}>

export type PipelineCreationIssueResult = Readonly<{
    shaderModule?: GPUShaderModule
    pipelineLayout?: GPUPipelineLayout
    nativePipeline?: GPURenderPipeline | GPUComputePipeline
    compilationReport?: PipelineCompilationReport
    failures: readonly PipelineCreationObservedFailure[]
}>

type PromiseObservation<T> =
    | Readonly<{ status: 'not-issued' }>
    | Readonly<{ status: 'fulfilled', value: T }>
    | Readonly<{ status: 'rejected', reason: unknown }>
    | Readonly<{ status: 'invalid', reason: TypeError }>

type ScopeFilter = 'validation' | 'internal' | 'out-of-memory'

type ScopeObservation = Readonly<{
    filter: ScopeFilter
    observation: PromiseObservation<GPUError | null>
}>

type PendingScopeObservation = Readonly<{
    filter: ScopeFilter
    observation: Promise<PromiseObservation<GPUError | null>>
}>

const stageOrder: Record<ScratchGpuIncidentFailureStage, number> = {
    'supporting-object-creation': 0,
    'compilation-info': 1,
    'shader-compilation': 2,
    'pipeline-creation': 3,
    'scope-settlement': 4,
    'lifecycle-recheck': 5,
}

export function issuePipelineCreation(
    input: PipelineCreationIssueInput
): Promise<PipelineCreationIssueResult> {

    const device = input.runtime.device
    const boundaryFailures: unknown[] = []
    let outOfMemoryPushed = false
    let internalPushed = false
    let validationPushed = false
    let shaderModule: GPUShaderModule | undefined
    let pipelineLayout: GPUPipelineLayout | undefined
    let synchronousFailure: Readonly<{
        stage: ScratchGpuIncidentFailureStage
        cause: unknown
    }> | undefined
    let compilation = notIssued<GPUCompilationInfo>()
    let pipeline = notIssued<GPURenderPipeline | GPUComputePipeline>()

    if (
        !device ||
        typeof device.pushErrorScope !== 'function' ||
        typeof device.popErrorScope !== 'function'
    ) {
        boundaryFailures.push(new TypeError('GPUDevice error-scope methods are unavailable.'))
    } else {
        try {
            device.pushErrorScope('out-of-memory')
            outOfMemoryPushed = true
        } catch (error) {
            boundaryFailures.push(error)
        }
        if (outOfMemoryPushed) {
            try {
                device.pushErrorScope('internal')
                internalPushed = true
            } catch (error) {
                boundaryFailures.push(error)
            }
        }
        if (outOfMemoryPushed && internalPushed) {
            try {
                device.pushErrorScope('validation')
                validationPushed = true
            } catch (error) {
                boundaryFailures.push(error)
            }
        }
    }

    if (outOfMemoryPushed && internalPushed && validationPushed) {
        let stage: ScratchGpuIncidentFailureStage = 'supporting-object-creation'
        try {
            shaderModule = device.createShaderModule({
                label: input.nativeLabels.shaderModule,
                code: input.sourceSnapshot.combinedSource,
            })
            if (!isObjectLike(shaderModule)) {
                throw new TypeError('GPUDevice.createShaderModule() returned an invalid object.')
            }
            pipelineLayout = device.createPipelineLayout({
                label: input.nativeLabels.pipelineLayout,
                bindGroupLayouts: [ ...input.bindGroupLayouts ],
            })
            if (!isObjectLike(pipelineLayout)) {
                throw new TypeError('GPUDevice.createPipelineLayout() returned an invalid object.')
            }

            stage = 'compilation-info'
            if (typeof shaderModule.getCompilationInfo !== 'function') {
                throw new TypeError('GPUShaderModule.getCompilationInfo() is unavailable.')
            }
            compilation = observePromise(
                shaderModule.getCompilationInfo(),
                'GPUShaderModule.getCompilationInfo()'
            )

            stage = 'pipeline-creation'
            const descriptor = input.lowerPipelineDescriptor(shaderModule, pipelineLayout)
            const promise = input.pipelineKind === 'render'
                ? device.createRenderPipelineAsync(descriptor as GPURenderPipelineDescriptor)
                : device.createComputePipelineAsync(descriptor as GPUComputePipelineDescriptor)
            pipeline = observePromise(promise, `GPUDevice.create${capitalize(input.pipelineKind)}PipelineAsync()`)
        } catch (cause) {
            synchronousFailure = Object.freeze({ stage, cause })
        }
    }

    const validation = popScope(device, validationPushed, 'validation')
    const internal = popScope(device, internalPushed, 'internal')
    const outOfMemory = popScope(device, outOfMemoryPushed, 'out-of-memory')

    return Promise.all([
        compilation,
        pipeline,
        validation.observation,
        internal.observation,
        outOfMemory.observation,
    ]).then(([ compilationResult, pipelineResult, validationResult, internalResult, oomResult ]) => {
        return settlePipelineCreationIssue({
            input,
            ...(shaderModule !== undefined ? { shaderModule } : {}),
            ...(pipelineLayout !== undefined ? { pipelineLayout } : {}),
            ...(synchronousFailure !== undefined ? { synchronousFailure } : {}),
            boundaryFailures,
            compilation: compilationResult,
            pipeline: pipelineResult,
            scopes: [
                { filter: 'validation', observation: validationResult },
                { filter: 'internal', observation: internalResult },
                { filter: 'out-of-memory', observation: oomResult },
            ],
        })
    })
}

function settlePipelineCreationIssue(input: {
    input: PipelineCreationIssueInput
    shaderModule?: GPUShaderModule
    pipelineLayout?: GPUPipelineLayout
    synchronousFailure?: Readonly<{
        stage: ScratchGpuIncidentFailureStage
        cause: unknown
    }>
    boundaryFailures: readonly unknown[]
    compilation: PromiseObservation<GPUCompilationInfo>
    pipeline: PromiseObservation<GPURenderPipeline | GPUComputePipeline>
    scopes: readonly ScopeObservation[]
}): PipelineCreationIssueResult {

    const failures: PipelineCreationObservedFailure[] = []
    const serializeNativeError = createPipelineNativeErrorSerializer(input.input.sourceSnapshot)
    let compilationReport: PipelineCompilationReport | undefined
    let nativePipeline: GPURenderPipeline | GPUComputePipeline | undefined

    if (input.synchronousFailure !== undefined) {
        failures.push(observedFailure(serializeNativeError,
            input.synchronousFailure.stage,
            'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
            'native-exception',
            input.synchronousFailure.cause
        ))
    }
    for (const cause of input.boundaryFailures) {
        failures.push(observedFailure(serializeNativeError,
            'scope-settlement',
            'SCRATCH_PIPELINE_CREATION_SCOPE_FAILED',
            'scope-failure',
            cause
        ))
    }

    if (input.compilation.status === 'fulfilled') {
        try {
            compilationReport = createPipelineCompilationReport({
                pipelineId: input.input.pipelineId,
                pipelineKind: input.input.pipelineKind,
                sourceSnapshot: input.input.sourceSnapshot,
                compilationInfo: input.compilation.value,
            })
            if (compilationReport.errorCount > 0) {
                failures.push(observedFailure(serializeNativeError,
                    'shader-compilation',
                    'SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED',
                    'none'
                ))
            }
        } catch (cause) {
            failures.push(observedFailure(serializeNativeError,
                'compilation-info',
                'SCRATCH_PIPELINE_CREATION_SCOPE_FAILED',
                'scope-failure',
                cause
            ))
        }
    } else if (input.compilation.status === 'rejected' || input.compilation.status === 'invalid') {
        failures.push(observedFailure(serializeNativeError,
            'compilation-info',
            'SCRATCH_PIPELINE_CREATION_SCOPE_FAILED',
            'scope-failure',
            input.compilation.reason
        ))
    }

    if (input.pipeline.status === 'fulfilled') {
        if (isNativePipeline(input.pipeline.value)) nativePipeline = input.pipeline.value
        else {
            failures.push(observedFailure(serializeNativeError,
                'pipeline-creation',
                'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
                'native-exception',
                new TypeError('Async pipeline creation resolved with an invalid object.')
            ))
        }
    } else if (input.pipeline.status === 'rejected') {
        const reason = pipelineErrorReason(input.pipeline.reason)
        failures.push(observedFailure(serializeNativeError,
            'pipeline-creation',
            reason === 'validation'
                ? 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED'
                : reason === 'internal'
                    ? 'SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED'
                    : 'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
            reason ?? 'native-exception',
            input.pipeline.reason,
            reason
        ))
    } else if (input.pipeline.status === 'invalid') {
        failures.push(observedFailure(serializeNativeError,
            'pipeline-creation',
            'SCRATCH_PIPELINE_CREATION_NATIVE_FAILED',
            'native-exception',
            input.pipeline.reason
        ))
    }

    for (const scope of input.scopes) {
        const observation = scope.observation
        if (observation.status === 'fulfilled') {
            if (observation.value === null) continue
            if (!isGpuError(observation.value)) {
                failures.push(observedFailure(serializeNativeError,
                    'scope-settlement',
                    'SCRATCH_PIPELINE_CREATION_SCOPE_FAILED',
                    'scope-failure',
                    new TypeError(`The ${scope.filter} error scope resolved with an invalid value.`)
                ))
                continue
            }
            failures.push(observedFailure(serializeNativeError,
                'supporting-object-creation',
                'SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED',
                scope.filter,
                observation.value
            ))
        } else if (observation.status === 'rejected' || observation.status === 'invalid') {
            failures.push(observedFailure(serializeNativeError,
                'scope-settlement',
                'SCRATCH_PIPELINE_CREATION_SCOPE_FAILED',
                'scope-failure',
                observation.reason
            ))
        }
    }

    failures.sort((left, right) =>
        stageOrder[left.outcome.stage] - stageOrder[right.outcome.stage]
    )
    return Object.freeze({
        ...(input.shaderModule !== undefined ? { shaderModule: input.shaderModule } : {}),
        ...(input.pipelineLayout !== undefined ? { pipelineLayout: input.pipelineLayout } : {}),
        ...(nativePipeline !== undefined ? { nativePipeline } : {}),
        ...(compilationReport !== undefined ? { compilationReport } : {}),
        failures: Object.freeze(failures),
    })
}

function popScope(
    device: GPUDevice,
    pushed: boolean,
    filter: ScopeFilter
): PendingScopeObservation {

    if (!pushed) return Object.freeze({
        filter,
        observation: notIssued<GPUError | null>(),
    })
    try {
        return Object.freeze({
            filter,
            observation: observePromise<GPUError | null>(
                device.popErrorScope(),
                'GPUDevice.popErrorScope()'
            ),
        })
    } catch (reason) {
        return Object.freeze({
            filter,
            observation: Promise.resolve(Object.freeze({
                status: 'rejected' as const,
                reason,
            })),
        })
    }
}

function observePromise<T>(value: unknown, name: string): Promise<PromiseObservation<T>> {

    if (!isObjectLike(value) || typeof (value as { then?: unknown }).then !== 'function') {
        return Promise.resolve(Object.freeze({
            status: 'invalid',
            reason: new TypeError(`${name} did not return a Promise.`),
        }))
    }
    return Promise.resolve(value as PromiseLike<T>).then(
        result => Object.freeze({ status: 'fulfilled', value: result }) as PromiseObservation<T>,
        reason => Object.freeze({ status: 'rejected', reason }) as PromiseObservation<T>
    )
}

function notIssued<T>(): Promise<PromiseObservation<T>> {

    return Promise.resolve(Object.freeze({ status: 'not-issued' }))
}

function observedFailure(
    serializeNativeError: ReturnType<typeof createPipelineNativeErrorSerializer>,
    stage: ScratchGpuIncidentFailureStage,
    diagnosticCode: string,
    nativeErrorCategory: GpuNativeErrorCategory,
    cause?: unknown,
    pipelineErrorReason?: GPUPipelineErrorReason
): PipelineCreationObservedFailure {

    return Object.freeze({
        outcome: Object.freeze({
            stage,
            diagnosticCode,
            nativeErrorCategory,
            ...(pipelineErrorReason !== undefined ? { pipelineErrorReason } : {}),
            ...(cause !== undefined ? { nativeError: serializeNativeError(cause) } : {}),
        }),
        ...(cause !== undefined ? { cause } : {}),
    })
}

function pipelineErrorReason(error: unknown): GPUPipelineErrorReason | undefined {

    if (!isObjectLike(error)) return undefined
    let name: unknown
    let message: unknown
    let reason: unknown
    try {
        name = (error as { name?: unknown }).name
        message = (error as { message?: unknown }).message
        reason = (error as { reason?: unknown }).reason
    } catch {
        return undefined
    }
    if (name !== 'GPUPipelineError' || typeof message !== 'string') return undefined
    return reason === 'validation' || reason === 'internal' ? reason : undefined
}

function isNativePipeline(value: unknown): value is GPURenderPipeline | GPUComputePipeline {

    if (!isObjectLike(value)) return false
    try {
        return typeof (value as { getBindGroupLayout?: unknown }).getBindGroupLayout === 'function'
    } catch {
        return false
    }
}

function isGpuError(value: unknown): value is GPUError {

    if (!isObjectLike(value)) return false
    try {
        return typeof (value as { message?: unknown }).message === 'string'
    } catch {
        return false
    }
}

function isObjectLike(value: unknown): value is object {

    return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function capitalize(value: string): string {

    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
