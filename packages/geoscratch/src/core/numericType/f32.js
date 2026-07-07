import { Numeric } from "./numeric.js"

export class F32 extends Numeric {

    constructor(a) {

        if (a === undefined) super('f32', 0)
        else super('f32', a)
    }

    static create(a) {

        return new F32(a)
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

export function f32(a) {

    return F32.create(a)
}

export function asF32(a) {

    return { type: 'f32', data: a !== undefined ? a : 0 }
}