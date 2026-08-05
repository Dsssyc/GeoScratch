import type { BindLayout, BindSet } from './binding.js'
import type { ScratchRuntime } from './runtime.js'

const runtimeBindLayouts = new WeakMap<ScratchRuntime, Set<BindLayout>>()
const runtimeBindSets = new WeakMap<ScratchRuntime, Set<BindSet>>()

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

export function registerBindSetOwnership(bindSet: BindSet): void {

    let bindSets = runtimeBindSets.get(bindSet.runtime)
    if (bindSets === undefined) {
        bindSets = new Set()
        runtimeBindSets.set(bindSet.runtime, bindSets)
    }
    if (bindSets.has(bindSet)) throw new TypeError(`BindSet ${bindSet.id} is already registered.`)
    bindSets.add(bindSet)
}

export function unregisterBindSetOwnership(bindSet: BindSet): void {

    runtimeBindSets.get(bindSet.runtime)?.delete(bindSet)
}

export function runtimeBindSetSnapshot(runtime: ScratchRuntime): readonly BindSet[] {

    return Object.freeze([ ...(runtimeBindSets.get(runtime) ?? []) ])
}
