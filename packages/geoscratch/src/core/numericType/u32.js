import { Numeric } from "./numeric.js"

export class U32 extends Numeric {

    constructor(a) {

        if (a === undefined) super('u32', 0)
        else super('u32', a)
    }

    static create(a) {

        return new U32(a)
    }

    set n(a) {

        this._data = a
    }

    get n() {

        return this._data
    }

    add(a) {

        this._data += a
        return this
    }
}

export function u32(a) {

    return U32.create(a)
}

export function asU32(a) {

    return { type: 'u32', data: a !== undefined ? a : 0 }
}