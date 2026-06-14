import director from '../../gpu/director/director.js'
import { Shader } from '../../gpu/shader/shader.js'

class ShaderLoader {

    constructor() {

        this.workerIndex = 0
        this.textResource = new WeakMap()
        this.workerKeys = new Map()
    }

    load(name, url) {

        const workerKey = {index: this.workerIndex}
        this.workerKeys.set(this.workerIndex, workerKey)

        const shaderDesc = { 
            name: name,
            codeFunc: () => this.textResource.get(workerKey) ? this.textResource.get(workerKey).deref().text : null
        }
        const shader = Shader.create(shaderDesc)

        const textLoaderWorker = new Worker(new URL( './textLoader.worker.js', import.meta.url ))
    
        textLoaderWorker.addEventListener('message', (event) => {
    
            const { text } = event.data
            this.textResource.set(workerKey, new WeakRef({text: text}))
            textLoaderWorker.terminate()

            // ImageBitmap resource is stored by weakRef
            // Must update texture at once to ref this imageBitmap
            director.dispatchEvent({type: 'createShader', emitter: shader})
        })
    
        textLoaderWorker.addEventListener('error', (error) => {

            console.error("Error loading image: ", error)
            textLoaderWorker.terminate()
        });
    
        textLoaderWorker.postMessage({ url })

        this.workerIndex++
        return shader
    }
}

const shaderLoader = new ShaderLoader()

export default shaderLoader

export {
    ShaderLoader,
}
