export type WorkerDiagnosticSeverity = 'info' | 'warn' | 'error'

export type WorkerDiagnosticPhase =
    | 'worker-system'
    | 'worker-group'
    | 'worker-module'
    | 'worker-task'
    | 'worker-context'
    | 'worker-transfer'

export type WorkerDiagnosticCode =
    | 'WORKER_MODULE_LOAD_FAILED'
    | 'WORKER_OPERATION_NOT_FOUND'
    | 'WORKER_TASK_CANCELLED'
    | 'WORKER_TASK_FAILED'
    | 'WORKER_TASK_STALE'
    | 'WORKER_QUEUE_SATURATED'
    | 'WORKER_TERMINATED'
    | 'WORKER_CONTEXT_LOST'
    | 'WORKER_TRANSFER_INVALID'
    | 'WORKER_GROUP_DISPOSED'
    | 'WORKER_SYSTEM_DISPOSED'
    | 'WORKER_DESCRIPTOR_INVALID'

export type WorkerDiagnosticSubject = Readonly<{
    kind: 'WorkerSystem' | 'WorkerGroup' | 'WorkerHost' | 'WorkerModule' | 'WorkerTask' | 'WorkerContext'
    id: string
    label?: string
}>

export type WorkerCancellationKind = 'queued' | 'cooperative' | 'stale' | 'hard'

export type WorkerDiagnostic = Readonly<{
    version: 1
    code: WorkerDiagnosticCode
    severity: WorkerDiagnosticSeverity
    phase: WorkerDiagnosticPhase
    subject: WorkerDiagnosticSubject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    related?: readonly WorkerDiagnosticSubject[]
    groupId?: string
    workerId?: string
    moduleId?: string
    moduleVersion?: string
    operation?: string
    taskId?: string
    remoteStack?: string
    cancellationKind?: WorkerCancellationKind
    retriable?: boolean
}>

export type WorkerDiagnosticInput = Omit<WorkerDiagnostic, 'version'>

export class WorkerDiagnosticError extends Error {

    readonly diagnostic: WorkerDiagnostic

    constructor(diagnostic: WorkerDiagnostic, cause?: unknown) {

        super(diagnostic.message, cause === undefined ? undefined : { cause })
        this.name = 'WorkerDiagnosticError'
        this.diagnostic = diagnostic
    }
}

export function createWorkerDiagnostic(input: WorkerDiagnosticInput): WorkerDiagnostic {

    return freezeDiagnostic({ version: 1, ...input })
}

export function workerDiagnosticError(
    input: WorkerDiagnosticInput,
    cause?: unknown
): WorkerDiagnosticError {

    return new WorkerDiagnosticError(createWorkerDiagnostic(input), cause)
}

function freezeDiagnostic(input: WorkerDiagnostic): WorkerDiagnostic {

    const result: WorkerDiagnostic = {
        ...input,
        subject: Object.freeze({ ...input.subject }),
        ...(input.hints === undefined ? {} : { hints: Object.freeze([ ...input.hints ]) }),
        ...(input.related === undefined ? {} : {
            related: Object.freeze(input.related.map(subject => Object.freeze({ ...subject }))),
        }),
    }
    return Object.freeze(result)
}
