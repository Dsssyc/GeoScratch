import { Numeric } from "./numeric.js"
import { vec2 } from "../math/wgpu-matrix.module.js"

export class Vec2f extends Numeric {
     
    constructor(x, y) {

        if (x === undefined && y === undefined) super('vec2f', vec2.create())
        else if (x !== undefined && y === undefined ) super('vec2f', vec2.fromValues(x, x))
        else super('vec2f', vec2.fromValues(x, y))
    }

    static create(x, y) {

        return new Vec2f(x, y)
    }

    get x() {

        return this._data[0]
    }

    get y() {

        return this._data[1]
    }

    set x(x) {

        this._data[0] = x
    }

    set y(y) {

        this._data[1] = y
    }

    get array() {

        return this._data
    }

    reset() {

        this._data[0] = 0
        this._data[1] = 0
    }

    copy(v) {

        this._data[0] = v._data[0]
        this._data[1] = v._data[1]
    }
}

export function vec2f(x, y) {

    return Vec2f.create(x, y)
}

export function asVec2f(x, y) {

    const v = [0., 0.]

    if (x !== undefined && y === undefined) {
        v[0] = x
        v[1] = x
    }
    else if (x !== undefined && y !== undefined) {
        v[0] = x
        v[1] = y
    }

    return { type: 'vec2f', data: v }
}