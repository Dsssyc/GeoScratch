import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

const debugCommandToken = Symbol('DebugCommand')
const debugCommandStates = new WeakMap<DebugCommand, { isDisposed: boolean }>()
const MAX_DIAGNOSTIC_LABEL_LENGTH = 256
const MAX_RETAINED_OPEN_COMMAND_IDS = 16

export type DebugCommandDescriptor =
    | Readonly<{
        action: 'push-group'
        label: string
    }>
    | Readonly<{
        action: 'pop-group'
        label?: never
    }>
    | Readonly<{
        action: 'insert-marker'
        label: string
    }>

export type DebugCommandAction = DebugCommandDescriptor['action']

export interface DebugCommand {
    readonly runtime: ScratchRuntime
    readonly id: string
    readonly commandKind: 'debug'
    readonly action: DebugCommandAction
    readonly label?: string
    readonly isDisposed: boolean
}

export class DebugCommand {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: DebugCommandDescriptor
    ) {

        if (token !== debugCommandToken || new.target !== DebugCommand) {
            throw new TypeError('DebugCommand must be created by ScratchRuntime.createDebugCommand().')
        }
        assertScratchRuntimeActive(runtime)
        const normalized = normalizeDebugCommandDescriptor(runtime, descriptor)
        debugCommandStates.set(this, { isDisposed: false })
        Object.defineProperties(this, {
            runtime: immutableEnumerable(runtime),
            id: immutableEnumerable(`scratch-debug-command-${UUID()}`),
            commandKind: immutableEnumerable('debug'),
            action: immutableEnumerable(normalized.action),
            ...(normalized.label !== undefined
                ? { label: immutableEnumerable(normalized.label) }
                : {}),
            isDisposed: {
                get: () => debugCommandStateFor(this).isDisposed,
                enumerable: true,
                configurable: false,
            },
        })
        Object.preventExtensions(this)
    }

    get subject(): DiagnosticSubject {

        return {
            kind: 'Command',
            id: this.id,
            commandKind: 'debug',
            action: this.action,
            ...(this.label !== undefined
                ? { label: boundedDiagnosticLabel(this.label) }
                : {}),
        }
    }

    assertRuntime(runtime: ScratchRuntime): void {

        this.assertUsable()
        if (runtime === this.runtime) return
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
            severity: 'error',
            phase: 'command',
            subject: this.subject,
            related: [ this.runtime.subject, runtime.subject ],
            message: 'DebugCommand belongs to a different ScratchRuntime.',
            expected: { runtimeId: this.runtime.id },
            actual: { runtimeId: runtime.id },
        })
    }

    assertUsable(): void {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'DebugCommand has been disposed.',
            })
        }
        assertScratchRuntimeActive(this.runtime)
    }

    encode(encoder: DebugCommandEncoder): void {

        this.assertUsable()
        try {
            if (this.action === 'push-group') {
                if (typeof encoder.pushDebugGroup !== 'function') {
                    return throwUnsupportedDebugCommand(this)
                }
                encoder.pushDebugGroup(this.label!)
                return
            }
            if (this.action === 'pop-group') {
                if (typeof encoder.popDebugGroup !== 'function') {
                    return throwUnsupportedDebugCommand(this)
                }
                encoder.popDebugGroup()
                return
            }
            if (typeof encoder.insertDebugMarker !== 'function') {
                return throwUnsupportedDebugCommand(this)
            }
            encoder.insertDebugMarker(this.label!)
        } catch (cause) {
            throwScratchDiagnostic({
                code: 'SCRATCH_DEBUG_COMMAND_NATIVE_FAILED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Native debug command encoding failed synchronously.',
                actual: {
                    action: this.action,
                    nativeErrorName: nativeErrorName(cause),
                },
            }, { cause })
        }
    }

    dispose(): void {

        debugCommandStateFor(this).isDisposed = true
    }
}

Object.freeze(DebugCommand.prototype)

export type DebugCommandEncoder = Readonly<{
    pushDebugGroup?: (label: string) => unknown
    popDebugGroup?: () => unknown
    insertDebugMarker?: (label: string) => unknown
}>

export function createDebugCommand(
    runtime: ScratchRuntime,
    descriptor: DebugCommandDescriptor
): DebugCommand {

    const Constructor = DebugCommand as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: DebugCommandDescriptor
    ) => DebugCommand
    return new Constructor(debugCommandToken, runtime, descriptor)
}

