import { Numeric } from "./numeric";

export class F32 extends Numeric {

    constructor(a?: number);

    static create(a?: number): F32;

    add(a: number): F32;
    
    set n(a: number);
    get n(): number;
}


export function f32(a: number): F32;
export function asF32(a: number): { type: string, data: number };
