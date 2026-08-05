export type WorkerMaybePromise<T> = T | PromiseLike<T>

export type WorkerOperationContext = Readonly<{
    signal: AbortSignal
    taskId: string
    workerId: string
    groupId: string
    moduleId: string
    moduleVersion: string
    operation: string
    generation?: number
}>

export type WorkerOperation<Input = never, Output = unknown> = (
    input: Input,
    context: WorkerOperationContext
) => WorkerMaybePromise<Output>

export type WorkerContextOperation<State = unknown, Input = never, Output = unknown> = (
    state: State,
    input: Input,
    context: WorkerOperationContext
) => WorkerMaybePromise<Output>

export type WorkerContextDefinition<State = unknown, Init = never, Snapshot = unknown> = Readonly<{
    create(init: Init, context: WorkerOperationContext): WorkerMaybePromise<State>
    operations: Readonly<Record<string, WorkerContextOperation<State, never, unknown>>>
    snapshot?(state: State): WorkerMaybePromise<Snapshot>
    restore?(snapshot: Snapshot, context: WorkerOperationContext): WorkerMaybePromise<State>
    dispose?(state: State): WorkerMaybePromise<void>
}>

type WorkerContextDefinitionShape = Readonly<{
    create(init: never, context: WorkerOperationContext): WorkerMaybePromise<unknown>
    operations: Readonly<Record<string, WorkerContextOperation<never, never, unknown>>>
    snapshot?(state: never): WorkerMaybePromise<unknown>
    restore?(snapshot: never, context: WorkerOperationContext): WorkerMaybePromise<unknown>
    dispose?(state: never): WorkerMaybePromise<void>
}>

export type WorkerModuleDefinition<
    Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>> =
        Readonly<Record<string, WorkerOperation<never, unknown>>>,
    Context extends WorkerContextDefinitionShape | undefined =
        WorkerContextDefinitionShape | undefined,
> = Readonly<{
    id: string
    version: string
    operations: Operations
    context?: Context
    reset?(): WorkerMaybePromise<void>
}>

export type WorkerTransferResult<T> = Readonly<{
    kind: 'worker-transfer-result'
    value: T
    transfer: readonly Transferable[]
}>

export function defineWorkerModule<
    const Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>>,
    const Context extends WorkerContextDefinitionShape | undefined,
>(definition: WorkerModuleDefinition<Operations, Context>): WorkerModuleDefinition<Operations, Context> {

    if (typeof definition.id !== 'string' || definition.id.length === 0 ||
        typeof definition.version !== 'string' || definition.version.length === 0 ||
        definition.operations === null || typeof definition.operations !== 'object') {
        throw new TypeError('A worker module requires a stable id, version, and operation map.')
    }
    for (const [ name, operation ] of Object.entries(definition.operations)) {
        if (!isOperationName(name) || typeof operation !== 'function') {
            throw new TypeError(`Worker module operation ${name} is invalid.`)
        }
    }
    if (definition.context !== undefined) {
        if (typeof definition.context.create !== 'function' ||
            definition.context.operations === null ||
            typeof definition.context.operations !== 'object') {
            throw new TypeError('A worker context requires create and operation contracts.')
        }
        for (const [ name, operation ] of Object.entries(definition.context.operations)) {
            if (!isOperationName(name) || typeof operation !== 'function') {
                throw new TypeError(`Worker context operation ${name} is invalid.`)
            }
        }
    }
    return Object.freeze({
        ...definition,
        operations: Object.freeze({ ...definition.operations }),
        ...(definition.context === undefined ? {} : {
            context: Object.freeze({
                ...definition.context,
                operations: Object.freeze({ ...definition.context.operations }),
            }) as Context,
        }),
    })
}

export function transferWorkerResult<T>(
    value: T,
    transfer: readonly Transferable[]
): WorkerTransferResult<T> {

    const seen = new Set<Transferable>()
    for (const item of transfer) {
        if (seen.has(item)) {
            throw new TypeError('Worker result transfer lists require unique transferable objects.')
        }
        seen.add(item)
    }
    return Object.freeze({
        kind: 'worker-transfer-result',
        value,
        transfer: Object.freeze([ ...transfer ]),
    })
}

export function isWorkerTransferResult(value: unknown): value is WorkerTransferResult<unknown> {

    return value !== null && typeof value === 'object' &&
        (value as { kind?: unknown }).kind === 'worker-transfer-result' &&
        Array.isArray((value as { transfer?: unknown }).transfer)
}

function isOperationName(value: string): boolean {

    return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value)
}
