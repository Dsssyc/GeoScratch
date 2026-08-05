import type { RenderBundle } from './render-bundle.js'
import type { GPURuntime } from './runtime.js'

const runtimeRenderBundles = new WeakMap<GPURuntime, Set<RenderBundle>>()

export function registerRenderBundleOwnership(bundle: RenderBundle): void {

    let bundles = runtimeRenderBundles.get(bundle.runtime)
    if (bundles === undefined) {
        bundles = new Set()
        runtimeRenderBundles.set(bundle.runtime, bundles)
    }
    if (bundles.has(bundle)) {
        throw new TypeError(`RenderBundle ${bundle.id} is already registered.`)
    }
    bundles.add(bundle)
}

export function unregisterRenderBundleOwnership(bundle: RenderBundle): void {

    runtimeRenderBundles.get(bundle.runtime)?.delete(bundle)
}

export function runtimeRenderBundleSnapshot(runtime: GPURuntime): readonly RenderBundle[] {

    return Object.freeze([ ...(runtimeRenderBundles.get(runtime) ?? []) ])
}
