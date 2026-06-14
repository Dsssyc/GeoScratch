import { ArrayRef } from "../../core/data/arrayRef.js";
import { Buffer } from "./buffer.js";

/**
 * @typedef {Object} IndirectResourceDescription
 * @property {ArrayRef} arrayRef - must be TypedArray
 * @property {number} [size] - in bytes or elements if buffer is a TypedArray
 * @property {number} [dataOffset] - in bytes
 */

/**
 * @typedef {Object} IndirectBufferDescription
 * @property {string} name
 * @property {boolean} [randomAccessible]
 * @property {IndirectResourceDescription} resource
 */

class IndirectBuffer extends Buffer {

    /**
     * @param {IndirectBufferDescription} description
     */
    constructor(description) {

        let randomAccessible = false
        let defaultUsage =  GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        randomAccessible = description.randomAccessible === undefined ? randomAccessible : description.randomAccessible
        randomAccessible && (defaultUsage |= GPUBufferUsage.STORAGE)

        /**
         *  @type {import("./buffer.js").BufferDescription}
         */
        const bufferDesc = {
            name: description.name,
            usage: defaultUsage,
            size: description.resource.arrayRef.value.byteLength
        }
        super(bufferDesc)

        this.registerStrutureMap(description.resource.arrayRef, description.resource.dataOffset, description.resource.size)
    }

    /**
     * @param {IndirectBufferDescription} description 
     */
    static create(description) {

        return new IndirectBuffer(description)
    }
}

/**
 * @param {IndirectBufferDescription} description 
 */
function indirectBuffer(description) {

    return IndirectBuffer.create(description)
}

export {
    indirectBuffer,
    IndirectBuffer,
}