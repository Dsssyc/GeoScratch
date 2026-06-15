import { ScratchObject } from "../../core/object/object.js";
import director from "../director/director.js";
/**
 * @typedef {Object} ShaderDescription
 * @property {string} name
 * @property {Function} [codeFunc]
 */

class Shader extends ScratchObject {

    /**
     * @param {ShaderDescription} description 
     */
    constructor(description) {

        super()

        this.name = description.name

        /**
         * @type {GPUShaderModule}
         */
        this.shaderModule = undefined
        this.code = description.codeFunc
        this.code() && this.needUpdate()
    }

    /**
     * @param {ShaderDescription} description 
     */
    static create(description) {

        return new Shader(description)
    }

    needUpdate() {

        director.addToUpdateList(this)
    }

    exportDescriptor() {

        return {

            label: this.name,
            code: this.code()
        }
    }

    update() {

        director.dispatchEvent({type: 'createShader', emitter: this})
    }

    isComplete() {

        if (this.shaderModule) return true
        return false
    }

    destroy() {

        this.code = null
        this.shaderModule = null

        super.destroy()
    }
}

/**
 * @param {ShaderDescription} description 
 */
function shader(description) {

    return Shader.create(description)
}

export {
    shader,
    Shader
}
