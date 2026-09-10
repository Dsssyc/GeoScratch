import { expect } from 'chai'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DevProcesses, abortable } from '../scripts/dev-processes.mjs'

describe('examples development process ownership', function () {
    this.timeout(10_000)

    it('reports spawn errors and closes without hanging', async () => {
        const processes = new DevProcesses()
        const child = processes.start('/nonexistent/geoscratch-command', [], { stdio: 'ignore' })
        expect((await child.exited).error.code).to.equal('ENOENT')
        await processes.close()
    })

    it('reports nonzero exit and permits repeated cleanup', async () => {
        const processes = new DevProcesses()
        const child = processes.start(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' })
        expect((await child.exited).code).to.equal(7)
        await Promise.all([processes.close(), processes.close()])
    })

    it('cancels pending startup waits', async () => {
        const controller = new AbortController()
        const waiting = abortable(new Promise(() => {}), controller.signal)
        const error = new Error('stop startup')
        controller.abort(error)
        expect(await waiting.catch(value => value)).to.equal(error)
    })

    it('cleans descendants even when the group leader exits first', async function () {
        if (process.platform === 'win32') this.skip()
        const directory = await mkdtemp(join(tmpdir(), 'geoscratch-process-test-'))
        const pidFile = join(directory, 'pid')
        const processes = new DevProcesses()
        let descendant
        try {
            const child = processes.start(process.execPath, ['-e', `
                const { spawn } = require('node:child_process')
                const worker = spawn(process.execPath, ['-e',
                    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
                ], { stdio: 'ignore' })
                require('node:fs').writeFileSync(process.argv[1], String(worker.pid))
                worker.unref()
            `, pidFile], { stdio: 'ignore' })
            expect((await child.exited).code).to.equal(0)
            descendant = Number(await readFile(pidFile, 'utf8'))
            await processes.close()
            for (let attempt = 0; attempt < 100; attempt++) {
                try { process.kill(descendant, 0) } catch (error) {
                    expect(error.code).to.equal('ESRCH')
                    return
                }
                await delay(20)
            }
            throw new Error(`Descendant ${descendant} survived cleanup`)
        } finally {
            await processes.close()
            if (descendant) {
                try { process.kill(descendant, 'SIGKILL') } catch (error) {
                    if (error.code !== 'ESRCH') throw error
                }
            }
            await rm(directory, { recursive: true, force: true })
        }
    })
})
