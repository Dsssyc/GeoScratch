import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import backendConfig from '../examples/backend/config.json' with { type: 'json' }
import { DevProcesses, abortable } from './dev-processes.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [mode = 'all', ...args] = process.argv.slice(2)
const processes = new DevProcesses()
const controller = new AbortController()
const { signal } = controller
const interrupt = () => controller.abort(new Error('Development stopped'))
const stopSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const name of stopSignals) process.on(name, interrupt)

try {
    if (!['all', 'frontend', 'backend', 'preview'].includes(mode)) {
        throw new Error(`Unknown development mode: ${mode}`)
    }
    const port = Number(process.env.EXAMPLES_BACKEND_PORT ?? backendConfig.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('EXAMPLES_BACKEND_PORT must be an integer from 1 to 65535')
    }
    const backendUrl = `http://${backendConfig.host}:${port}`
    const backendEntry = resolve(root, 'examples/backend/.venv/bin/examples-backend')
    if (mode !== 'frontend') {
        try { await access(backendEntry, constants.X_OK) } catch {
            throw new Error('Examples backend is not installed. Run npm run backend:setup first.')
        }
        await assertAvailablePort(backendConfig.host, port)
    }

    if (mode === 'all' || mode === 'frontend') {
        await runStep(['--workspace', 'geoscratch', 'run', 'build'])
        await runStep(['--workspace', 'examples', 'run', 'workers:build'])
    }

    const services = []
    if (mode !== 'frontend') {
        signal.throwIfAborted()
        const backendArgs = ['--host', backendConfig.host, '--port', String(port)]
        for (const [name, option] of [
            ['EXAMPLES_DEM_OUTPUT', '--dem-output'],
            ['EXAMPLES_FLOW_OUTPUT', '--flow-output'],
        ]) {
            if (process.env[name]) backendArgs.push(option, process.env[name])
        }
        // All/preview arguments belong to Vite; backend-only arguments select
        // dataset inputs without allowing a second, hidden port authority.
        if (mode === 'backend') {
            if (args.some(arg => /^--(?:host|port)(?:=|$)/.test(arg))) {
                throw new Error('Set EXAMPLES_BACKEND_PORT to configure the backend port.')
            }
            backendArgs.push(...args)
        }
        const backend = processes.start(backendEntry, backendArgs, { cwd: root })
        services.push(backend)
        const health = await waitForBackend(backend, backendUrl)
        console.log(`[examples] Backend ${backendUrl}: ${Object.entries(health.modules)
            .map(([name, value]) => `${name}=${value.status}`).join(', ')}`)
    }
    if (mode !== 'backend') {
        signal.throwIfAborted()
        services.push(processes.start(process.execPath, [
            resolve(root, 'node_modules/vite/bin/vite.js'),
            ...(mode === 'preview' ? ['preview'] : []),
            ...args,
        ], { cwd: resolve(root, 'examples') }))
    }
    const result = await abortable(Promise.race(services.map(service => service.exited)), signal)
    throw result.error ?? new Error(`A development service exited (${result.signal ?? result.code}).`)
} catch (error) {
    if (!signal.aborted) {
        console.error(`[examples] ${error.message}`)
        process.exitCode = 1
    }
} finally {
    try { await processes.close() } catch (error) {
        console.error('[examples] Could not clean up development processes:', error)
        process.exitCode = 1
    }
    for (const name of stopSignals) process.off(name, interrupt)
}

async function runStep(args) {
    signal.throwIfAborted()
    const npm = process.env.npm_execpath
    const child = npm
        ? processes.start(process.execPath, [npm, ...args], { cwd: root })
        : processes.start('npm', args, { cwd: root })
    try {
        const result = await abortable(child.exited, signal)
        if (result.error || result.code !== 0) {
            throw result.error ?? new Error(`npm ${args.join(' ')} failed (${result.signal ?? result.code}).`)
        }
    } finally {
        await processes.stop(child)
    }
}

async function waitForBackend(backend, url) {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
        signal.throwIfAborted()
        if (backend.child.pid === undefined || backend.child.exitCode !== null || backend.child.signalCode !== null) {
            const result = await backend.exited
            throw result.error ?? new Error(`Backend exited (${result.signal ?? result.code}).`)
        }
        try {
            const response = await fetch(`${url}/api/health`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
            })
            const health = await response.json()
            if (response.ok && health.service === 'geoscratch-examples-backend'
                && health.pid === backend.child.pid) return health
        } catch {
            signal.throwIfAborted()
        }
        await delay(100, undefined, { signal })
    }
    throw new Error(`Backend startup timed out: ${url}`)
}

async function assertAvailablePort(host, port) {
    await new Promise((resolveReady, reject) => {
        const probe = createServer()
        probe.once('error', error => reject(new Error(
            `Backend port ${host}:${port} is unavailable (${error.code}). `
            + 'Set EXAMPLES_BACKEND_PORT to a free port; existing processes are left running.'
        )))
        probe.listen({ host, port, exclusive: true }, () => probe.close(resolveReady))
    })
}
