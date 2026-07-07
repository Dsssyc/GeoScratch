export interface TextureResourceDescription {
    imageBitmap?: () => { imageBitmap: ImageBitmap | null | undefined, index?: number, id?: unknown },
    resource?: () => unknown,
    size?: () => [number, number] | [number, number, number],
    canvasTexture?: () => GPUTexture | undefined,
    dataType?: 'imageBitmap' | 'buffer' | 'data' | 'size' | 'canvasTexture'
}

export interface TextureDescription {
    name?: string,
    usage?: number,
    flipY?: boolean,
    mipMapped?: boolean,
    computable?: boolean,
    format?: GPUTextureFormat,
    resource: TextureResourceDescription,
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
    static create<D, T extends Texture>(
        this: new (description: D) => T,
        description: D
    ): T;

    get width(): number;

    get height(): number;

    update(): void;
    needUpdate(): void;

    use(): this;

    release(): null;

    registerCallback(callback: () => void): number;

    removeCallback(index: number): null;

    reset(description?: TextureDescription): void;

    destroy(): void;
}

export function texture(description: TextureDescription): Texture;
