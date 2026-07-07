import { Buffer } from "./buffer.js"
import { BlockRef } from "../../core/data/blockRef.js"

/**
 * @typedef {Object} UniformBufferDescription
 * @property {string} name
 * @property {number} [usage]
 * @property {Array<BlockRef>} blocks
 */

class UniformBuffer extends Buffer {

    /**
     * @param {UniformBufferDescription} description 
     */
    constructor(description) {

        let byteLength = 0
        let alignSize = description.blocks.length === 1 ? 1 : 256

        for(const block of description.blocks) {

            let offset = 0
            if (block.value.byteLength % alignSize) {
                offset = alignSize - (block.value.byteLength % alignSize)
            }
            byteLength += block.value.byteLength + offset
        }

        /**
         *  @type {import("./buffer.js").BufferDescription}
         */
        const bufferDesc = {
            name: description.name,
            usage: description.usage ? description.usage : (GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC),
            size: byteLength
        }
        super(bufferDesc)

        this.alignSize = alignSize
        this.dynamicBlocks = []
        description.blocks.forEach((block) => {
            this.addBlock(block)
        })
        this.dynamicBlocks.length && (this.updatePerFrame = true)
        this.isInitialized = false
    }

    /**
     * @param {UniformBufferDescription} description 
     */
    static create(description) {

        return new UniformBuffer(description)
    }

    /**
     * 
     * @param {BlockRef} block 
     */
    addBlock(block) {

        block.dynamic && this.dynamicBlocks.push(block)
        this.registerStrutureMap(block, undefined, undefined, this.alignSize)
    }

    update() {

        if (this.dynamicBlocks.length || !this.isInitialized ) {

            this.dynamicBlocks.forEach(block => block.update()) 
            this.isInitialized = true
            super.update()
        }
    }

    destroy() {

        this.alignSize = null
        this.dynamicBlocks = null
        this.isInitialized = null
        super.destroy()
    }
}

/**
 * @param {UniformBufferDescription} description 
 */
function uniformBuffer(description) {

    return UniformBuffer.create(description)
}

export {
    uniformBuffer,
    UniformBuffer,
}