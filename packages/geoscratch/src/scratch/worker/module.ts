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

export type WorkerOperationProtocol<Input = never, Output = unknown> = Readonly<{
    input: Input
    output: Output
}>

export type WorkerOperationProtocolMap = Readonly<Record<
    string,
    WorkerOperationProtocol<unknown, unknown>
>>

export type WorkerNoOperations = Readonly<Record<never, never>>

export type WorkerOperationProtocolInput<
    Protocol extends WorkerOperationProtocol<unknown, unknown>
> =
    Protocol['input']

export type WorkerOperationProtocolOutput<
    Protocol extends WorkerOperationProtocol<unknown, unknown>
> =
    Protocol['output']

export type WorkerContextProtocol<
    Init = never,
    Operations extends WorkerOperationProtocolMap = WorkerOperationProtocolMap,
> = Readonly<{
    init: Init
    operations: Operations
}>

export type WorkerModuleProtocol<
    Operations extends WorkerOperationProtocolMap = WorkerOperationProtocolMap,
    Context extends WorkerContextProtocol<unknown, WorkerOperationProtocolMap> | undefined =
        WorkerContextProtocol<unknown, WorkerOperationProtocolMap> | undefined,
> = Readonly<{
    operations: Operations
    context: Context
}>

export type WorkerContextOperation<State = unknown, Input = never, Output = unknown> = (
    state: State,
    input: Input,
    context: WorkerOperationContext
) => WorkerMaybePromise<Output>

export type WorkerContextDefinition<
    State = unknown,
    Init = never,
    Snapshot = unknown,
    Operations extends Readonly<Record<string, WorkerContextOperation<State, never, unknown>>> =
        Readonly<Record<string, WorkerContextOperation<State, never, unknown>>>,
> = Readonly<{
    create(init: Init, context: WorkerOperationContext): WorkerMaybePromise<State>
    operations: Operations
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

export type WorkerModuleImplementation<
    Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>> =
        Readonly<Record<string, WorkerOperation<never, unknown>>>,
    Context extends WorkerContextDefinitionShape | undefined =
        WorkerContextDefinitionShape | undefined,
> = Readonly<{
    operations: Operations
    context?: Context
    reset?(): WorkerMaybePromise<void>
}>

export type WorkerModuleContractIdentity = Readonly<{
    kind: 'worker-module-contract'
    id: string
    version: string
}>

type InferredWorkerModuleContract = Readonly<{
    implement<
        const Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>>,
        const Context extends WorkerContextDefinitionShape | undefined,
    >(
        implementation: WorkerModuleImplementation<Operations, Context>
    ): WorkerModuleDefinition<Operations, Context>
}>

type OperationImplementations<Operations extends WorkerOperationProtocolMap> = Readonly<{
    [Name in keyof Operations]: Operations[Name] extends WorkerOperationProtocol<
        infer Input,
        infer Output
    > ? WorkerOperation<Input, WorkerOperationResult<Output>> : never
}>

type ContextOperationImplementations<
    State,
    Operations extends WorkerOperationProtocolMap,
> = Readonly<{
    [Name in keyof Operations]: Operations[Name] extends WorkerOperationProtocol<
        infer Input,
        infer Output
    > ? WorkerContextOperation<State, Input, WorkerOperationResult<Output>> : never
}>

type WorkerOperationResult<Output> = Output | WorkerTransferResult<Output>

type DeclaredWorkerModuleContract<Protocol extends WorkerModuleProtocol> =
    Protocol['context'] extends WorkerContextProtocol<infer Init, infer ContextOperations>
        ? Readonly<{
            implement<State, Snapshot = State>(implementation: WorkerModuleImplementation<
                OperationImplementations<Protocol['operations']>,
                WorkerContextDefinition<
                    State,
                    Init,
                    Snapshot,
                    ContextOperationImplementations<State, ContextOperations>
                >
            >): WorkerModuleDefinition<
                OperationImplementations<Protocol['operations']>,
                WorkerContextDefinition<
                    State,
                    Init,
                    Snapshot,
                    ContextOperationImplementations<State, ContextOperations>
                >
            >
        }>
        : Readonly<{
            implement(implementation: WorkerModuleImplementation<
                OperationImplementations<Protocol['operations']>,
                undefined
            >): WorkerModuleDefinition<
                OperationImplementations<Protocol['operations']>,
                undefined
            >
        }>

export type WorkerModuleContract<
    Protocol extends WorkerModuleProtocol | undefined = undefined,
> = WorkerModuleContractIdentity & (
    Protocol extends WorkerModuleProtocol
        ? DeclaredWorkerModuleContract<Protocol>
        : InferredWorkerModuleContract
)

export type WorkerTransferResult<T> = Readonly<{
    kind: 'worker-transfer-result'
    value: T
    transfer: readonly Transferable[]
}>

/** Validates and freezes one Worker implementation with optional retained context operations. */
export function defineWorkerModule<
    const Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>>,
    const Context extends WorkerContextDefinitionShape | undefined,
>(definition: WorkerModuleDefinition<Operations, Context>): WorkerModuleDefinition<Operations, Context> {

    if (!validWorkerModuleIdentity(definition.id, definition.version) ||
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

/** Creates a stable typed identity shared by Worker callers, implementations, and builds. */
export function defineWorkerModuleContract<
    Protocol extends WorkerModuleProtocol | undefined = undefined,
>(
    identity: Readonly<{ id: string, version: string }>
): WorkerModuleContract<Protocol> {

    if (identity === null || typeof identity !== 'object') {
        throw new TypeError('A Worker module identity requires a stable id and version.')
    }
    const id = identity.id
    const version = identity.version
    if (!validWorkerModuleIdentity(id, version)) {
        throw new TypeError('A Worker module identity requires a stable id and version.')
    }
    const contract = Object.freeze({
        kind: 'worker-module-contract',
        id,
        version,
        implement<
            const Operations extends Readonly<Record<string, WorkerOperation<never, unknown>>>,
            const Context extends WorkerContextDefinitionShape | undefined,
        >(
            implementation: WorkerModuleImplementation<Operations, Context>
        ): WorkerModuleDefinition<Operations, Context> {

            return defineWorkerModule({
                ...implementation,
                id,
                version,
            })
        },
    })
    return contract as unknown as WorkerModuleContract<Protocol>
}

/** Marks a Worker result and the unique transferable objects whose ownership moves with it. */
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

export function isWorkerModuleContract(value: unknown): value is WorkerModuleContractIdentity {

    return value !== null && typeof value === 'object' &&
        (value as { kind?: unknown }).kind === 'worker-module-contract' &&
        validWorkerModuleIdentity(
            (value as { id?: unknown }).id,
            (value as { version?: unknown }).version
        )
}

export function validWorkerModuleIdentity(id: unknown, version: unknown): boolean {

    return typeof id === 'string' && /^[A-Za-z][A-Za-z0-9._-]*$/.test(id) &&
        typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)
}
