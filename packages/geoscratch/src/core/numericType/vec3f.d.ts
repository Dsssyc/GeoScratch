import type { Mat4, Vec3 } from "wgpu-matrix";
import { Numeric } from "./numeric"

export class Vec3f extends Numeric {
     
    constructor(x?: number, y?: number, z?: number);

    get x(): number;
    get y(): number;
    get z(): number;
    set x(x: number);
    set y(y: number);
    set z(z: number);

    static create(x?: number, y?: number, z?: number): Vec3f;

    transformFromMat4(m: Mat4): Vec3f;

    get array(): Float32Array;
}

export function vec3f(x?: number, y?: number, z?: number): Vec3f;

export function asVec3f(x?: number, y?: number, z?: number): { type: string, data: Vec3 }