export function isDebugCommand(value: unknown): value is DebugCommand {

    return typeof value === 'object' && value !== null &&
        Object.getPrototypeOf(value) === DebugCommand.prototype &&
        debugCommandStates.has(value as DebugCommand)
}

export function validateBalancedDebugCommands(
    commands: readonly unknown[],
    subject: DiagnosticSubject,
    context: 'command-encoder' | 'render-pass' | 'compute-pass' | 'render-bundle'
): void {

    const stack: DebugCommand[] = []
    for (const command of commands) {
        if (!isDebugCommand(command)) continue
        command.assertUsable()
        if (command.action === 'push-group') {
            stack.push(command)
            continue
        }
        if (command.action !== 'pop-group') continue
        if (stack.length > 0) {
            stack.pop()
            continue
        }
        throwScratchDiagnostic({
            code: 'SCRATCH_DEBUG_GROUP_UNBALANCED',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            related: [ subject ],
            message: 'Debug group pop has no matching push in the same native encoder scope.',
            expected: { context, openGroupCountBeforePop: 'at least 1' },
            actual: { context, openGroupCountBeforePop: 0 },
        })
    }
    if (stack.length === 0) return
    const first = stack[0]!
    throwScratchDiagnostic({
        code: 'SCRATCH_DEBUG_GROUP_UNBALANCED',
        severity: 'error',
        phase: 'command',
        subject: first.subject,
        related: [ subject ],
        message: 'Debug group push is not closed in the same native encoder scope.',
        expected: { context, openGroupCountAtEnd: 0 },
        actual: {
            context,
            openGroupCountAtEnd: stack.length,
            openCommandIds: stack
                .slice(0, MAX_RETAINED_OPEN_COMMAND_IDS)
                .map(command => command.id),
            omittedOpenCommandCount: Math.max(
                0,
                stack.length - MAX_RETAINED_OPEN_COMMAND_IDS
            ),
        },
    })
}

function normalizeDebugCommandDescriptor(
    runtime: ScratchRuntime,
    descriptor: DebugCommandDescriptor
): DebugCommandDescriptor {

    if (!isRecord(descriptor)) return throwDebugDescriptorInvalid(runtime, descriptor)
    const action = descriptor.action
    if (
        action !== 'push-group' &&
        action !== 'pop-group' &&
        action !== 'insert-marker'
    ) {
        return throwDebugDescriptorInvalid(runtime, descriptor)
    }
    const label = descriptor.label
    if (action === 'pop-group') {
        if (label !== undefined) return throwDebugDescriptorInvalid(runtime, descriptor)
        return Object.freeze({ action })
    }
    if (typeof label !== 'string') return throwDebugDescriptorInvalid(runtime, descriptor)
    return Object.freeze({ action, label })
}

function throwDebugDescriptorInvalid(
    runtime: ScratchRuntime,
    descriptor: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_DEBUG_COMMAND_DESCRIPTOR_INVALID',
        severity: 'error',
        phase: 'command',
        subject: { kind: 'Command', commandKind: 'debug' },
        related: [ runtime.subject ],
        message: 'DebugCommand requires one exact debug action descriptor.',
        expected: {
            actions: [
                { action: 'push-group', label: 'string' },
                { action: 'pop-group' },
                { action: 'insert-marker', label: 'string' },
            ],
        },
        actual: { descriptor: describeValue(descriptor) },
    })
}

function throwUnsupportedDebugCommand(command: DebugCommand): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_DEBUG_COMMAND_UNSUPPORTED',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        message: 'Selected native encoder does not expose the requested debug command.',
        expected: { action: command.action, nativeMethod: nativeDebugMethod(command.action) },
        actual: { nativeMethod: 'unavailable' },
    })
}

function nativeDebugMethod(action: DebugCommandAction): string {

    if (action === 'push-group') return 'pushDebugGroup'
    if (action === 'pop-group') return 'popDebugGroup'
    return 'insertDebugMarker'
}

function debugCommandStateFor(command: DebugCommand): { isDisposed: boolean } {

    const state = debugCommandStates.get(command)
    if (state === undefined) throw new TypeError('DebugCommand state is unavailable.')
    return state
}

function immutableEnumerable(value: unknown): PropertyDescriptor {

    return {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
    }
}

function boundedDiagnosticLabel(label: string): string {

    return label.length <= MAX_DIAGNOSTIC_LABEL_LENGTH
        ? label
        : label.slice(0, MAX_DIAGNOSTIC_LABEL_LENGTH)
}

function nativeErrorName(value: unknown): string {

    return value instanceof Error ? value.name : typeof value
}
