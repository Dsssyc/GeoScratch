import { ArrayRef } from "../../core/data/arrayRef.js";
import { Buffer } from "./buffer.js";

/**
 * @typedef {Object} StorageResourceDescription
 * @property {ArrayRef} arrayRef - must be TypedArray
 * @property {number} [size] - in bytes or elements if buffer is a TypedArray
 * @property {number} [dataOffset] - in bytes
 * @property {number} [components]
 */

/**
 * @typedef {Object} StorageBufferDescription
 * @property {string} name
 * @property {number} [usage]
 * @property {StorageResourceDescription} resource
 */

class StorageBuffer extends Buffer {

    /**
     * @param {StorageBufferDescription} [description] 
     */
    constructor(description) {

        /**
         *  @type {import("./buffer.js").BufferDescription}
         */
        const bufferDesc = {
            name: description.name,
            usage: description.usage ? description.usage : (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC),
            size: description.resource.arrayRef.value.byteLength
        }

        super(bufferDesc)

        this.componetsPerElement = description.resource.components ? description.resource.components : 0

        this.registerStrutureMap(description.resource.arrayRef, description.resource.dataOffset, description.resource.size)
    }

    /**
     * @param {StorageBufferDescription} description 
     */
    static create(description) {

        const storageBuffer = new StorageBuffer(description)

        return storageBuffer
    }

    destroy() {

        this.componetsPerElement = null
        super.destroy()
    }
}

/**
 * @param {StorageBufferDescription} [description] 
 */
function storageBuffer(description) {

    return StorageBuffer.create(description)
}

export {
    storageBuffer,
    StorageBuffer,
}