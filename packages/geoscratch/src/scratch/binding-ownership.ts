import type { BindLayout } from './binding.js'
import type { ScratchRuntime } from './runtime.js'

const runtimeBindLayouts = new WeakMap<ScratchRuntime, Set<BindLayout>>()

export function registerBindLayoutOwnership(layout: BindLayout): void {

    let layouts = runtimeBindLayouts.get(layout.runtime)
    if (layouts === undefined) {
        layouts = new Set()
        runtimeBindLayouts.set(layout.runtime, layouts)
    }
    if (layouts.has(layout)) throw new TypeError(`BindLayout ${layout.id} is already registered.`)
    layouts.add(layout)
}

export function unregisterBindLayoutOwnership(layout: BindLayout): void {

    runtimeBindLayouts.get(layout.runtime)?.delete(layout)
}

export function runtimeBindLayoutSnapshot(runtime: ScratchRuntime): readonly BindLayout[] {

    return Object.freeze([ ...(runtimeBindLayouts.get(runtime) ?? []) ])
}
