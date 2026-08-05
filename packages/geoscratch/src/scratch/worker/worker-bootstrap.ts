import type {
    WorkerContextDefinition,
    WorkerModuleDefinition,
    WorkerOperation,
    WorkerOperationContext,
    WorkerTransferResult,
} from './module.js'
import type {
    WorkerContextDisposeMessage,
    WorkerContextOpenMessage,
    WorkerContextSnapshotMessage,
    WorkerInboundMessage,
    WorkerOutboundMessage,
    WorkerRemoteError,
    WorkerRunMessage,
} from './protocol.js'

type LoadedModule = WorkerModuleDefinition<Readonly<Record<string, WorkerOperation<never, unknown>>>>

type ContextRecord = {
    id: string
    key: string
    module: LoadedModule
    definition: WorkerContextDefinition<unknown, never, unknown>
    state: unknown
}

type WorkerBootstrapScope = Readonly<{
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
    postMessage(message: unknown, transfer: Transferable[]): void
}>

const scope = globalThis as unknown as WorkerBootstrapScope
const modules = new Map<string, LoadedModule>()
const activeTasks = new Map<string, AbortController>()
const contexts = new Map<string, ContextRecord>()
let hostId = 'uninitialized'
let groupId = 'uninitialized'

scope.addEventListener('message', event => {
    void receive(event.data as WorkerInboundMessage)
})

async function receive(message: WorkerInboundMessage): Promise<void> {

    if (message.kind === 'initialize') {
        await initialize(message)
        return
    }
    if (message.kind === 'cancel') {
        activeTasks.get(message.taskId)?.abort(message.reason)
        return
    }
    if (message.kind === 'run') {
        void runTask(message)
        return
    }
    if (message.kind === 'context-open') {
        await openContext(message)
        return
    }
    if (message.kind === 'context-snapshot') {
        await snapshotContext(message)
        return
    }
    if (message.kind === 'context-dispose') {
        await disposeContext(message)
        return
    }
    if (message.kind === 'reset') await reset(message.requestId)
}

async function initialize(message: Extract<WorkerInboundMessage, { kind: 'initialize' }>): Promise<void> {

    hostId = message.hostId
    groupId = message.groupId
    try {
        for (const descriptor of message.modules) {
            const imported = await import(/* @vite-ignore */ descriptor.url) as Record<string, unknown>
            const candidate = imported.default ?? imported.workerModule
            if (!isModuleDefinition(candidate) || candidate.id !== descriptor.id ||
                candidate.version !== descriptor.version) {
                throw remoteCodeError(
                    'WORKER_MODULE_LOAD_FAILED',
                    `Worker module ${descriptor.id}@${descriptor.version} did not export its declared contract.`
                )
            }
            modules.set(descriptor.id, candidate)
        }
        post({
            kind: 'ready',
            hostId,
            modules: Object.freeze([ ...modules.values() ].map(module => Object.freeze({
                id: module.id,
                version: module.version,
            }))),
        })
    } catch (error) {
        post({
            kind: 'initialization-error',
            hostId,
            error: remoteError(error),
        })
    }
}

async function runTask(message: WorkerRunMessage): Promise<void> {

    const { task } = message
    const controller = new AbortController()
    activeTasks.set(task.id, controller)
    try {
        const module = requireModule(task.moduleId, task.moduleVersion)
        const operationContext = taskContext(task, controller.signal)
        let result: unknown
        if (task.contextId === undefined) {
            const operation = module.operations[task.operation]
            if (typeof operation !== 'function') {
                throw remoteCodeError(
                    'WORKER_OPERATION_NOT_FOUND',
                    `Worker operation ${task.moduleId}.${task.operation} is not defined.`
                )
            }
            result = await invokeOperation(operation, task.input, operationContext)
        } else {
            const context = contexts.get(task.contextId)
            if (context === undefined) {
                throw remoteCodeError('WORKER_CONTEXT_LOST', `Worker context ${task.contextId} is unavailable.`)
            }
            const operation = context.definition.operations[task.operation]
            if (typeof operation !== 'function') {
                throw remoteCodeError(
                    'WORKER_OPERATION_NOT_FOUND',
                    `Worker context operation ${task.moduleId}.${task.operation} is not defined.`
                )
            }
            const callable = operation as (
                state: unknown,
                input: unknown,
                context: WorkerOperationContext
            ) => unknown
            result = await callable(context.state, task.input, operationContext)
        }
        if (controller.signal.aborted) throw abortError(controller.signal.reason)
        if (isWorkerTransferResult(result)) {
            const transfer = validateTransferList(result.transfer)
            post({ kind: 'task-result', taskId: task.id, value: result.value }, transfer)
        } else {
            post({ kind: 'task-result', taskId: task.id, value: result })
        }
    } catch (error) {
        post({
            kind: 'task-error',
            taskId: task.id,
            cancelled: controller.signal.aborted || isAbortError(error),
            error: remoteError(error),
        })
    } finally {
        activeTasks.delete(task.id)
    }
}

