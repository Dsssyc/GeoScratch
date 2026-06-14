import { Texture } from "../../gpu/texture/texture.js"

/**
 * @typedef {Object} ImageLoaderDescription
 * @property {import("../../gpu/texture/texture").TextureDescription} textureDesc
 * @property {string} url
 */

class ImageLoader {

    constructor() {

        this.workerIndex = 0
        this.imageResource = new WeakMap()
        this.workerKeys = new Map()
    }

    load(name, url, mipMapped, targetFormat = 'rgba8unorm') {

        // const textureDesc = { name: name, mipMapped: mipMapped}
        const workerKey = {index: this.workerIndex}
        this.workerKeys.set(this.workerIndex, workerKey)

        const textureDesc = {
            name: name,
            mipMapped: mipMapped,
            format: targetFormat,
            resource: {
                imageBitmap: () => this.imageResource.get(workerKey) ? {imageBitmap: this.imageResource.get(workerKey).deref(), index: workerKey.index} : { imageBitmap: null, index: workerKey.index },
                dataType: "imageBitmap"
            },
        }
        const texture = Texture.create(textureDesc)

        const imageLoaderWorker = new Worker(new URL( './imageLoader.worker.js', import.meta.url ))
    
        imageLoaderWorker.addEventListener('message', (event) => {
    
            const { imageBitmap } = event.data
            this.imageResource.set(workerKey, new WeakRef(imageBitmap))
            imageLoaderWorker.terminate()

            // ImageBitmap resource is stored by weakRef
            // Must update texture at once to ref this imageBitmap
            texture.update()
        })
    
        imageLoaderWorker.addEventListener('error', (error) => {

            console.error("Error loading image: ", error)
            imageLoaderWorker.terminate()
        });
    
        imageLoaderWorker.postMessage({ url })

        this.workerIndex++
        return texture
    }
}

const imageLoader = new ImageLoader()

export default imageLoader

export {
    ImageLoader,
}
