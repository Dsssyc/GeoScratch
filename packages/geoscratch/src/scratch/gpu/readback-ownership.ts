import { throwGPUDiagnostic } from './diagnostics.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { ReadbackCommand } from './command.js'
import type { ReadbackOperation } from './readback.js'
import type { GPURuntime } from './runtime.js'
import type {
    GPURuntimeReadbackCommandFact,
    GPURuntimeReadbackOperationFact,
} from './runtime-diagnostics.js'

export type GPUReadbackOptions = Readonly<{
    maxPendingOperations?: number
    maxStagingBytes?: number
}>

export type GPUReadbackPolicy = Readonly<{
    maxPendingOperations: number
    maxStagingBytes: number
}>

const DEFAULT_MAX_PENDING_OPERATIONS = 16
const DEFAULT_MAX_STAGING_BYTES = 64 * 1024 * 1024
const runtimeReadbackCommands = new WeakMap<GPURuntime, Set<ReadbackCommand>>()
const runtimeReadbackOperations = new WeakMap<GPURuntime, Set<ReadbackOperation>>()

export function registerRuntimeReadbackCommand(
    runtime: GPURuntime,
    command: ReadbackCommand,
    fact: GPURuntimeReadbackCommandFact
): void {

    const commands = runtimeReadbackCommandSet(runtime)
    if (commands.has(command)) {
        throw new TypeError(`Readback command ${command.id} is already owned by its runtime.`)
    }
    diagnosticsControllerFor(runtime).registerReadbackCommand(fact)
    commands.add(command)
}

export function updateRuntimeReadbackCommand(
    runtime: GPURuntime,
    commandId: string,
    update: Partial<Omit<GPURuntimeReadbackCommandFact, 'id'>>
): void {

    diagnosticsControllerFor(runtime).updateReadbackCommand(commandId, update)
}

export function unregisterRuntimeReadbackCommand(
    runtime: GPURuntime,
    command: ReadbackCommand
): void {

    runtimeReadbackCommands.get(runtime)?.delete(command)
    diagnosticsControllerFor(runtime).unregisterReadbackCommand(command.id)
}

export function runtimeReadbackCommandSnapshot(runtime: GPURuntime): readonly ReadbackCommand[] {

    return Object.freeze([ ...(runtimeReadbackCommands.get(runtime) ?? []) ])
}

export function runtimeReadbackCommandCount(runtime: GPURuntime): number {

    return runtimeReadbackCommands.get(runtime)?.size ?? 0
}

export function registerRuntimeReadbackOperation(
    runtime: GPURuntime,
    operation: ReadbackOperation,
    fact: GPURuntimeReadbackOperationFact
): void {

    const operations = runtimeReadbackOperationSet(runtime)
    if (operations.has(operation)) {
        throw new TypeError(`Readback operation ${operation.id} is already owned by its runtime.`)
    }
    diagnosticsControllerFor(runtime).registerReadbackOperation(fact)
    operations.add(operation)
}

export function reserveRuntimeReadbackOperationFact(
    runtime: GPURuntime,
    fact: GPURuntimeReadbackOperationFact
): void {

    diagnosticsControllerFor(runtime).registerReadbackOperation(fact)
}

export function updateReservedRuntimeReadbackOperationFact(
    runtime: GPURuntime,
    readbackId: string,
    update: Partial<Omit<GPURuntimeReadbackOperationFact, 'id'>>
): void {

    diagnosticsControllerFor(runtime).updateReadbackOperation(readbackId, update)
}

export function releaseReservedRuntimeReadbackOperationFact(
    runtime: GPURuntime,
    readbackId: string
): void {

    diagnosticsControllerFor(runtime).unregisterReadbackOperation(readbackId)
}

export function adoptRuntimeReadbackOperation(
    runtime: GPURuntime,
    operation: ReadbackOperation
): void {

    const operations = runtimeReadbackOperationSet(runtime)
    if (operations.has(operation)) {
        throw new TypeError(`Readback operation ${operation.id} is already owned by its runtime.`)
    }
    operations.add(operation)
}

export function updateRuntimeReadbackOperation(
    runtime: GPURuntime,
    readbackId: string,
    update: Partial<Omit<GPURuntimeReadbackOperationFact, 'id'>>
): void {

    diagnosticsControllerFor(runtime).updateReadbackOperation(readbackId, update)
}

export function unregisterRuntimeReadbackOperation(
    runtime: GPURuntime,
    operation: ReadbackOperation
): void {

    runtimeReadbackOperations.get(runtime)?.delete(operation)
    diagnosticsControllerFor(runtime).unregisterReadbackOperation(operation.id)
}

export function runtimeReadbackOperationSnapshot(
    runtime: GPURuntime
): readonly ReadbackOperation[] {

    return Object.freeze([ ...(runtimeReadbackOperations.get(runtime) ?? []) ])
}

export function runtimeReadbackOperationCount(runtime: GPURuntime): number {

    return runtimeReadbackOperations.get(runtime)?.size ?? 0
}

export function normalizeScratchReadbackPolicy(
    options: GPUReadbackOptions | undefined,
    runtimeLabel?: string
): GPUReadbackPolicy {

    if (options !== undefined && (options === null || typeof options !== 'object')) {
        throwReadbackPolicyDiagnostic('readback', options, 'object')
    }

    return Object.freeze({
        maxPendingOperations: finitePositiveInteger(
            'maxPendingOperations',
            options?.maxPendingOperations,
            DEFAULT_MAX_PENDING_OPERATIONS,
            runtimeLabel
        ),
        maxStagingBytes: finitePositiveInteger(
            'maxStagingBytes',
            options?.maxStagingBytes,
            DEFAULT_MAX_STAGING_BYTES,
            runtimeLabel
        ),
    })
}

function finitePositiveInteger(
    name: string,
    value: unknown,
    fallback: number,
    runtimeLabel?: string
): number {

    if (value === undefined) return fallback
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    throwReadbackPolicyDiagnostic(name, value, 'positive safe integer', runtimeLabel)
}

function throwReadbackPolicyDiagnostic(
    name: string,
    value: unknown,
    expected: string,
    runtimeLabel?: string
): never {

    throwGPUDiagnostic({
        code: 'SCRATCH_READBACK_POLICY_INVALID',
        severity: 'error',
        phase: 'runtime',
        subject: {
            kind: 'GPURuntime',
            ...(runtimeLabel !== undefined ? { label: runtimeLabel } : {}),
        },
        message: `GPURuntime readback option ${name} is invalid.`,
        expected: { [name]: expected },
        actual: { [name]: value },
    })
}

function runtimeReadbackOperationSet(runtime: GPURuntime): Set<ReadbackOperation> {

    let operations = runtimeReadbackOperations.get(runtime)
    if (operations === undefined) {
        operations = new Set()
        runtimeReadbackOperations.set(runtime, operations)
    }
    return operations
}

function runtimeReadbackCommandSet(runtime: GPURuntime): Set<ReadbackCommand> {

    let commands = runtimeReadbackCommands.get(runtime)
    if (commands === undefined) {
        commands = new Set()
        runtimeReadbackCommands.set(runtime, commands)
    }
    return commands
}
