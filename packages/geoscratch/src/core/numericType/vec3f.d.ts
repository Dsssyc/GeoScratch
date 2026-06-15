import { Mat4 } from "../math/mat4";
import { Vec3 } from "../math/vec3";
import { Numeric } from "./numeric"

export class Vec3f extends Numeric {
     
    constructor(x?: number, y?: number, z?: number): Vec3f;

    get x(): number;
    get y(): number;
    get z(): number;
    set x(x: number): void;
    set y(y: number): void;
    set z(z: number): void;

    static create(x?: number, y?: number, z?: number): Vec3f;

    transformFromMat4(m: Mat4): Vec3f;

    get array(): Float32Array;
}

export function vec3f(x?: number, y?: number, z?: number): Vec3f;

export function asVec3f(x?: number, y?: number, z?: number): { type: string, data: Vec3 }