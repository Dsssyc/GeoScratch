import { Buffer, BufferDescription } from "./buffer";
import { IndexBuffer } from "./indexBuffer";

export interface StorageResourceDescription {
    size?: number, // element lenght of the TypedArray
    arrayRef: DataRef, // must return TypedArray
    dataOffset?: number, // in bytes
}

export interface StorageBufferDescription {
    name: string,
    usage?: number,
    resource: StorageResourceDescription,
}

class StorageBuffer extends Buffer {

    name: string;
    componetsPerElement: number;

    constructor(description?: BufferDescription);

    static create(description: StorageBufferDescription): StorageBuffer;
}

function storageBuffer(description: StorageBufferDescription): StorageBuffer;

export { storageBuffer, StorageBuffer };