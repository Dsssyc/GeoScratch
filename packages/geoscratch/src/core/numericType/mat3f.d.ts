import { Numeric } from "./numeric";

export class Mat3f extends Numeric{

    constructor(): Mat3f;

    static create(): Mat3f;

    // state(): { type: string, value: Function };

    // static rotationX(radius: number): Mat4f;

    // rotateX(radius: number): Mat4f

    // static rotationY(radius: number): Mat4f

    // rotateY(radius: number): Mat4f

    // static rotationZ(radius: number): Mat4f

    // rotateZ(radius: number): Mat4f

    // lookAt(eye: Vec3f, target: Vec3f, up: Vec3f): Mat4f

    // static transposing(m: Mat4f): Mat4f

    // transpose(m: Mat4f): Mat4f

    // static inverse(m: Mat4f): Mat4f

    // invert(m: Mat4f): Mat4f

    // static projection(foc: number, aspect: number, near: number, far: number): Mat4f;

    // perspective(fov: number, aspect: number, near: number, far: number): Mat4f;

    // static translation(v: Vec3f): Mat4f;

    // translate(v: Vec3f): Mat4f;

    get array(): Float32Array;
}

export function mat3f(): Mat3f;