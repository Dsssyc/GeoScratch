import type { WorkerModuleDescriptor } from './worker-system.js'

export type WorkerRemoteError = Readonly<{
    name: string
    message: string
    stack?: string
    code?: string
}>

export type WorkerInitializeMessage = Readonly<{
    kind: 'initialize'
    hostId: string
    groupId: string
    modules: readonly Readonly<Omit<WorkerModuleDescriptor, 'url'> & { url: string }>[]
}>

export type WorkerRunMessage = Readonly<{
    kind: 'run'
    task: Readonly<{
        id: string
        groupId: string
        moduleId: string
        moduleVersion: string
        operation: string
        input: unknown
        contextId?: string
        generation?: number
    }>
}>

export type WorkerCancelMessage = Readonly<{
    kind: 'cancel'
    taskId: string
    reason?: unknown
}>

export type WorkerContextOpenMessage = Readonly<{
    kind: 'context-open'
    requestId: string
    contextId: string
    groupId: string
    moduleId: string
    moduleVersion: string
    key: string
    init: unknown
    restore?: unknown
}>

export type WorkerContextSnapshotMessage = Readonly<{
    kind: 'context-snapshot'
    requestId: string
    contextId: string
}>

export type WorkerContextDisposeMessage = Readonly<{
    kind: 'context-dispose'
    requestId: string
    contextId: string
}>

export type WorkerResetMessage = Readonly<{
    kind: 'reset'
    requestId: string
}>

export type WorkerInboundMessage =
    | WorkerInitializeMessage
    | WorkerRunMessage
    | WorkerCancelMessage
    | WorkerContextOpenMessage
    | WorkerContextSnapshotMessage
    | WorkerContextDisposeMessage
    | WorkerResetMessage

export type WorkerControlInboundMessage =
    | WorkerContextOpenMessage
    | WorkerContextSnapshotMessage
    | WorkerContextDisposeMessage
    | WorkerResetMessage

export type WorkerReadyMessage = Readonly<{
    kind: 'ready'
    hostId: string
    modules: readonly Readonly<{ id: string, version: string }>[]
}>

export type WorkerInitializationErrorMessage = Readonly<{
    kind: 'initialization-error'
    hostId: string
    error: WorkerRemoteError
}>

export type WorkerTaskResultMessage = Readonly<{
    kind: 'task-result'
    taskId: string
    value: unknown
}>

export type WorkerTaskErrorMessage = Readonly<{
    kind: 'task-error'
    taskId: string
    cancelled: boolean
    error: WorkerRemoteError
}>

export type WorkerContextOpenedMessage = Readonly<{
    kind: 'context-opened'
    requestId: string
    contextId: string
}>

export type WorkerContextSnapshotResultMessage = Readonly<{
    kind: 'context-snapshot-result'
    requestId: string
    value: unknown
}>

export type WorkerContextDisposedMessage = Readonly<{
    kind: 'context-disposed'
    requestId: string
    contextId: string
}>

export type WorkerResetCompleteMessage = Readonly<{
    kind: 'reset-complete'
    requestId: string
}>

export type WorkerControlErrorMessage = Readonly<{
    kind: 'control-error'
    requestId: string
    error: WorkerRemoteError
}>

export type WorkerTaskOutboundMessage = WorkerTaskResultMessage | WorkerTaskErrorMessage

export type WorkerControlOutboundMessage =
    | WorkerContextOpenedMessage
    | WorkerContextSnapshotResultMessage
    | WorkerContextDisposedMessage
    | WorkerResetCompleteMessage
    | WorkerControlErrorMessage

export type WorkerOutboundMessage =
    | WorkerReadyMessage
    | WorkerInitializationErrorMessage
    | WorkerTaskOutboundMessage
    | WorkerControlOutboundMessage
