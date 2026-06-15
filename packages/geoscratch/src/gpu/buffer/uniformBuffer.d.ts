import { BlockRef } from "../../core/data/blockRef";
import { Buffer } from "./buffer";

export interface UniformBufferDescription {
    name: string,
    usage?: number,
    blocks: Array<BlockRef>,
}

export class UniformBuffer extends Buffer {

    name: string;

    constructor(description: UniformBufferDescription);

    static create(description: UniformBufferDescription): UniformBuffer;
}

export function uniformBuffer(description: UniformBufferDescription): UniformBuffer;
