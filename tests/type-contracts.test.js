import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))
const readJson = (...parts) => JSON.parse(read(...parts))

describe('type contracts', () => {

    it('keeps the public API typecheck entrypoint wired', () => {

        expect(readJson('package.json').scripts.typecheck).to.equal('npm --workspace geoscratch run build && node node_modules/typescript/bin/tsc -p tsconfig.types.json && npm run typecheck:webgpu')
        expect(exists('tests', 'types', 'public-api.ts')).to.equal(true)
        expect(exists('tsconfig.webgpu-types.json')).to.equal(true)
    })

    it('builds the package through TypeScript into dist outputs', () => {

        const tsconfig = readJson('tsconfig.types.json')
        const buildConfig = readJson('packages', 'geoscratch', 'tsconfig.build.json')

        expect(tsconfig.compilerOptions.noEmit).to.equal(true)
        expect(buildConfig.compilerOptions.rootDir).to.equal('src')
        expect(buildConfig.compilerOptions.outDir).to.equal('dist')
        expect(buildConfig.compilerOptions.declaration).to.equal(true)
        expect(buildConfig.compilerOptions.allowJs).to.equal(true)
        expect(buildConfig.include).to.deep.equal([ 'src/**/*' ])
        expect(exists('packages', 'geoscratch', 'tsconfig.build.json')).to.equal(true)
    })
})
