import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** Owns dedicated child process groups, including grandchildren created by npm. */
export class DevProcesses {
    #records = new Set()

    start(command, args, options = {}) {
        const child = spawn(command, args, {
            stdio: 'inherit',
            ...options,
            detached: process.platform !== 'win32',
        })
        const record = { child, command, stopping: undefined }
        record.exited = new Promise(resolve => {
            child.once('error', error => resolve({ error }))
            child.once('exit', (code, signal) => resolve({ code, signal }))
        })
        this.#records.add(record)
        return record
    }

    stop(record) {
        record.stopping ??= this.#stop(record)
        return record.stopping
    }

    async #stop(record) {
        const signal = async name => {
            if (record.child.pid === undefined) return
            for (let attempt = 0; ; attempt++) {
                try {
                    if (process.platform === 'win32') record.child.kill(name)
                    else process.kill(-record.child.pid, name)
                    return
                } catch (error) {
                    if (error.code === 'ESRCH') return
                    // Darwin can retain a group whose last member is exiting,
                    // returning EPERM until reaping removes it. Do not swallow
                    // persistent permission errors or signal any broader scope.
                    if (process.platform !== 'darwin' || error.code !== 'EPERM' || attempt === 10) throw error
                    await delay(20)
                }
            }
        }
        await signal('SIGTERM')
        let timer
        try {
            await Promise.race([
                record.exited,
                new Promise(resolve => { timer = setTimeout(resolve, 3000) }),
            ])
            // A group leader can exit before its descendants. Reap the owned
            // group even when the leader has already acknowledged termination.
            await signal('SIGKILL')
            await record.exited
        } finally {
            clearTimeout(timer)
            this.#records.delete(record)
        }
    }

    async close() {
        const results = await Promise.allSettled([...this.#records].map(record => this.stop(record)))
        const failures = results.filter(result => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason))
    }
}

/** Waits for child completion or cancellation without retaining signal listeners. */
export function abortable(promise, signal) {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}
