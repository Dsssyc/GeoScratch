import {
    ScratchDiagnosticError,
    createScratchDiagnostic,
    createScratchDiagnosticReport,
} from '../diagnostics/base.js'
import type {
    ScratchDiagnosticBase,
    ScratchDiagnosticSeverity,
} from '../diagnostics/base.js'
import type { WorkerRemoteErrorFacts } from './worker-system.js'

export type WorkerDiagnosticPhase =
    | 'worker-system'
    | 'worker-group'
    | 'worker-module'
    | 'worker-task'
    | 'worker-context'
    | 'worker-transfer'

export type WorkerDiagnosticCode =
    | 'WORKER_MODULE_LOAD_FAILED'
    | 'WORKER_MODULE_NOT_FOUND'
    | 'WORKER_MANIFEST_INVALID'
    | 'WORKER_MANIFEST_FETCH_FAILED'
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
    kind: 'WorkerSystem' | 'WorkerGroup' | 'WorkerHost' | 'WorkerModule' |
        'WorkerTask' | 'WorkerContext' | 'TaskPhaseBudget'
    id: string
    label?: string
}>

export type WorkerCancellationKind = 'queued' | 'cooperative' | 'stale' | 'hard'

type WorkerDiagnosticFacts = Readonly<{
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

export type WorkerDiagnostic = ScratchDiagnosticBase<
    'worker',
    WorkerDiagnosticCode,
    WorkerDiagnosticPhase,
    WorkerDiagnosticSubject
> & WorkerDiagnosticFacts

export type WorkerDiagnosticInput = Readonly<{
    code: WorkerDiagnosticCode
    severity: ScratchDiagnosticSeverity
    phase: WorkerDiagnosticPhase
    subject: WorkerDiagnosticSubject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    related?: readonly WorkerDiagnosticSubject[]
}> & WorkerDiagnosticFacts

export function workerDiagnosticError(
    input: WorkerDiagnosticInput,
    cause?: unknown
): ScratchDiagnosticError<WorkerDiagnostic> {

    const diagnostic = createWorkerDomainDiagnostic(input)
    const remote = workerRemoteFacts(input.actual)
    return new ScratchDiagnosticError(
        diagnostic,
        createScratchDiagnosticReport([ diagnostic ]),
        {
            ...(cause === undefined ? {} : { cause }),
            context: {
                domain: 'worker',
                ...(remote === undefined ? {} : { remote }),
            },
        }
    )
}

function createWorkerDomainDiagnostic(input: WorkerDiagnosticInput): WorkerDiagnostic {

    const base = createScratchDiagnostic({
        domain: 'worker',
        code: input.code,
        severity: input.severity,
        phase: input.phase,
        subject: input.subject,
        message: input.message,
        ...(input.expected === undefined ? {} : { expected: input.expected }),
        ...(input.actual === undefined ? {} : { actual: input.actual }),
        ...(input.hints === undefined ? {} : { hints: input.hints }),
        ...(input.related === undefined ? {} : { related: input.related }),
    })
    const facts: WorkerDiagnosticFacts = {
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
        ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
        ...(input.moduleVersion === undefined ? {} : { moduleVersion: input.moduleVersion }),
        ...(input.operation === undefined ? {} : { operation: input.operation }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.remoteStack === undefined ? {} : { remoteStack: input.remoteStack }),
        ...(input.cancellationKind === undefined ? {} : {
            cancellationKind: input.cancellationKind,
        }),
        ...(input.retriable === undefined ? {} : { retriable: input.retriable }),
    }

    return Object.freeze({ ...base, ...facts })
}

function workerRemoteFacts(actual: unknown): WorkerRemoteErrorFacts | undefined {

    if (typeof actual !== 'object' || actual === null) return undefined
    const candidate = actual as Partial<WorkerRemoteErrorFacts>
    if (typeof candidate.remoteName !== 'string' || typeof candidate.remoteMessage !== 'string') {
        return undefined
    }
    return Object.freeze({
        remoteName: candidate.remoteName,
        remoteMessage: candidate.remoteMessage,
        ...(typeof candidate.remoteCode === 'string' ? { remoteCode: candidate.remoteCode } : {}),
    })
}
