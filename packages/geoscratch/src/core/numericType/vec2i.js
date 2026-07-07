import { Numeric } from "./numeric.js"
import { vec2 } from "../math/wgpu-matrix.module.js"

export class Vec2i extends Numeric {
     
    constructor(x, y) {

        if (x === undefined && y === undefined) super('vec2i', vec2.create())
        else if (x !== undefined && y === undefined ) super('vec2i', vec2.fromValues(x, x))
        else super('vec2i', vec2.fromValues(x, y))
    }

    static create(x, y) {

        return new Vec2i(x, y)
    }

    get array() {

        return this._data
    }

    
}

export function vec2i(x, y) {

    return Vec2i.create(x, y)
}

export function asVec2i(x, y) {

    const v = [ 0, 0 ]

    if (x !== undefined && y === undefined) {
        v[0] = x
        v[1] = x
    }
    else if (x !== undefined && y !== undefined) {
        v[0] = x
        v[1] = y
    }

    return { type: 'vec2i', data: v }
}