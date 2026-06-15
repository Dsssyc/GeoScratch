import { Vec2f, Vec2i, Vec2u } from "../../core/numericType/numericType";
import { Texture } from "../texture/texture";

/**
 * Information about the canvas and its GPU context.
 */
export interface ScreenDescription {
    canvas: HTMLCanvasElement,
    sampleCount?: number,
    depthTest?: boolean,
    alphaMode?: GPUCanvasAlphaMode,
};

/**
 * Represents information about the canvas and its GPU context.
 */
export class Screen {
    canvas: HTMLCanvasElement;
    context: GPUCanvasContext;
    presentationFormat: GPUTextureFormat;
    sampleCount?: number;

    /**
     * Creates an instance of CanvasInfo.
     * @param {ScreenDescription} description - The description object.
     */
    constructor(description: ScreenDescription);

    static create(description: ScreenDescription): Screen;

    /**
     * Resizes the canvas to the display size.
     */
    onWindowResize(): void;

    createScreenDependentTexture(name?: string, format?: GPUTextureFormat, computable?: boolean, mipMapped?: boolean, usage?: number, multiplier = [1, 1], multiplier?: number[]): Texture;

    getCurrentCanvasTexture(): Texture;

    addScreenDependentTexture(texture: Texture, multiplier?: number[]): Screen;

    addScreenDependentElement(element: any): Screen;

    get width(): number;
    get height(): number;
    get sizeI(): Vec2i;
    get sizeU(): Vec2u;
    get sizeF(): Vec2f;

    swap(): void;
}

export function screen(description: ScreenDescription): Screen;
