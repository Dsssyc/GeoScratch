import { expect } from 'chai'
import { spawnSync } from 'node:child_process'

describe('default runtime boundary', () => {

    it('fails fast when getDevice is called before StartDash initializes WebGPU', () => {

        const script = "import getDevice from './packages/geoscratch/src/gpu/context/device.js'; try { getDevice(); process.exit(2); } catch (error) { if (!String(error.message).includes('StartDash')) process.exit(3); process.exit(0); }"
        const result = spawnSync(process.execPath, [ '--input-type=module', '--eval', script ], {
            cwd: process.cwd(),
            timeout: 1000,
        })

        expect(result.status).to.equal(0)
        expect(result.error).to.equal(undefined)
    })
})
