/**
 * @typedef {Object} SamplerDescription
 * @property {string} name
 * @property {number} [mipmap]
 * @property {number} [maxAnisotropy]
 * @property {Array<GPUFilterMode>} filterMinMag
 * @property {Array<GPUAddressMode>} addressModeUVW
 */

export interface SamplerDescription {
    name: string,
    mipmap?: number,
    maxAnisotropy?: number,
    filterMinMag: [GPUFilterMode],
    addressModeUVW: [GPUAddressMode],
};

export class Sampler {

    static create(description: SamplerDescription): Sampler;
    update(): void;
    use(): Sampler;
    release(): null;
    get sampler(): GPUSampler;
    set sampler(sampler: GPUSampler): void;
    exportDescriptor(): GPUSamplerDescriptor;
}

export function sampler(description: SamplerDescription): Sampler;