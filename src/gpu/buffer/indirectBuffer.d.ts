import { Buffer } from './buffer';
import { ArrayRef } from "../../core/data/arrayRef"

export interface IndirectResourceDescription {
    arrayRef: ArrayRef,
    size?: number,
    dataOffset?: number,
}

export interface IndirectBufferDescription {
    name: string,
    randomAccessible?: boolean,
    resource: IndirectResourceDescription
}

export class IndirectBuffer extends Buffer {

    constructor(description: IndirectBufferDescription);

    /**
     * @param {IndirectBufferDescription} description ;
     */
    static create(description: IndirectBufferDescription): IndirectBuffer;
}

export function indirectBuffer(description: IndirectBufferDescription): IndirectBuffer;