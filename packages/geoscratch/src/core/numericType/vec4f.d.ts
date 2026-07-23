import type { Mat4 } from "wgpu-matrix";
import { Numeric } from "./numeric"
export class Vec4f extends Numeric {

     
    constructor(x?: number, y?: number, z?: number, w?: number);

    get x(): number;
    get y(): number;
    get z(): number;
    get w(): number;
    set x(x: number);
    set y(y: number);
    set z(z: number);
    set w(w: number);
    get xy(): number[]
    get yz(): number[]
    get zw(): number[]
    get xyz(): number[]
    get yzw(): number[]
    set xy(xy: number[])
    set yz(yz: number[])
    set zw(zw: number[])
    set xyz(xyz: number[])
    set yzw(yzw: number[])

    static create(x?: number, y?: number, z?: number, w?: number): Vec4f;

    transformFromMat4(m: Mat4): Vec4f;
    
    get array(): Float32Array;
}

export function vec4f(x?: number, y?: number, z?: number, w?: number): Vec4f;

export function asVec4f(x?: number, y?: number, z?: number, w?: number): { type: string, data: Vec4f }
