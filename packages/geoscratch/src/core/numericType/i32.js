import { Numeric } from "./numeric.js"

export class I32 extends Numeric {

    constructor(a) {

        if (a === undefined) super('i32', 0)
        else super('i32', a)
    }

    static create(a) {

        return new I32(a)
    }

    add(a) {

        this._data += a
        return this
    }

    set n(a) {

        this._data = a
    }

    get n() {

        return this._data
    }
}

export function i32(a) {

    return I32.create(a)
}

export function asI32(a) {

    return { type: 'i32', data: a !== undefined ? a : 0 }
}