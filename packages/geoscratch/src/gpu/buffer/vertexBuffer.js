import { Buffer } from "./buffer.js";
import { ArrayRef } from "../../core/data/arrayRef.js";

function parseArrayType(typedArray) {

    let format = '';
    let bytesPerComponent = 1;
    if (typedArray instanceof Float32Array) {
        format = 'float32';
        bytesPerComponent = 4;
    } else if (typedArray instanceof Int32Array) {
        format = 'int32';
        bytesPerComponent = 4;
    } else if (typedArray instanceof Uint32Array) {
        format = 'uint32';
        bytesPerComponent = 4;
    } else {
        return "Unknown Format";
    }

    return {
        format,
        bytesPerComponent
    }
}

/**
 * @typedef {Object} VertexResourceDescription
 * @property {ArrayRef} arrayRef - must be TypedArray
 * @property {number} [size] - in bytes or elements if buffer is a TypedArray
 * @property {number} [dataOffset] - in bytes
 * @property {Array<{components: number}>} structure
 */

/**
 * @typedef {Object} VertexBufferDescription
 * @property {string} name
 * @property {number} [usage]
 * @property {boolean} [randomAccessible]
 * @property {VertexResourceDescription} resource
 */

class VertexBuffer extends Buffer {

    /**
     * @param {VertexBufferDescription} description 
     */
    constructor(description) {

        let randomAccessible = false
        let defaultUsage =  GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        randomAccessible = description.randomAccessible === undefined ? randomAccessible : description.randomAccessible
        randomAccessible && (defaultUsage |= GPUBufferUsage.STORAGE)

        /**
         *  @type {import("./buffer.js").BufferDescription}
         */
        const bufferDesc = {
            name: description.name,
            usage: description.usage ? description.usage : defaultUsage,
            size: description.resource.arrayRef.value.byteLength
        }
        super(bufferDesc)
        this.registerStrutureMap(description.resource.arrayRef, description.resource.dataOffset, description.resource.size)

        /**
         * dirty: update if needed; dynamic: update per frame
         * @type {Array<{format: GPUVertexFormat, offset: number}>}
         */
        this.attributes = []
        this.stride = 0
        const {format: arrayFormat, bytesPerComponent} = parseArrayType(description.resource.arrayRef.value)
        this.bytesPerComponent = bytesPerComponent
        description.resource.structure.forEach((member) => {

            this.attributes.push({
                format: arrayFormat + (member.components > 1 ? `x${member.components}` : ''),
                offset: this.stride
            })
            this.stride += bytesPerComponent * member.components
        })
    }

    /**
     * @param {VertexBufferDescription} description 
     */
    static create(description) {

        return new VertexBuffer(description)
    }

    getComponentsPerElement() {

        return this.stride / this.bytesPerComponent
    }

    destroy() {

        this.stride = null
        this.attributes = []
        super.destroy()
    }
}

/**
 * @param {VertexBufferDescription} description 
 */
function vertexBuffer(description) {

    return VertexBuffer.create(description)
}

export {
    vertexBuffer,
    VertexBuffer,
}