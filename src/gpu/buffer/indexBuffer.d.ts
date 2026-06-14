import { ArrayRef } from "../../core/data/arrayRef";

export interface IndexResourceDescription {
    arrayRef: ArrayRef,
    size?: number,
    dataOffset?: number,
}

export interface IndexBufferDescription {
    name: string,
    usage?: number,
    randomAccessible?: boolean,
    resource: IndexResourceDescription,
}

export class IndexBuffer extends Buffer {
    type: string;
    length: number;
    constructor(description: IndexBufferDescription);
    static create(description: IndexBufferDescription): IndexBuffer;
}

export function indexBuffer(description: IndexBufferDescription): IndexBuffer;