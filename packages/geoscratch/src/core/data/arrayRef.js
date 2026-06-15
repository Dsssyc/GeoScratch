import { UUID } from "../../core/utils/uuid.js"

function createTypedArray(constructor, length) {
    switch (constructor) {
        case Uint8Array:
            return new Uint8Array(length)
        case Uint16Array:
            return new Uint16Array(length / 2)
        case Uint32Array:
            return new Uint32Array(length / 4)
        case Float32Array:
            return new Float32Array(length / 4)
        default:
            throw new Error('Unsupported data type')
    }
}

function ensureByteLengthMultipleOfFour(data) {

    let byteLength = data.byteLength
    let bytesNeeded = (4 - (byteLength % 4)) % 4

    if (bytesNeeded > 0) {
        let paddedArray = createTypedArray(data.constructor, byteLength + bytesNeeded)
        for (let i = 0; i < data.length; i++) {
            paddedArray[i] = data[i]
        }
        return paddedArray
    }

    return data
}

class ArrayRef {
    
    /**
     * @param {string} name
     * @param {ArrayBufferLike} data 
     */
    constructor(name, data) {

        this.uuid = UUID()

        this.name = name
        this.length = data.length
        this._data = ensureByteLengthMultipleOfFour(data)
        this.onChanges = []

        /**
         * @type {Array<name: string, format: string, offset: number>}
         */
        this.structure = []
        this.stride = 0

        this.refCount = 0
    }

    use() {

        this.refCount++
        return this
    }

    release() {

        if (--this.refCount === 0) this.destroy()
        return null
    }

    registerCallback(callback) {

        this.onChanges.push(callback)

        return this.onChanges.length - 1
    }

    removeCallback(index) {

        this.onChanges[index] = null
        return null
    }

    get value() {

        return this._data
    }

    /**
     * 
     * @param {ArrayBufferLike} data 
     */
    set value(data) {

        this._data = data

        this.onChanges.forEach(callback => callback && callback())
    }

    /**
     * 
     * @param {number} index 
     * @param {number} data 
     */
    setIndexed(index, data) {

        this._data[index] = data

        this.onChanges.forEach(callback => callback && callback())
    }

    /**
     * 
     * @param {number} index 
     * @returns 
     */
    getIndexed(index) {

        return this._data[index]
    }

    fill(num) {

        this._data.fill(num)

        this.onChanges.forEach(callback => callback && callback())
    }

    /**
     * 
     * @param {number} index 
     * @param {number} [data] 
     */
    element(index, data) {
        
        if (data !== undefined) this.setIndexed(index, data)
            
        else return this.getIndexed(index)
    }


    destroy() {
        this.uuid = null
        this.name = null
        this._data = null
        this.onChanges = []
        this.structure = []
        this.stride = null
    }
}

function aRef(typedArray, name = 'arrayRef') {
    return new ArrayRef(name, typedArray)
}

export {
    ArrayRef,
    aRef
}