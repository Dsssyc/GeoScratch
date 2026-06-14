import { ArrayRef } from "../../core/data/arrayRef";
import { Buffer } from "./buffer";

export interface VertexResourceDescription {
    arrayRef: ArrayRef, // must provide TypedArray
    dataOffset?: number, // in bytes
    size?: number, // element lengh of the TypedArray
    structure: Array<{components: number}>,
}

export interface VertexBufferDescription {
    name: string,
    usage?: number,
    randomAccessible?: boolean,
    resource: VertexResourceDescription
}

class VertexBuffer extends Buffer {

    stepMode: GPUVertexStepMode;
    attributes: Array<{format: GPUVertexFormat, offset: number}>;
    stride: number;

    constructor(description: VertexBufferDescription);

    static create(description: VertexBufferDescription): VertexBuffer;

    addAttribute(description: VertexAttributeDescription): void;

    getComponentsPerElement(): number;
}

function vertexBuffer(description: VertexBufferDescription): VertexBuffer;

export { vertexBuffer, VertexBuffer };