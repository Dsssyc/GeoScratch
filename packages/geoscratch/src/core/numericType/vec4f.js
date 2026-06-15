import { Numeric } from "./numeric.js"
import { vec4 } from "../math/wgpu-matrix.module.js"
import { F32 } from "./f32.js"

export class Vec4f extends Numeric {
     
    constructor(x, y, z, w) {

        if (x === undefined && y === undefined && z === undefined && w === undefined) super('vec4f', vec4.create())
        else if (x !== undefined && y === undefined && z === undefined && w === undefined) super('vec4f', vec4.fromValues(x, x, x, x))
        else if (x !== undefined && y !== undefined && z === undefined && w === undefined) super('vec4f', vec4.fromValues(x, y, y, y))
        else if (x !== undefined && y !== undefined && z !== undefined && w === undefined) super('vec4f', vec4.fromValues(x, y, z, z))
        else super('vec4f', vec4.fromValues(x, y, z, w))
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

    get w() {

        return this._data[3]
    }

    get xy() {

        return [ this._data[0], this._data[1] ]
    }

    get yz() {

        return [ this._data[1], this._data[2] ]
    }

    get zw() {

        return [ this._data[2], this._data[3] ]
    }

    get xyz() {

        return [ this._data[0], this._data[1], this._data[2] ]
    }

    get yzw() {

        return [ this._data[1], this._data[2], this._data[3] ]
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

    set w(w) {

        this._data[3] = w
    }

    set xy(xy) {

        this._data[0] = xy[0]
        this._data[1] = xy[1]
    }

    set yz(yz) {

        this._data[1] = yz[0]
        this._data[2] = yz[1]
    }

    set zw(zw) {

        this._data[2] = zw[0]
        this._data[3] = zw[1]
    }

    set xyz(xyz) {

        this._data[0] = xyz[0]
        this._data[1] = xyz[1]
        this._data[2] = xyz[1]
    }

    set yzw(yzw) {

        this._data[1] = yzw[0]
        this._data[2] = yzw[1]
        this._data[3] = yzw[2]
    }

    static create(x, y, z, w) {

        return new Vec4f(x, y, z, w)
    }

    transformFromMat4(m) {

        this._data = vec4.transformMat4(this._data, m.data)
        return this
    }

    normalize() {

        vec4.normalize(this._data, this._data)
        return this
    }

    scale(s) {

        if (s instanceof Number) vec4.scale(this._data, s, this._data)
        else if (s instanceof F32) vec4.scale(this._data, s.data, this._data)
        
        return this
    }

    get array() {

        return this._data
    }
}

export function vec4f(x, y, z, w) {

    return Vec4f.create(x, y, z, w)
}

export function asVec4f(x, y, z, w) {

    const v = [0., 0., 0., 0.]

    if (x !== undefined && y === undefined && z === undefined && w === undefined) {
        v[0] = x
        v[1] = x
        v[2] = x
        v[3] = x
    }
    else if (x !== undefined && y !== undefined && z === undefined && w === undefined) {
        v[0] = x
        v[1] = y
        v[2] = y
        v[3] = y
    }
    else if (x !== undefined && y !== undefined && z !== undefined && w === undefined) {
        v[0] = x
        v[1] = y
        v[2] = z
        v[3] = z
    }
    else {
        v[0] = x
        v[1] = y
        v[2] = z
        v[3] = w
    }

    return { type: 'vec4f', data: v }
}