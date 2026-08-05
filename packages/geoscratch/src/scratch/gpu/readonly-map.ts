class ReadonlyMapSnapshot<Key, Value> implements ReadonlyMap<Key, Value> {

    readonly #entries: Map<Key, Value>

    constructor(entries: ReadonlyMap<Key, Value>) {

        this.#entries = new Map(entries)
    }

    get size(): number {

        return this.#entries.size
    }

    get(key: Key): Value | undefined {

        return this.#entries.get(key)
    }

    has(key: Key): boolean {

        return this.#entries.has(key)
    }

    forEach(
        callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
        thisArg?: unknown
    ): void {

        for (const [ key, value ] of this.#entries) callback.call(thisArg, value, key, this)
    }

    entries() {

        return this.#entries.entries()
    }

    keys() {

        return this.#entries.keys()
    }

    values() {

        return this.#entries.values()
    }

    [Symbol.iterator]() {

        return this.#entries[Symbol.iterator]()
    }
}

Object.freeze(ReadonlyMapSnapshot.prototype)

export function readonlyMapSnapshot<Key, Value>(entries: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {

    return Object.freeze(new ReadonlyMapSnapshot(entries))
}
