import { Numeric } from "./numeric.js"
import { mat4 } from "../math/wgpu-matrix.module.js"

export class Mat4f extends Numeric {

    constructor() {

        super('mat4x4f', mat4.identity())
    }

    static create() {

        return new Mat4f()
    }

    scale(v) {

        mat4.scale(this._data, v.data, this._data)
        return this
    }

    static rotationX(radius) {
        
        const nm = new Mat4f()
        nm.data = mat4.rotationX(radius)
        return nm
    }

    rotateX(radius) {

        mat4.rotateX(this._data, radius, this._data)
        return this
    }

    static rotationY(radius) {
        
        const nm = new Mat4f()
        nm.data = mat4.rotationY(radius)
        return nm
    }

    rotateY(radius) {

        mat4.rotateY(this._data, radius, this._data)
        return this
    }

    static rotationZ(radius) {
        
        const nm = new Mat4f()
        nm.data = mat4.rotationZ(radius)
        return nm
    }

    rotateZ(radius) {

        mat4.rotateZ(this._data, radius, this._data)
        return this
    }

    lookAt(eye, target, up) {

        mat4.lookAt(eye.data, target.data, up.data, this._data)
        return this
    }

    static transposing(m) {
        
        const nm = new Mat4f()
        nm.data = mat4.transpose(m.data)
        return nm
    }

    transpose(m) {

        mat4.transpose(m.data, this._data)
        return this
    }

    static inverse(m) {
        
        return new Mat4f().invert(m)
    }

    invert(m) {

        mat4.invert(m.data, this._data)
        return this
    }

    static projection(fov, aspect, near, far) {
        
        const nm = new Mat4f()
        nm.data = mat4.perspective(fov, aspect, near, far)
        return nm
    }

    perspective(fov, aspect, near, far) {

        mat4.perspective(fov, aspect, near, far, this._data)
        return this
    }

    static translation(v) {

        return new Mat4f().translate(v)
    }

    translate(v) {

        mat4.translate(this._data, v.data, this._data)
        return this
    }

    static multiplication(m) {

        return new Mat4f().multiply(m)
    }

    multiply(m) {

        mat4.multiply(this._data, m.data, this._data)
        return this
    }

    get array() {

        return this._data
    }
}

export function mat4f() {

    return Mat4f.create()
}