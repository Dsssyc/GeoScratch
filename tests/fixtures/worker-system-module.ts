import {
    defineWorkerModule,
    transferWorkerResult,
    type WorkerOperationContext,
} from 'geoscratch/scratch'

let transferredView: Uint8Array | undefined

export default defineWorkerModule({
    id: 'browser-worker-proof',
    version: '1',
    operations: {
        echo(input: { value: number }, context: WorkerOperationContext) {

            return { value: input.value, workerId: context.workerId }
        },
        async delay(input: { label: string, milliseconds: number }) {

            await sleep(input.milliseconds)
            return input.label
        },
        async cooperativeWait(_: null, context: WorkerOperationContext) {

            while (!context.signal.aborted) await sleep(4)
            throw abortError(context.signal.reason)
        },
        createTransfer() {

            transferredView = new Uint8Array([ 2, 7, 1, 8, 2, 8 ])
            const senderByteLengthBefore = transferredView.byteLength
            return transferWorkerResult({
                data: transferredView,
                senderByteLengthBefore,
            }, [ transferredView.buffer ])
        },
        transferredByteLength() {

            return transferredView?.byteLength ?? -1
        },
        fail() {

            const error = new Error('browser fixture remote failure') as Error & { code: string }
            error.name = 'BrowserFixtureError'
            error.code = 'BROWSER_FIXTURE_REMOTE'
            throw error
        },
        crash() {

            queueMicrotask(() => {
                throw new Error('intentional browser worker crash')
            })
            return new Promise<never>(() => undefined)
        },
    },
    context: {
        create(init: { value: number }) {

            return { value: init.value }
        },
        operations: {
            increment(state: { value: number }, input: { by: number }) {

                state.value += input.by
                return state.value
            },
        },
        snapshot(state: { value: number }) {

            return { value: state.value }
        },
        restore(snapshot: { value: number }) {

            return { value: snapshot.value }
        },
        dispose(state: { value: number }) {

            state.value = Number.NaN
        },
    },
})

function sleep(milliseconds: number): Promise<void> {

    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function abortError(reason: unknown): Error {

    const error = new Error(reason === undefined ? 'worker operation cancelled' : String(reason))
    error.name = 'AbortError'
    return error
}
