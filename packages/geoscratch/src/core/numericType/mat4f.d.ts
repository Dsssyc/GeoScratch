import { Numeric } from "./numeric";
import { Vec3f } from "./vec3f";

export class Mat4f extends Numeric{

    constructor(): Mat4f;

    static create(): Mat4f;

    scale(v: Vec3f): Mat4f;

    static rotationX(radius: number): Mat4f;

    rotateX(radius: number): Mat4f

    static rotationY(radius: number): Mat4f

    rotateY(radius: number): Mat4f

    static rotationZ(radius: number): Mat4f

    rotateZ(radius: number): Mat4f

    lookAt(eye: Vec3f, target: Vec3f, up: Vec3f): Mat4f

    static transposing(m: Mat4f): Mat4f

    transpose(m: Mat4f): Mat4f

    static inverse(m: Mat4f): Mat4f

    invert(m: Mat4f): Mat4f

    static projection(foc: number, aspect: number, near: number, far: number): Mat4f;

    perspective(fov: number, aspect: number, near: number, far: number): Mat4f;

    static translation(v: Vec3f): Mat4f;

    translate(v: Vec3f): Mat4f;

    static multiplication(m: Mat4f): Mat4f;
    
    multiply(m: Mat4f): Mat4f;

    get array(): Float32Array;
}

export function mat4f(): Mat4f;