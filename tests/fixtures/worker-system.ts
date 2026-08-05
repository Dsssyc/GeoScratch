import {
    WorkerDiagnosticError,
    WorkerSystem,
    type WorkerTaskHandle,
} from 'geoscratch/worker'

export async function runWorkerSystemProof() {

    const system = new WorkerSystem({
        maxWorkers: 1,
        maxHistory: 48,
        agingIntervalMs: 10,
    })
    const group = system.createGroup({
        id: 'browser-worker-proof-group',
        modules: [ {
            id: 'browser-worker-proof',
            version: '1',
            url: new URL('./worker-system-module.ts', import.meta.url),
        } ],
        isolation: 'group',
        size: { min: 0, max: 1 },
        maxQueuedTasks: 16,
        maxActiveTasks: 1,
        idleTimeoutMs: 25,
    })
    await group.ready

    try {
        const custom = await group.run<{ value: number }, { value: number, workerId: string }>({
            module: 'browser-worker-proof',
            operation: 'echo',
            input: { value: 42 },
        }).result

        const blocker = group.run<{ label: string, milliseconds: number }, string>({
            module: 'browser-worker-proof',
            operation: 'delay',
            input: { label: 'blocker', milliseconds: 80 },
        })
        await waitFor(() => blocker.inspect().state === 'running')
        const background = group.run<{ label: string, milliseconds: number }, string>({
            module: 'browser-worker-proof',
            operation: 'delay',
            input: { label: 'background', milliseconds: 1 },
            priority: { class: 'background', score: 0 },
        })
        const visible = group.run<{ label: string, milliseconds: number }, string>({
            module: 'browser-worker-proof',
            operation: 'delay',
            input: { label: 'visible', milliseconds: 1 },
            priority: { class: 'user-visible', score: 0 },
        })
        const completionOrder: string[] = []
        background.result.then(value => completionOrder.push(value))
        visible.result.then(value => completionOrder.push(value))
        const reprioritized = background.reprioritize({ class: 'critical', score: 10 })
        await Promise.all([ blocker.result, background.result, visible.result ])

        const cancelled = group.run<null, never>({
            module: 'browser-worker-proof',
            operation: 'cooperativeWait',
            input: null,
            cancellation: 'cooperative',
        })
        await waitFor(() => cancelled.inspect().state === 'running')
        const cancellationResult = cancelled.cancel('browser proof cancellation')
        const cancellation = await captureDiagnostic(cancelled)

        const remoteFailure = await captureDiagnostic(group.run({
            module: 'browser-worker-proof',
            operation: 'fail',
            input: null,
        }))

        const transfer = await group.run<null, {
            data: Uint8Array
            senderByteLengthBefore: number
        }>({
            module: 'browser-worker-proof',
            operation: 'createTransfer',
            input: null,
        }).result
        const senderByteLengthAfter = await group.run<null, number>({
            module: 'browser-worker-proof',
            operation: 'transferredByteLength',
            input: null,
        }).result

        const context = await group.openContext<{ value: number }, { value: number }>({
            module: 'browser-worker-proof',
            key: 'browser-document',
            init: { value: 3 },
        })
        const contextWorkerId = context.inspect().workerId
        const firstContextValue = await context.run<{ by: number }, number>(
            'increment',
            { by: 4 }
        ).result
        const secondContextValue = await context.run<{ by: number }, number>(
            'increment',
            { by: 5 }
        ).result
        const contextSnapshot = await context.snapshot<{ value: number }>()
        const contextAffinityStable = context.inspect().workerId === contextWorkerId
        await context.dispose()
        const reopened = await group.openContext<{ value: number }, { value: number }>({
            module: 'browser-worker-proof',
            key: 'browser-document',
            init: { value: 1 },
        })
        const reopenedValue = await reopened.run<{ by: number }, number>(
            'increment',
            { by: 1 }
        ).result
        await reopened.dispose()

        const crashing = group.run<null, never>({
            module: 'browser-worker-proof',
            operation: 'crash',
            input: null,
        })
        const crash = await captureDiagnostic(crashing)
        const recovered = await group.run<{ value: number }, { value: number, workerId: string }>({
            module: 'browser-worker-proof',
            operation: 'echo',
            input: { value: 9 },
        }).result

        await waitFor(() => group.inspect().workerCount === 0)
        const idleFacts = group.inspect()
        await group.dispose()
        await system.dispose()
        await system.dispose()
        const terminalSystem = system.inspect()
        const terminalGroup = group.inspect()

        return Object.freeze({
            custom,
            reprioritized,
            completionOrder,
            cancellationResult,
            cancellation,
            remoteFailure,
            transfer: {
                senderByteLengthBefore: transfer.senderByteLengthBefore,
                senderByteLengthAfter,
                receiverByteLength: transfer.data.byteLength,
                receiverData: [ ...transfer.data ],
            },
            context: {
                firstValue: firstContextValue,
                secondValue: secondContextValue,
                snapshot: contextSnapshot,
                affinityStable: contextAffinityStable,
                disposedState: context.inspect().state,
                reopenedValue,
                reopenedWorkerId: reopened.inspect().workerId,
            },
            crash,
            recovered,
            recoveredOnNewWorker: recovered.workerId !== custom.workerId,
            idleFacts,
            terminalSystem,
            terminalGroup,
        })
    } finally {
        await system.dispose()
    }
}

async function captureDiagnostic(task: WorkerTaskHandle<unknown>) {

    try {
        await task.result
        return { code: 'unexpected-success' }
    } catch (error) {
        if (!(error instanceof WorkerDiagnosticError)) throw error
        return error.diagnostic
    }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {

    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 4))
    }
    throw new Error('Timed out waiting for browser WorkerSystem state.')
}
