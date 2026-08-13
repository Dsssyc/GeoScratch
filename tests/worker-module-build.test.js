import { execFileSync, spawnSync } from 'node:child_process'
import {
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from 'chai'

const root = process.cwd()
const cli = path.join(root, 'packages', 'geoscratch', 'bin', 'geoscratch-worker.mjs')
const packageRoot = path.join(root, 'packages', 'geoscratch')

describe('framework-independent Worker module build', () => {

    it('builds TypeScript entries and a deterministic manifest without Vite', async() => {

        const fixture = mkdtempSync(path.join(tmpdir(), 'geoscratch-worker-build-'))
        try {
            mkdirSync(path.join(fixture, 'src'))
            mkdirSync(path.join(fixture, 'node_modules'))
            symlinkSync(packageRoot, path.join(fixture, 'node_modules', 'geoscratch'), 'dir')
            writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n')
            writeFileSync(path.join(fixture, 'worker-build.ts'), `
                import {
                    defineWorkerModuleBuild,
                    defineWorkerModuleContract,
                } from 'geoscratch/scratch'

                export const contract = defineWorkerModuleContract({
                    id: 'fixture.worker',
                    version: '1',
                })

                export default defineWorkerModuleBuild({
                    outDir: './public/workers',
                    modules: [ { contract, entry: './src/fixture.worker.ts' } ],
                })
            `)
            writeFileSync(path.join(fixture, 'src', 'fixture.worker.ts'), `
                import { defineWorkerModuleContract } from 'geoscratch/scratch'

                const contract = defineWorkerModuleContract({
                    id: 'fixture.worker',
                    version: '1',
                })

                export default contract.implement({
                    operations: {
                        double(input: { value: number }) {
                            return input.value * 2
                        },
                    },
                })
            `)

            const output = execFileSync(process.execPath, [
                cli,
                'build',
                '--config',
                './worker-build.ts',
            ], { cwd: fixture, encoding: 'utf8' })
            const manifest = JSON.parse(readFileSync(
                path.join(fixture, 'public', 'workers', 'manifest.json'),
                'utf8'
            ))
            const entry = manifest.modules[0]
            const workerPath = path.join(fixture, 'public', 'workers', entry.url)
            const workerSource = readFileSync(workerPath, 'utf8')
            const imported = await import(`${pathToFileURL(workerPath).href}?proof=1`)
            writeFileSync(path.join(fixture, 'public', 'workers', 'stale.js'), 'stale')
            const repeatedOutput = execFileSync(process.execPath, [
                cli,
                'build',
                '--config',
                './worker-build.ts',
            ], { cwd: fixture, encoding: 'utf8' })
            const repeatedManifest = JSON.parse(readFileSync(
                path.join(fixture, 'public', 'workers', 'manifest.json'),
                'utf8'
            ))

            expect(JSON.parse(output)).to.deep.include({
                schemaVersion: 1,
                moduleCount: 1,
                outDir: realpathSync(path.join(fixture, 'public', 'workers')),
            })
            expect(manifest).to.deep.include({
                kind: 'geoscratch-worker-module-manifest',
                schemaVersion: 1,
            })
            expect(entry).to.deep.include({ id: 'fixture.worker', version: '1' })
            expect(entry.url).to.match(/^\.\/fixture\.worker-[0-9a-f]{12}\.js$/)
            expect(entry.sha256).to.match(/^[0-9a-f]{64}$/)
            expect(entry.byteLength).to.equal(Buffer.byteLength(workerSource))
            expect(entry.byteLength).to.be.lessThan(20_000)
            expect(workerSource).to.not.match(/^\s*import\s/m)
            expect(imported.default).to.deep.include({ id: 'fixture.worker', version: '1' })
            expect(imported.default.operations.double({ value: 7 })).to.equal(14)
            expect(JSON.parse(repeatedOutput)).to.deep.include({ moduleCount: 1 })
            expect(repeatedManifest).to.deep.equal(manifest)
            expect(readdirSync(path.join(fixture, 'public', 'workers')).sort()).to.deep.equal([
                path.basename(entry.sourceMap.url),
                path.basename(entry.url),
                'manifest.json',
            ].sort())
        } finally {
            rmSync(fixture, { recursive: true, force: true })
        }
    })

    it('refuses output directories that could replace the project root', () => {

        const fixture = mkdtempSync(path.join(tmpdir(), 'geoscratch-worker-output-'))
        try {
            mkdirSync(path.join(fixture, 'src'))
            mkdirSync(path.join(fixture, 'node_modules'))
            symlinkSync(packageRoot, path.join(fixture, 'node_modules', 'geoscratch'), 'dir')
            writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n')
            writeFileSync(path.join(fixture, 'worker-build.ts'), `
                import {
                    defineWorkerModuleBuild,
                    defineWorkerModuleContract,
                } from 'geoscratch/scratch'

                const contract = defineWorkerModuleContract({ id: 'unsafe.worker', version: '1' })
                export default defineWorkerModuleBuild({
                    outDir: '.',
                    modules: [ { contract, entry: './src/unsafe.worker.ts' } ],
                })
            `)
            writeFileSync(path.join(fixture, 'src', 'unsafe.worker.ts'), `
                export default {
                    id: 'unsafe.worker',
                    version: '1',
                    operations: {},
                }
            `)

            const result = spawnSync(process.execPath, [
                cli,
                'build',
                '--config',
                './worker-build.ts',
            ], { cwd: fixture, encoding: 'utf8' })

            expect(result.status).to.not.equal(0)
            expect(result.stderr).to.include(
                'Worker module output must be a child directory of the command working directory.'
            )
            expect(readFileSync(path.join(fixture, 'package.json'), 'utf8'))
                .to.equal('{"type":"module"}\n')
        } finally {
            rmSync(fixture, { recursive: true, force: true })
        }
    })

    it('preserves an existing directory that is not owned build output', () => {

        const fixture = mkdtempSync(path.join(tmpdir(), 'geoscratch-worker-owned-output-'))
        try {
            mkdirSync(path.join(fixture, 'src'))
            mkdirSync(path.join(fixture, 'public', 'workers'), { recursive: true })
            mkdirSync(path.join(fixture, 'node_modules'))
            symlinkSync(packageRoot, path.join(fixture, 'node_modules', 'geoscratch'), 'dir')
            writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n')
            writeFileSync(path.join(fixture, 'public', 'workers', 'keep.txt'), 'do not delete')
            writeFileSync(path.join(fixture, 'worker-build.ts'), `
                import {
                    defineWorkerModuleBuild,
                    defineWorkerModuleContract,
                } from 'geoscratch/scratch'

                const contract = defineWorkerModuleContract({ id: 'safe.worker', version: '1' })
                export default defineWorkerModuleBuild({
                    outDir: './public/workers',
                    modules: [ { contract, entry: './src/safe.worker.ts' } ],
                })
            `)
            writeFileSync(path.join(fixture, 'src', 'safe.worker.ts'), `
                export default {
                    id: 'safe.worker',
                    version: '1',
                    operations: {},
                }
            `)

            const result = spawnSync(process.execPath, [
                cli,
                'build',
                '--config',
                './worker-build.ts',
            ], { cwd: fixture, encoding: 'utf8' })

            expect(result.status).to.not.equal(0)
            expect(result.stderr).to.include(
                'Worker module build refuses to replace a non-generated output directory.'
            )
            expect(readFileSync(
                path.join(fixture, 'public', 'workers', 'keep.txt'),
                'utf8'
            )).to.equal('do not delete')
        } finally {
            rmSync(fixture, { recursive: true, force: true })
        }
    })

    it('refuses output directories whose existing parent escapes through a symlink', () => {

        const fixture = mkdtempSync(path.join(tmpdir(), 'geoscratch-worker-symlink-output-'))
        const outside = mkdtempSync(path.join(tmpdir(), 'geoscratch-worker-outside-'))
        try {
            mkdirSync(path.join(fixture, 'src'))
            mkdirSync(path.join(fixture, 'node_modules'))
            symlinkSync(packageRoot, path.join(fixture, 'node_modules', 'geoscratch'), 'dir')
            symlinkSync(outside, path.join(fixture, 'public'), 'dir')
            writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n')
            writeFileSync(path.join(fixture, 'worker-build.ts'), `
                import {
                    defineWorkerModuleBuild,
                    defineWorkerModuleContract,
                } from 'geoscratch/scratch'

                const contract = defineWorkerModuleContract({ id: 'unsafe.worker', version: '1' })
                export default defineWorkerModuleBuild({
                    outDir: './public/workers',
                    modules: [ { contract, entry: './src/unsafe.worker.ts' } ],
                })
            `)
            writeFileSync(path.join(fixture, 'src', 'unsafe.worker.ts'), `
                export default {
                    id: 'unsafe.worker',
                    version: '1',
                    operations: {},
                }
            `)

            const result = spawnSync(process.execPath, [
                cli,
                'build',
                '--config',
                './worker-build.ts',
            ], { cwd: fixture, encoding: 'utf8' })

            expect(result.status).to.not.equal(0)
            expect(result.stderr).to.include(
                'Worker module output must resolve inside the command working directory.'
            )
            expect(readdirSync(outside)).to.deep.equal([])
        } finally {
            rmSync(fixture, { recursive: true, force: true })
            rmSync(outside, { recursive: true, force: true })
        }
    })
})
