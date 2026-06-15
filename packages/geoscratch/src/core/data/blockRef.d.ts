import { Numeric } from "../numericType/numeric";

type BlockValueType = 'f32' | 'i32' | 'u32' | 'vec2f' | 'vec2i' | 'vec2u' | 'vec3f' | 'vec3i' | 'vec3u' | 'vec4f' | 'vec4i' | 'vec4u' | 'mat2x2f' | 'mat2x2i' | 'mat2x2u' | 'mat3x3f' | 'mat3x3i' | 'mat3x3u' | 'mat4x4f' | 'mat4x4i' | 'mat4x4u'


interface BlockRefDescription {

    name: string,
    code?: string,
    dynamic?: boolean,
    map: {[varName: string]: Numeric | { type: BlockValueType, data: any }},
}

export class BlockRef {

    constructor(description: BlockRefDescription);

    name: string;

    registerCallback(callback: (name: string) => void): number;

    removeCallback(index: number): null;

    get value(): ArrayBufferLike;

    get view(): any;
    set view(view: any): void;

    elements(index: number, data?: number): ArrayBufferLike | void;

    use(): ArrayRef;

    release(): null;
}

export function bRef(description: BlockRefDescription): BlockRef;
