import { Numeric } from "./numeric.js"
import { vec3 } from "../math/wgpu-matrix.module.js"
import { F32 } from "./f32.js"

export class Vec3f extends Numeric {
     
    constructor(x, y, z) {

        if (x === undefined && y === undefined && z === undefined) super('vec3f', vec3.create())
        else if (x !== undefined && y === undefined && z === undefined ) super('vec3f', vec3.fromValues(x, x, x))
        else if (x !== undefined && y !== undefined && z === undefined ) super('vec3f', vec3.fromValues(x, y, y))
        else super('vec3f', vec3.fromValues(x, y, z))
    }

    get x() {

        return this._data[0]
    }

    get y() {

        return this._data[1]
    }

    get z() {

        return this._data[2]
    }

    set x(x) {

        this._data[0] = x
    }

    set y(y) {

        this._data[1] = y
    }

    set z(z) {

        this._data[2] = z
    }

    static create(x, y, z) {

        return new Vec3f(x, y, z)
    }

    transformFromMat4(m) {

        this._data = vec3.transformMat4(this._data, m.data)
        return this
    }

    normalize() {

        vec3.normalize(this._data, this._data)
        return this
    }

    scale(s) {

        if (s instanceof Number) vec3.scale(this._data, s, this._data)
        else if (s instanceof F32) vec3.scale(this._data, s.data, this._data)
        
        return this
    }

    get array() {

        return this._data
    }
}

export function vec3f(x, y, z) {

    return Vec3f.create(x, y, z)
}

export function asVec3f(x, y, z) {

    const v = [0., 0., 0.]

    if (x !== undefined && y === undefined && z === undefined) {
        v[0] = x
        v[1] = x
        v[2] = x
    }
    else if (x !== undefined && y !== undefined && z === undefined) {
        v[0] = x
        v[1] = y
        v[2] = y
    }
    else if (x !== undefined && y !== undefined && z !== undefined) {
        v[0] = x
        v[1] = y
        v[2] = z
    }

    return { type: 'vec3f', data: v }
}