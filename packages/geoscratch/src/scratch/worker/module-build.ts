import type { WorkerModuleContract } from './module.js'
import { isWorkerModuleContract } from './module.js'

export type WorkerModuleBuildEntry = Readonly<{
    contract: WorkerModuleContract
    entry: string
}>

export type WorkerModuleBuild = Readonly<{
    kind: 'worker-module-build'
    outDir: string
    modules: readonly WorkerModuleBuildEntry[]
}>

/** Validates a bundler-independent set of typed Worker module source entries. */
export function defineWorkerModuleBuild(
    descriptor: Readonly<{
        outDir: string
        modules: readonly WorkerModuleBuildEntry[]
    }>
): WorkerModuleBuild {

    if (typeof descriptor.outDir !== 'string' || descriptor.outDir.length === 0 ||
        !Array.isArray(descriptor.modules) || descriptor.modules.length === 0) {
        throw new TypeError('A Worker module build requires an output directory and modules.')
    }
    const identities = new Set<string>()
    const modules = descriptor.modules.map(module => {
        if (!isWorkerModuleContract(module?.contract) ||
            typeof module.entry !== 'string' || module.entry.length === 0) {
            throw new TypeError('A Worker module build entry requires a contract and source entry.')
        }
        const key = `${module.contract.id}\u0000${module.contract.version}`
        if (identities.has(key)) {
            throw new TypeError(`Worker module build identity ${module.contract.id}@${module.contract.version} is duplicated.`)
        }
        identities.add(key)
        return Object.freeze({ contract: module.contract, entry: module.entry })
    })
    return Object.freeze({
        kind: 'worker-module-build',
        outDir: descriptor.outDir,
        modules: Object.freeze(modules),
    })
}
