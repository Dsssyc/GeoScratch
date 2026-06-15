export interface TextureResourceDescription {
    imageBitmap?: Function,
    resource?: Function,
    size?: Function,
    canvasTexture?: GPUTexture,
    dataType?: 'imageBitmap' | 'buffer' | 'data' | 'size' | 'canvasTexture'
}

export interface TextureDescription {
    name?: string,
    usage?: number,
    flipY?: boolean,
    mipMapped?: boolean,
    computable?: boolean,
    format?: GPUTextureFormat,
    resource?: TextureResourceDescription,
}

export class Texture {

    name: string;
    texture: GPUTexture;
    resource: TextureResourceDescription;
    format: GPUTextureFormat;
    view(): GPUTextureView;

    /**
     * @param {TextureDescription} description 
     */
    constructor(description: TextureDescription);
    
    /**
     * @param {TextureDescription} description 
     */
    static create(description: TextureDescription): Texture;

    get width(): number;

    get height(): number;

    update(): void;
    needUpdate(): void;

    use(): Texture;

    release(): null;

    registerCallback(callback: Function): number;

    removeCallback(index: number): null;

    reset(description?: TextureDescription): void;

    destroy(): void;
}

function texture(description: TextureDescription): Texture;

export {
    texture,
    Texture
}