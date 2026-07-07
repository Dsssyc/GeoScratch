import { Buffer, BufferDescription } from "./buffer";
import { ArrayRef } from "../../core/data/arrayRef";

export interface StorageResourceDescription {
    size?: number, // element lenght of the TypedArray
    arrayRef: ArrayRef, // must return TypedArray
    dataOffset?: number, // in bytes
    components?: number,
}

export interface StorageBufferDescription {
    name: string,
    usage?: number,
    resource: StorageResourceDescription,
}

export class StorageBuffer extends Buffer {

    name: string;
    componetsPerElement: number;

    constructor(description?: BufferDescription);

    static create(description: StorageBufferDescription): StorageBuffer;
}

export function storageBuffer(description: StorageBufferDescription): StorageBuffer;
