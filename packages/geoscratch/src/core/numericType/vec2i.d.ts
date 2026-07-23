import type { Vec2 } from "wgpu-matrix";
import { Numeric } from "./numeric"

export class Vec2i extends Numeric {
     
    constructor(x?: number, y?: number);

    static create(x: number, y: number): Vec2i;

    get array(): Int32Array;
}

export function vec2i(x?: number, y?: number): Vec2i;

export function asVec2i(x?: number, y?: number): { type: string, data: Vec2 };
