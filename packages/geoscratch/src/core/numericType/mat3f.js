import { Numeric } from "./numeric.js"
import { mat3 } from "../math/wgpu-matrix.module.js"

export class Mat3f extends Numeric {

    constructor() {

        super('mat3x3f', mat3.identity())
    }

    static create() {

        return new Mat3f()
    }

    // static rotationX(radius) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat3.rotateX(radius)
    //     return nm
    // }

    // rotateX(radius) {

    //     mat3.rotateX(this._data, radius, this._data)
    //     return this
    // }

    // static rotationY(radius) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat4.rotationY(radius)
    //     return nm
    // }

    // rotateY(radius) {

    //     mat4.rotateY(this._data, radius, this._data)
    //     return this
    // }

    // static rotationZ(radius) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat4.rotationZ(radius)
    //     return nm
    // }

    // rotateZ(radius) {

    //     mat4.rotateZ(this._data, radius, this._data)
    //     return this
    // }

    // lookAt(eye, target, up) {

    //     mat4.lookAt(eye.data, target.data, up.data, this._data)
    //     return this
    // }

    // static transposing(m) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat4.transpose(m.data)
    //     return nm
    // }

    // transpose(m) {

    //     mat4.transpose(m.data, this._data)
    //     return this
    // }

    // static inverse(m) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat4.inverse(m.data)
    //     return nm
    // }

    // invert(m) {

    //     mat4.invert(m.data, this._data)
    //     return this
    // }

    // static projection(fov, aspect, near, far) {
        
    //     const nm = new Mat3f()
    //     nm.data = mat4.perspective(fov, aspect, near, far)
    //     return nm
    // }

    // perspective(fov, aspect, near, far) {

    //     mat4.perspective(fov, aspect, near, far, this._data)
    //     return this
    // }

    // static translation(v) {

    //     const nm = new Mat3f()
    //     mat4.translation(v.data, nm.data)
    //     return this
    // }

    // translate(v) {

    //     mat4.translate( this._data, v.data, this._data)
    //     return this
    // }

    get array() {

        return this._data
    }
}

export function mat3f() {

    return Mat3f.create()
}