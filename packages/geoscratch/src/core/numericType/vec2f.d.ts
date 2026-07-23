import type { Vec2 } from "wgpu-matrix";
import { Numeric } from "./numeric"

export class Vec2f extends Numeric {
     
    constructor(x?: number, y?: number);

    static create(x: number, y: number): Vec2f;

    get x(): number;
    get y(): number;
    set x(x: number);
    set y(y: number);

    reset(): void;
    copy(v: Vec2f): void;

    get array(): Float32Array;
}

export function vec2f(x?: number, y?: number): Vec2f;

export function asVec2f(x?: number, y?: number): { type: string, data: Vec2 };
