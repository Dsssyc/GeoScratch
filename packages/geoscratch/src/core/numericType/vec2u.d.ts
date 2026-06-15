import { Vec2 } from "../math/vec2";
import { Numeric } from "./numeric"

export class Vec2u extends Numeric {
     
    constructor(x?: number, y?: number): Vec2u;

    static create(x: number, y: number): Vec2u;

    get array(): Uint32Array;
}

export function vec2u(x?: number, y?: number): Vec2u;

export function asVec2u(x?: number, y?: number): { type: string, data: Vec2 };