export class ScriptedWorker {

    static instances = []

    constructor(options = {}) {

        this.options = options
        this.listeners = new Map()
        this.active = new Map()
        this.contexts = new Map()
        this.runOrder = []
        this.terminated = false
        this.hostId = undefined
        this.detachmentFacts = []
        ScriptedWorker.instances.push(this)
    }

    addEventListener(type, listener) {

        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    removeEventListener(type, listener) {

        this.listeners.get(type)?.delete(listener)
    }

    postMessage(message, transfer = []) {

        if (this.terminated) throw new Error('ScriptedWorker is terminated')
        const cloned = structuredClone(message, { transfer: [ ...transfer ] })
        queueMicrotask(() => this.process(cloned))
    }

    terminate() {

        this.terminated = true
        this.active.clear()
        this.contexts.clear()
    }

    process(message) {

        if (this.terminated) return
        if (message.kind === 'initialize') {
            this.hostId = message.hostId
            if (this.options.failInitialization === true) {
                this.emitMessage({
                    kind: 'initialization-error',
                    hostId: message.hostId,
                    error: {
                        name: 'TypeError',
                        message: 'fixture module fingerprint mismatch',
                        stack: 'remote initialization stack',
                        code: 'WORKER_MODULE_LOAD_FAILED',
                    },
                })
                return
            }
            this.emitMessage({
                kind: 'ready',
                hostId: message.hostId,
                modules: message.modules.map(module => ({
                    id: module.id,
                    version: module.version,
                })),
            })
            return
        }
        if (message.kind === 'cancel') {
            const active = this.active.get(message.taskId)
            if (active?.operation === 'cooperative') {
                this.active.delete(message.taskId)
                this.emitMessage({
                    kind: 'task-error',
                    taskId: message.taskId,
                    cancelled: true,
                    error: {
                        name: 'AbortError',
                        message: String(message.reason ?? 'cancelled'),
                        stack: 'remote cooperative stack',
                    },
                })
            }
            return
        }
        if (message.kind === 'run') {
            this.processRun(message)
            return
        }
        if (message.kind === 'context-open') {
            this.contexts.set(message.contextId, {
                value: Number(message.init?.value ?? 0),
                key: message.key,
            })
            this.emitMessage({
                kind: 'context-opened',
                requestId: message.requestId,
                contextId: message.contextId,
            })
            return
        }
        if (message.kind === 'context-snapshot') {
            const context = this.contexts.get(message.contextId)
            this.emitMessage({
                kind: 'context-snapshot-result',
                requestId: message.requestId,
                value: context === undefined ? undefined : { ...context },
            })
            return
        }
        if (message.kind === 'context-dispose') {
            this.contexts.delete(message.contextId)
            this.emitMessage({
                kind: 'context-disposed',
                requestId: message.requestId,
                contextId: message.contextId,
            })
            return
        }
        if (message.kind === 'reset') {
            this.contexts.clear()
            this.emitMessage({ kind: 'reset-complete', requestId: message.requestId })
        }
    }

    processRun(message) {

        const { task } = message
        this.runOrder.push(task.operation)
        const operation = this.options.operations?.[task.operation]
        if (operation !== undefined) {
            try {
                this.emitMessage({
                    kind: 'task-result',
                    taskId: task.id,
                    value: operation(task.input, this.contexts.get(task.contextId)),
                })
            } catch (error) {
                this.emitMessage({
                    kind: 'task-error',
                    taskId: task.id,
                    cancelled: false,
                    error: {
                        name: error.name ?? 'Error',
                        message: error.message ?? String(error),
                        stack: error.stack,
                        code: error.code,
                    },
                })
            }
            return
        }
        if (task.operation === 'hold' || task.operation === 'slow') {
            this.active.set(task.id, task)
            return
        }
        if (task.operation === 'cooperative') {
            this.active.set(task.id, task)
            return
        }
        if (task.operation === 'fail') {
            this.emitMessage({
                kind: 'task-error',
                taskId: task.id,
                cancelled: false,
                error: {
                    name: 'FixtureError',
                    message: 'remote fixture failed',
                    stack: 'remote fixture stack',
                    code: 'FIXTURE_REMOTE',
                },
            })
            return
        }
        if (task.operation === 'crash') {
            this.emitError(new Error('fixture worker crashed'))
            return
        }
        if (task.operation === 'increment') {
            const context = this.contexts.get(task.contextId)
            if (context === undefined) {
                this.emitMessage({
                    kind: 'task-error',
                    taskId: task.id,
                    cancelled: false,
                    error: { name: 'Error', message: 'context missing' },
                })
                return
            }
            context.value += Number(task.input?.by ?? 1)
            this.emitMessage({ kind: 'task-result', taskId: task.id, value: context.value })
            return
        }
        if (task.operation === 'transfer') {
            const data = new Uint8Array([ 3, 1, 4, 1, 5 ])
            const before = data.byteLength
            this.emitMessage({
                kind: 'task-result',
                taskId: task.id,
                value: { data, byteLengthBeforeTransfer: before },
            }, [ data.buffer ])
            this.detachmentFacts.push({ before, after: data.byteLength })
            return
        }
        this.emitMessage({ kind: 'task-result', taskId: task.id, value: task.input })
    }

    release(operation = 'hold', value = operation) {

        const entry = [ ...this.active.entries() ].find(([, task ]) => task.operation === operation)
        if (entry === undefined) throw new Error(`No active ${operation} task`)
        const [ taskId ] = entry
        this.active.delete(taskId)
        this.emitMessage({ kind: 'task-result', taskId, value })
    }

    emitMessage(data, transfer = []) {

        if (this.terminated) return
        const cloned = structuredClone(data, { transfer: [ ...transfer ] })
        queueMicrotask(() => {
            for (const listener of this.listeners.get('message') ?? []) listener({ data: cloned })
        })
    }

    emitError(error) {

        queueMicrotask(() => {
            const event = {
                message: error.message,
                error,
                filename: 'scripted-worker.js',
                lineno: 1,
                colno: 1,
                preventDefault() {},
            }
            for (const listener of this.listeners.get('error') ?? []) listener(event)
        })
    }
}

export function scriptedWorkerFactory(options = {}) {

    ScriptedWorker.instances.length = 0
    return () => new ScriptedWorker(options)
}

export function workerGroupOptions(overrides = {}) {

    return {
        id: 'fixture-group',
        modules: [ {
            id: 'fixture',
            version: '1',
            url: new URL('https://example.invalid/fixture-worker.js'),
        } ],
        isolation: 'group',
        size: { min: 1, max: 1 },
        maxQueuedTasks: 16,
        maxActiveTasks: 1,
        idleTimeoutMs: 5,
        ...overrides,
    }
}

export async function waitFor(predicate, timeoutMs = 1_000) {

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const value = predicate()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for worker test state')
}
