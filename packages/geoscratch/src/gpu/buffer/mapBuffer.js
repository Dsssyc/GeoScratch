import getDevice from "../context/device.js";
import { Buffer } from "./buffer.js";

/**
 * @typedef {Object} MapBufferDescription
 * @property {string} name
 * @property {Buffer} mapTarget
 */

class MapBuffer extends Buffer {

    /**
     * @param {MapBufferDescription} description 
     */
    constructor(description) {

        /**
         *  @type {import("./buffer.js").BufferDescription}
         */
        const bufferDesc = {
            name: description.name,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            size: description.mapTarget.size
        }
        super(bufferDesc)

        this.mapTarget = description.mapTarget.use()
        this.szie = description.mapTarget.size
    }

    /**
     * @param {MapBufferDescription} description 
     */
    static create(description) {

        return new MapBuffer(description)
    }

    mapping() {

        return new Promise((resolve, reject) => {
            if (!(this.buffer.mapState === 'unmapped')) {
                reject(new Error("Buffer is not in 'unmapped' state."));
                return;
            }

            const device = getDevice()
            const mapEncoder = device.createCommandEncoder({label: `Map encoder (map buffer ${this.name})`})
            mapEncoder.copyBufferToBuffer(this.mapTarget.buffer, 0, this.buffer, 0, this.size)
            device.queue.submit([mapEncoder.finish()])

            this.buffer.mapAsync(GPUMapMode.READ).then(() => {

                const result = new Uint32Array(this.buffer.getMappedRange())
                const copiedData = new Uint32Array(result.length)
                copiedData.set(result)
                this.buffer.unmap()

                resolve(copiedData.buffer)
            }).catch(err => {
                reject(err)
            })
        })
    }

    destroy() {

        this.mapTarget = this.mapTarget.release()
        this.size = null
        super.destroy()
    }
}

/**
 * @param {MapBufferDescription} description 
 */
function mapBuffer(description) {

    return MapBuffer.create(description)
}

export {
    mapBuffer,
    MapBuffer,
}