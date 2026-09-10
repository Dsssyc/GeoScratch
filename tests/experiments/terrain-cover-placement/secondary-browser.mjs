import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const displayProbe = `
import AppKit
import CoreGraphics
import Foundation
var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)
let displays: [[String: Any]] = ids.map { id in
    let b = CGDisplayBounds(id)
    return ["id": id, "main": CGDisplayIsMain(id) != 0,
        "left": b.minX, "top": b.minY, "width": b.width, "height": b.height,
        "refreshHz": CGDisplayCopyDisplayMode(id)?.refreshRate ?? 0]
}
let facts: [String: Any] = ["displays": displays,
    "foregroundPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]
print(String(data: try! JSONSerialization.data(withJSONObject: facts), encoding: .utf8)!)
`

const focusProbe = `
import AppKit
import Foundation
func emit(_ pid: pid_t) { print(pid); fflush(stdout) }
let workspace = NSWorkspace.shared
let token = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
    object: nil, queue: .main) { event in
        if let app = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            emit(app.processIdentifier)
        }
    }
emit(workspace.frontmostApplication?.processIdentifier ?? 0)
RunLoop.main.run()
`

// Own exactly one temporary Chrome instance, with no foreground activation or
// new windows after placement. This is only for the single-page performance suite.
export async function launchSecondaryBrowser() {
    if (process.platform !== 'darwin') throw new Error('Secondary-display proof requires macOS')
    const before = probe()
    const display = before.displays.filter(d => !d.main && d.refreshHz >= 100 && d.width >= 1400 && d.height >= 980)
        .sort((a, b) => b.refreshHz - a.refreshHz)[0]
    if (!display || !before.foregroundPid) throw new Error('No verified high-refresh non-main display; use headless')
    const requested = { left: display.left + 32, top: display.top + 32, width: 1320, height: 920 }
    const profile = await mkdtemp(join(tmpdir(), 'terrain-secondary-chrome-'))
    let browser, protocol, focus, closed = false
    const ownedPids = () => execFileSync('ps', ['-axo', 'pid=,args=']).toString().split('\n')
        .filter(line => line.includes(`--user-data-dir=${profile}`)).map(line => Number(line.trim().split(/\s+/)[0]))
    async function close() {
        if (closed) return
        try {
            if (protocol && browser?.isConnected()) {
                try { await protocol.send('Browser.close') } catch { /* Closing disconnects CDP. */ }
            }
            for (let attempt = 0; attempt < 50 && ownedPids().length; attempt++) await delay(100)
            for (const pid of ownedPids()) {
                try { process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
            }
            for (let attempt = 0; attempt < 50 && ownedPids().length; attempt++) await delay(100)
            if (ownedPids().length) throw new Error('Owned secondary Chrome remained live')
            await rm(profile, { recursive: true, force: true })
            closed = true
        } finally {
            await focus?.stop()
        }
    }
    try {
        focus = await observeFocus()
        execFileSync('open', ['-g', '-n', '-a', '/Applications/Google Chrome.app', '--args',
            `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
            '--no-first-run', '--no-default-browser-check', '--disable-sync', '--enable-unsafe-webgpu',
            '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding', '--force-device-scale-factor=1',
            `--window-position=${requested.left},${requested.top}`,
            `--window-size=${requested.width},${requested.height}`, 'about:blank'])
        let port
        for (let attempt = 0; attempt < 150; attempt++) {
            try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break }
            catch { await delay(100) }
        }
        if (!Number.isInteger(port) || port <= 0) throw new Error('Dedicated Chrome did not publish a debug port')
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
        protocol = await browser.newBrowserCDPSession()
        const context = browser.contexts()[0], page = context?.pages()[0]
        if (!page || context.pages().length !== 1) throw new Error('Dedicated Chrome did not start with exactly one page')
        await page.setViewportSize({ width: 1280, height: 800 })
        const pageProtocol = await context.newCDPSession(page)
        const { targetInfo } = await pageProtocol.send('Target.getTargetInfo')
        const { bounds } = await protocol.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
        await pageProtocol.detach()
        if (!inside(bounds, display)) throw new Error(`Chrome window is outside the selected non-main display: ${JSON.stringify(bounds)}`)
        const after = probe()
        focus.assertActive()
        const own = new Set(ownedPids())
        if (focus.seen.some(pid => own.has(pid)) || own.has(after.foregroundPid))
            throw new Error('Dedicated Chrome became foreground; secondary proof aborted')
        const evidence = { display, requested, bounds, foregroundBefore: before.foregroundPid,
            foregroundAfter: after.foregroundPid, foregroundPreserved: true,
            foregroundChanges: focus.seen, closed: false }
        let contextTaken = false, pageTaken = false
        browser.newContext = async options => {
            if (contextTaken || options?.deviceScaleFactor !== 1) throw new Error('Secondary proof owns one DPR-1 context')
            contextTaken = true
            return context
        }
        context.newPage = async() => {
            if (pageTaken) throw new Error('Secondary proof owns one prepositioned page')
            pageTaken = true
            return page
        }
        browser.close = async() => { await close(); evidence.closed = true }
        return { browser, evidence, async verifyPlacement() {
            const { bounds: finalBounds } = await protocol.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
            const final = probe(), currentDisplay = final.displays.find(d => d.id === display.id)
            focus.assertActive()
            if (!currentDisplay || currentDisplay.main || !inside(finalBounds, currentDisplay) ||
                focus.seen.some(pid => own.has(pid)) || own.has(final.foregroundPid))
                throw new Error('Secondary placement or non-activation changed during proof')
            evidence.finalBounds = finalBounds
            evidence.foregroundAtEnd = final.foregroundPid
        } }
    } catch (error) {
        await close()
        throw error
    }
}

function probe() { return JSON.parse(execFileSync('swift', ['-e', displayProbe]).toString()) }
function inside(b, d) {
    return b.windowState === 'normal' && b.left >= d.left && b.top >= d.top &&
        b.left + b.width <= d.left + d.width && b.top + b.height <= d.top + d.height
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function observeFocus() {
    const child = spawn('swift', ['-e', focusProbe], { stdio: ['ignore', 'pipe', 'pipe'] })
    const seen = []
    let pending = '', errors = '', timer
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Foreground observer did not start')), 15_000)
            child.once('error', reject)
            child.once('exit', code => reject(new Error(`Foreground observer exited ${code}: ${errors}`)))
            child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-2048) })
            child.stdout.on('data', bytes => {
                pending += bytes
                let end
                while ((end = pending.indexOf('\n')) >= 0) {
                    const pid = Number(pending.slice(0, end))
                    pending = pending.slice(end + 1)
                    if (!Number.isInteger(pid) || pid <= 0) { reject(new Error('Invalid foreground process')); return }
                    if (seen.length < 128) seen.push(pid)
                    else { child.kill('SIGTERM'); return }
                    resolve()
                }
            })
        })
    } catch (error) { child.kill('SIGTERM'); throw error }
    finally { clearTimeout(timer) }
    return { seen, assertActive() {
        if (child.killed || child.exitCode !== null || child.signalCode !== null)
            throw new Error('Foreground observation stopped before verification')
    }, async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        await new Promise(resolve => child.once('exit', resolve))
    } }
}
