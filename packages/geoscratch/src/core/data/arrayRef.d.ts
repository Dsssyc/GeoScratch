export class ArrayRef {

    constructor(name: string, data: ArrayBufferLike);

    name: string;
    length: number;

    registerCallback(callback: (name: string) => void): number;

    removeCallback(index: number): null;

    get value(): ArrayBufferLike;
    set value(data: ArrayBufferLike): void;

    element(index: number, data?: number): ArrayBufferLike | void;

    fill(num: number): void;

    use(): ArrayRef;

    release(): null;
}

export function aRef(typedArray: ArrayBufferLike, name?: string): ArrayRef;
