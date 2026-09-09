import { strict as assert } from 'node:assert'
import { inspectFullFrameAnimation } from '../scripts/readme-webp.mjs'

const options = { width: 900, height: 480, count: 2, duration: 50 }

function chunk(tag, data) {
    const header = Buffer.alloc(8)
    header.write(tag)
    header.writeUInt32LE(data.length, 4)
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)])
}

function animation(overrides = {}) {
    const canvas = Buffer.alloc(10)
    canvas[0] = 2
    canvas.writeUIntLE(899, 4, 3)
    canvas.writeUIntLE(479, 7, 3)
    const loop = Buffer.alloc(6)
    loop.writeUInt16LE(overrides.loop ?? 0, 4)
    const frames = Array.from({ length: 2 }, (_, index) => {
        const values = index === 0 ? {} : overrides
        const frame = Buffer.alloc(16)
        frame.writeUIntLE((values.x ?? 0) / 2, 0, 3)
        frame.writeUIntLE((values.y ?? 0) / 2, 3, 3)
        frame.writeUIntLE((values.width ?? 900) - 1, 6, 3)
        frame.writeUIntLE((values.height ?? 480) - 1, 9, 3)
        frame.writeUIntLE(values.duration ?? 50, 12, 3)
        frame[15] = values.flags ?? 2
        return chunk('ANMF', frame)
    })
    const contents = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', canvas), chunk('ANIM', loop), ...frames])
    const riff = Buffer.alloc(8)
    riff.write('RIFF')
    riff.writeUInt32LE(contents.length, 4)
    return Buffer.concat([riff, contents])
}

describe('README animation frame coverage', () => {
    it('accepts opaque full-canvas replacement frames with preserved timing', () => {
        assert.deepEqual(inspectFullFrameAnimation(animation(), options), {
            frames: 2, durationMs: 100, fullFrameReplacement: true,
        })
    })

    it('rejects the cropped rectangle observed in the broken bloom frame 342', () => {
        // Actual ANMF geometry from the published animation, without storing
        // another large historical image fixture in Git.
        assert.throws(() => inspectFullFrameAnimation(animation({
            x: 478, y: 72, width: 342, height: 338, flags: 0,
        }), options), /cropped or blended update/)
    })

    it('requires no blending and no disposal', () => {
        for (const flags of [0, 1, 3]) {
            assert.throws(() => inspectFullFrameAnimation(animation({ flags }), options), /cropped or blended/)
        }
    })

    it('rejects altered frame durations, loop counts, or missing frames', () => {
        assert.throws(() => inspectFullFrameAnimation(animation({ duration: 100 }), options), /duration/)
        assert.throws(() => inspectFullFrameAnimation(animation({ loop: 1 }), options), /loop count/)
        assert.throws(() => inspectFullFrameAnimation(animation(), { ...options, count: 600 }), /frame count/)
    })

    it('rejects truncated containers', () => {
        assert.throws(() => inspectFullFrameAnimation(Buffer.alloc(3), options), /Invalid WebP/)
        assert.throws(() => inspectFullFrameAnimation(animation().subarray(0, -4), options), /Invalid WebP/)
    })
})
