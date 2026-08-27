import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const flowLayerRoot = path.join(root, 'examples', 'flowLayer')
const flowFieldRoot = path.join(root, 'examples', 'flowField')

const frozen = Object.freeze({
    'flow-layer.ts': '39068eb9b6e1a2a2bdceecf4ddf1b11f5bbe3998db9901fafeb7bfac37c232fb',
    'flow-lifecycle.ts': '31b2bfde7db19c304f21cfb7be9db195cb6c575ff6d60ee5ae0bacbaee8e288a',
    'flow-map.ts': 'b7c1b1834fc486b7821d137943553180c689d3c2cf20939fef1a40b5ab2156fe',
    'flow-worker.ts': 'cd0e505e26009d7b5af7a7cfd8b3b75da749c4b8052d4016ffe5d909af086512',
    'index.html': 'd4b224e8bb706d21b074a8daf48f1f05c85d008941aae366d8f6db5169fc5a93',
    'main.ts': 'c4e15ee94a6c3f105d3317c88f8db154d515ce2fd82fdf05cbb84e18111e7f4c',
    'shaders/flow/arrow.wgsl': 'ffce4cf43b21f44ed6ff65c21b6d3694a0b98faf33d9ebe961649a26cd988547',
    'shaders/flow/flowLayer.wgsl': '225a94b8fe79c052264a1fcb81f96a7d4ebf36d384bf695645984f551c32382a',
    'shaders/flow/flowShow.wgsl': '9e515dcef0e7cff01e5a9f1828e3dff7561991abc3b54596f33c017b3544733a',
    'shaders/flow/flowVoronoi.wgsl': 'f8fae35c1a5fa35fdbddd8b5cc24f40a53d54877943efa63c7bd8f6e99e7826e',
    'shaders/flow/particles.wgsl': '315d1f806fe4326b28b524a78b4520a43ba5358a5210ff0aed6ad2291c85b715',
    'shaders/flow/simulation.compute.wgsl': 'aedf78a69868f2a3df565ee6f6f39851c975570bfb87449bedc9af5dd0a84748',
    'shaders/flow/swap.wgsl': 'a9f08a0a027e059076f11b3f68969241d74d34e56ac464b608bb931aa5220897',
})

const forbiddenFlowFieldFragments = Object.freeze([
    '../flowLayer',
    'examples/flowLayer',
    'packages/geoscratch/src',
    'runtime.device',
    'runtime.queue',
])

function collectFiles(directory) {

    if (!fs.existsSync(directory)) return []

    const files = []
    const visit = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolutePath = path.join(current, entry.name)
            if (entry.isDirectory()) {
                visit(absolutePath)
            } else {
                files.push(path.relative(directory, absolutePath).split(path.sep).join('/'))
            }
        }
    }
    visit(directory)
    return files.sort()
}

describe('Flow Field reference freeze', () => {

    it('keeps the Flow Layer reference byte-for-byte frozen', () => {

        const expectedFiles = Object.keys(frozen).sort()
        const actualFiles = collectFiles(flowLayerRoot)

        expect(actualFiles).to.deep.equal(expectedFiles)
        for (const [ relativePath, expectedHash ] of Object.entries(frozen)) {
            const absolutePath = path.join(flowLayerRoot, relativePath)
            expect(fs.lstatSync(absolutePath).isFile(), relativePath).to.equal(true)

            const actualHash = crypto.createHash('sha256')
                .update(fs.readFileSync(absolutePath))
                .digest('hex')
            expect(actualHash, relativePath).to.equal(expectedHash)
        }
    })

    it('keeps Flow Field independent of the reference and implementation internals', () => {

        const sourceFiles = collectFiles(flowFieldRoot)
            .filter(relativePath => /\.(?:ts|wgsl|html)$/.test(relativePath))

        for (const relativePath of sourceFiles) {
            const source = fs.readFileSync(path.join(flowFieldRoot, relativePath), 'utf8')
            for (const forbidden of forbiddenFlowFieldFragments) {
                expect(source, `${relativePath}: ${forbidden}`).to.not.include(forbidden)
            }
        }
    })
})
