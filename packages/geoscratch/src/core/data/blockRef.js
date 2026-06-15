import { Numeric } from "../numericType/numeric.js"
import { UUID } from "../utils/uuid.js"
import { makeShaderDataDefinitions, makeStructuredView } from "../utils/webgpu-utils.module.js"

/**
 * @typedef {'f32' | 'i32' | 'u32' | 'vec2f' | 'vec2i' | 'vec2u' | 'vec3f' | 'vec3i' | 'vec3u' | 'vec4f' | 'vec4i' | 'vec4u' | 'mat2x2f' | 'mat2x2i' | 'mat2x2u' | 'mat3x3f' | 'mat3x3i' | 'mat3x3u' | 'mat4x4f' | 'mat4x4i' | 'mat4x4u'} BlockValueType
 */


/**
 * @typedef {Object} BlockRefDescription
 * @property {string} name
 * @property {boolean} [dynamic]
 * @property {{[varName: string]: Numeric | { type: string, data: any }}} map
 */

class BlockRef {
    
    /**
     * 
     * @param {BlockRefDescription} description 
     */
    constructor(description) {

        this.uuid = UUID()

        this.name = description.name

        let typeDeclaration = ``
        this.map = description.map
        for (const key in this.map) {
            typeDeclaration += `${key}: ${this.map[key].type},\n`
        }

        this.code = `struct Block {
            ${typeDeclaration}
        }`
        const defs = makeShaderDataDefinitions(this.code)
        // console.log(this.code, defs)
        this._view = makeStructuredView(defs.structs.Block)
        

        this.onChanges = []

        this.refCount = 0

        this._view && this.update()
        this.dynamic = description.dynamic !== undefined ? description.dynamic : false
    }

    get value() {
        return this._view.arrayBuffer
    }

    get view() {
        
        return this._view
    }

    set view(view) {
        
        this._view = view

        this.update()
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

    update() {

        const data = {}
        for (const key in this.map) {
            data[key] = this.map[key].data
        }
        this._view.set(data)

        this.onChanges.forEach(callback => callback && callback())
    }


    destroy() {
        this.refCount = null
        this.dynamic = null
        this.onChanges = []
        this._view = null
        this.uuid = null
        this.name = null
        this.code = null
        this.map = null
    }
}

/**
 * 
 * @param {BlockRefDescription} description 
 * @returns {BlockRef}
 */
function bRef(description) {
    return new BlockRef(description)
}

export {
    BlockRef,
    bRef
}