import { Numeric } from "./numeric";

export class I32 extends Numeric {

    constructor(a?: number);

    static create(a?: number): I32;

    add(a: number): I32;

    set n(a: number);
    get n(): number;
}


export function i32(a: number): I32;
export function asI32(a: number): { type: string, data: number };
