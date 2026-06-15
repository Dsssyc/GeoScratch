import { Texture, TextureDescription } from "../../gpu/texture/texture";

/**
 * Description for the ImageLoader class.
 */
declare class ImageLoader {

    /**
     * Index of the worker.
     */
    private workerIndex: number;

    /**
     * Array to store image resources.
     */
    private imageResource: ImageBitmap[];

    /**
     * Load an image with the specified description.
     * @returns {Texture} - The created texture.
     */
    load(name: string, url: string, mipMapped?: boolean, targetFormat?: GPUTextureFormat): Texture;
}

/**
 * Description for the ImageLoader class.
 */
interface ImageLoaderDescription {
    /**
     * Texture description for the image loader.
     */
    textureDesc: TextureDescription;

    /**
     * URL of the image to load.
     */
    url: string;
}

declare const imageLoader: ImageLoader;

export default imageLoader;
export { ImageLoader, ImageLoaderDescription };
