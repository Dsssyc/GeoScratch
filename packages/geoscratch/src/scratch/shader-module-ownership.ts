import type { ScratchRuntime } from './runtime.js'
import type { ShaderModule } from './shader-module.js'

const runtimeShaderModules = new WeakMap<ScratchRuntime, Set<ShaderModule>>()

export function registerShaderModuleOwnership(shaderModule: ShaderModule): void {

    let modules = runtimeShaderModules.get(shaderModule.runtime)
    if (modules === undefined) {
        modules = new Set()
        runtimeShaderModules.set(shaderModule.runtime, modules)
    }
    if (modules.has(shaderModule)) {
        throw new TypeError(`ShaderModule ${shaderModule.id} is already registered.`)
    }
    modules.add(shaderModule)
}

export function unregisterShaderModuleOwnership(shaderModule: ShaderModule): void {

    runtimeShaderModules.get(shaderModule.runtime)?.delete(shaderModule)
}

export function runtimeShaderModuleSnapshot(
    runtime: ScratchRuntime
): readonly ShaderModule[] {

    return Object.freeze([ ...(runtimeShaderModules.get(runtime) ?? []) ])
}
