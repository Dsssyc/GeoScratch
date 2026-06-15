import { BlockRef } from "../../core/data/blockRef";
import { Buffer } from "./buffer";

export interface UniformBufferDescription {
    name: string,
    usage?: number,
    blocks: Array<BlockRef>,
}

class UniformBuffer extends Buffer {

    name: string;

    constructor(description: UniformBufferDescription);

    static create(description: UniformBufferDescription): UniformBuffer;
}

function uniformBuffer(description: UniformBufferDescription): UniformBuffer;

export { 
    uniformBuffer,
    UniformBuffer,
};