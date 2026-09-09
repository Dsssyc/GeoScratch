import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export function inspectFullFrameAnimation(bytes, { width, height, count, duration }) {
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid WebP container')
    let frames = 0
    let loop
    let canvas
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const tag = bytes.toString('ascii', offset, offset + 4)
        const size = bytes.readUInt32LE(offset + 4)
        const start = offset + 8
        if (start + size > bytes.length) throw new Error('Truncated WebP chunk')
        if (tag === 'VP8X' && size >= 10) canvas = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1]
        if (tag === 'ANIM' && size >= 6) loop = bytes.readUInt16LE(start + 4)
        if (tag === 'ANMF') {
            if (size < 16) throw new Error('Truncated animation frame')
            const x = bytes.readUIntLE(start, 3) * 2
            const y = bytes.readUIntLE(start + 3, 3) * 2
            const w = bytes.readUIntLE(start + 6, 3) + 1
            const h = bytes.readUIntLE(start + 9, 3) + 1
            const delay = bytes.readUIntLE(start + 12, 3)
            const flags = bytes[start + 15]
            if (x !== 0 || y !== 0 || w !== width || h !== height || flags !== 2) {
                throw new Error(`Frame ${frames} uses a cropped or blended update (${x},${y},${w},${h}; flags=${flags})`)
            }
            if (delay !== duration) throw new Error(`Frame ${frames} has incorrect duration`)
            frames++
        }
        offset = start + size + (size % 2)
    }
    if (canvas?.[0] !== width || canvas?.[1] !== height || loop !== 0 || frames !== count) {
        throw new Error('Incorrect animation dimensions, loop count, or frame count')
    }
    return { frames, durationMs: frames * duration, fullFrameReplacement: true }
}

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
    })
}

export async function encodeFullFrameAnimation(directory, output, options) {
    const paths = Array.from({ length: options.count }, (_, index) => join(directory, String(index).padStart(3, '0')))
    // Independent opaque frames prevent the dark bloom from being dropped by
    // lossy animation rectangle optimization. No frame depends on prior pixels.
    let next = 0
    const results = await Promise.allSettled(Array.from({ length: 4 }, async() => {
        while (next < paths.length) {
            const path = paths[next++]
            await run('cwebp', ['-quiet', '-q', '50', '-m', '4', `${path}.png`, '-o', `${path}.webp`])
        }
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    await run('webpmux', [
        ...paths.flatMap(path => ['-frame', `${path}.webp`, `+${options.duration}+0+0+0-b`]),
        '-loop', '0', '-bgcolor', '255,0,0,0', '-o', output,
    ])
    return inspectFullFrameAnimation(await readFile(output), options)
}
