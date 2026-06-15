import { Shader } from "../../scratch.js";

/**
 * Description for the ImageLoader class.
 */
declare class ShaderLoader {
    load(name: string, url: string): Shader;
}

declare const shaderLoader: ShaderLoader;
export default shaderLoader;
export { ShaderLoader };