async function openContext(message: WorkerContextOpenMessage): Promise<void> {

    try {
        if (contexts.has(message.contextId)) {
            throw remoteCodeError('WORKER_CONTEXT_LOST', `Worker context ${message.contextId} already exists.`)
        }
        const module = requireModule(message.moduleId, message.moduleVersion)
        const definition = module.context as WorkerContextDefinition<unknown, never, unknown> | undefined
        if (definition === undefined) {
            throw remoteCodeError(
                'WORKER_OPERATION_NOT_FOUND',
                `Worker module ${module.id} does not define stateful contexts.`
            )
        }
        const context = taskContext({
            id: message.requestId,
            groupId,
            moduleId: module.id,
            moduleVersion: module.version,
            operation: message.restore === undefined ? 'context.create' : 'context.restore',
        }, new AbortController().signal)
        const state = message.restore === undefined
            ? await definition.create(message.init as never, context)
            : definition.restore === undefined
                ? (() => { throw remoteCodeError(
                    'WORKER_OPERATION_NOT_FOUND',
                    `Worker module ${module.id} does not define context restore.`
                ) })()
                : await definition.restore(message.restore, context)
        contexts.set(message.contextId, {
            id: message.contextId,
            key: message.key,
            module,
            definition,
            state,
        })
        post({ kind: 'context-opened', requestId: message.requestId, contextId: message.contextId })
    } catch (error) {
        post({ kind: 'control-error', requestId: message.requestId, error: remoteError(error) })
    }
}

async function snapshotContext(message: WorkerContextSnapshotMessage): Promise<void> {

    try {
        const context = requireContext(message.contextId)
        if (context.definition.snapshot === undefined) {
            throw remoteCodeError(
                'WORKER_OPERATION_NOT_FOUND',
                `Worker context ${context.id} does not define snapshot.`
            )
        }
        const value = await context.definition.snapshot(context.state)
        post({ kind: 'context-snapshot-result', requestId: message.requestId, value })
    } catch (error) {
        post({ kind: 'control-error', requestId: message.requestId, error: remoteError(error) })
    }
}

async function disposeContext(message: WorkerContextDisposeMessage): Promise<void> {

    try {
        const context = requireContext(message.contextId)
        if (context.definition.dispose !== undefined) await context.definition.dispose(context.state)
        contexts.delete(message.contextId)
        post({ kind: 'context-disposed', requestId: message.requestId, contextId: message.contextId })
    } catch (error) {
        post({ kind: 'control-error', requestId: message.requestId, error: remoteError(error) })
    }
}

async function reset(requestId: string): Promise<void> {

    try {
        for (const context of contexts.values()) {
            if (context.definition.dispose !== undefined) await context.definition.dispose(context.state)
        }
        contexts.clear()
        for (const module of modules.values()) {
            if (module.reset !== undefined) await module.reset()
        }
        post({ kind: 'reset-complete', requestId })
    } catch (error) {
        post({ kind: 'control-error', requestId, error: remoteError(error) })
    }
}

function taskContext(
    task: Readonly<{
        id: string
        groupId: string
        moduleId: string
        moduleVersion: string
        operation: string
        generation?: number
    }>,
    signal: AbortSignal
): WorkerOperationContext {

    return Object.freeze({
        signal,
        taskId: task.id,
        workerId: hostId,
        groupId: task.groupId,
        moduleId: task.moduleId,
        moduleVersion: task.moduleVersion,
        operation: task.operation,
        ...(task.generation === undefined ? {} : { generation: task.generation }),
    })
}

function requireModule(id: string, version: string): LoadedModule {

    const module = modules.get(id)
    if (module === undefined || module.version !== version) {
        throw remoteCodeError(
            'WORKER_MODULE_LOAD_FAILED',
            `Worker module ${id}@${version} is not loaded on ${hostId}.`
        )
    }
    return module
}

function requireContext(id: string): ContextRecord {

    const context = contexts.get(id)
    if (context === undefined) {
        throw remoteCodeError('WORKER_CONTEXT_LOST', `Worker context ${id} is unavailable.`)
    }
    return context
}

async function invokeOperation(
    operation: WorkerOperation<never, unknown>,
    input: unknown,
    context: WorkerOperationContext
): Promise<unknown> {

    const callable = operation as WorkerOperation<unknown, unknown>
    return await callable(input, context)
}

function post(message: WorkerOutboundMessage, transfer: readonly Transferable[] = []): void {

    scope.postMessage(message, [ ...transfer ])
}

function validateTransferList(value: readonly Transferable[]): Transferable[] {

    const seen = new Set<Transferable>()
    const result: Transferable[] = []
    for (const item of value) {
        if (seen.has(item)) {
            throw remoteCodeError('WORKER_TRANSFER_INVALID', 'Worker result transfer list contains duplicates.')
        }
        seen.add(item)
        result.push(item)
    }
    return result
}

function isModuleDefinition(value: unknown): value is LoadedModule {

    return value !== null && typeof value === 'object' &&
        typeof (value as { id?: unknown }).id === 'string' &&
        typeof (value as { version?: unknown }).version === 'string' &&
        (value as { operations?: unknown }).operations !== null &&
        typeof (value as { operations?: unknown }).operations === 'object'
}

function isWorkerTransferResult(value: unknown): value is WorkerTransferResult<unknown> {

    return value !== null && typeof value === 'object' &&
        (value as { kind?: unknown }).kind === 'worker-transfer-result' &&
        Array.isArray((value as { transfer?: unknown }).transfer)
}

function remoteError(error: unknown): WorkerRemoteError {

    if (error instanceof Error) {
        const code = typeof (error as Error & { code?: unknown }).code === 'string'
            ? (error as Error & { code: string }).code
            : undefined
        return Object.freeze({
            name: error.name,
            message: error.message,
            ...(error.stack === undefined ? {} : { stack: error.stack }),
            ...(code === undefined ? {} : { code }),
        })
    }
    return Object.freeze({ name: 'Error', message: String(error) })
}

function remoteCodeError(code: string, message: string): Error {

    const error = new Error(message) as Error & { code: string }
    error.code = code
    return error
}

function abortError(reason: unknown): Error {

    const error = new Error(reason === undefined ? 'Worker task cancelled.' : String(reason))
    error.name = 'AbortError'
    return error
}

function isAbortError(error: unknown): boolean {

    return error instanceof Error && error.name === 'AbortError'
}
