import { ArrayRef } from "../../core/data/arrayRef.js"
import { BlockRef } from "../../core/data/blockRef.js"
import director from "../director/director.js"
import monitor from "../monitor/monitor.js"
import { ScratchObject } from "../../core/object/object.js"

/**
 * @typedef {Object} BufferDescription
 * @property {string} name
 * @property {number} usage
 * @property {number} size
 */

/**
 * @typedef {ArrayRef | BlockRef} Ref
 */

class Buffer extends ScratchObject {

    /**
     * @param {BufferDescription} description
     */
    constructor(description) {

        super()

        this.name = description.name !== undefined ? description.name : 'Buffer'

        this.buffer = undefined

        this.size = description.size
        monitor.memorySizeInBytes += this.size

        this.usage = description.usage

        director.dispatchEvent({type: 'createBuffer', emitter: this})

        /**
         * @type {{[mapName: string]: {start: number, length: number, ref: Ref, dataOffset?: number, size?: number, callbackIndex: number}}}
         */
        this.areaMap = {}
        this.lastAreaName = null

        this.updatePerFrame = false
        this.dirtyList = new Set()

        this.needUpdate()
    }

    /**
     * @returns {GPUBufferDescriptor}
     */
    exportDescriptor() {

        return {
            label: this.name,
            size: this.size,
            usage: this.usage
        }
    }

    /**
     * 
     * @param {Ref} ref
     * @param {number} [dataOffset]
     * @param {number} [size]
     * @param {number} alignment
     */
    registerStrutureMap(ref, dataOffset, size, alignment = 1) {

        let offset = 0
        if (this.lastAreaName) {
            const lastArea = this.areaMap[this.lastAreaName]
            offset = lastArea.start + lastArea.length
        }
        this.lastAreaName = ref.name

        let alignmentOffset = 0
        if (ref.value.byteLength % alignment) {
            alignmentOffset = alignment - (ref.value.byteLength % alignment)
        }
        let length = ref.value.byteLength + alignmentOffset
        
        this.areaMap[ref.name] = {
            start: offset,
            length: length,

            // Related CPU typedArray data information
            ref: ref.use(),
            dataOffset: dataOffset,
            size: size,
            callbackIndex: ref.registerCallback(() => {
                this.makeDirty(ref.name)
                this.needUpdate()
            })
        }

        this.makeDirty(ref.name)
    }

    /**
     * 
     * @param {string} name 
     */
    makeDirty(name) {

        this.dirtyList.add(name)
    }

    /**
     * @deprecated
     * @param {string} name 
     */
    updateSubArea(name) {

        const subArea = this.areaMap[name]
        
        this.device.queue.writeBuffer(this.buffer, subArea.start, subArea.ref.value, subArea.dataOffset, subArea.size)
    }

    update() {

        if (!this.dirtyList.size) return

        this.dirtyList.forEach((name) => {
            // this.updateSubArea(name)
            director.dispatchEvent({type: 'writeBuffer', emitter: this, subArea: this.areaMap[name]})
        })

        this.dirtyList = new Set()
    }

    needUpdate() {

        director.addToUpdateList(this)
    }

    destroy() {
        
        if (this.buffer) {
            this.buffer.destroy()
            this.buffer = null
        }

        if (this.size) monitor.memorySizeInBytes -= this.size
        
        this.uuid = null
        this.name = null
        this.refCount = null
        this.size = null
        this.usage = null
        this.lastAreaName = null
    
        for (const key in this.areaMap) {
            let area = this.areaMap[key]
            area.callbackIndex = area.ref.removeCallback(area.callbackIndex)
            area.ref = area.ref.release()
            area.dataOffset = null
            area.length = null
            area.start = null
            area.size = null
        }
        this.areaMap = null
    
        this.dirtyList.clear()
        this.dirtyList = null

        super.destroy()
    }
}

export {
    Buffer
}