import { ArrayRef } from '../../core/data/arrayRef';
import { BlockRef } from '../../core/data/blockRef';

export type BufferRef = ArrayRef | BlockRef;

export type BufferDescription = {
    name: string;
    usage?: number;
    size: number;
};

export class Buffer {

    constructor(description: BufferDescription);

    name: string;

    buffer: GPUBuffer;
    
    updatePerFrame: boolean;

    areaMap: {[mapName: string]: {start: number, length: number, ref: BufferRef, dataOffset?: number, size?: number}};
 
    exportDescriptor(): GPUBufferDescriptor;

    registerStrutureMap(dataRef: BufferRef, dataOffset?: number, size?: number, alignment?: number): void;

    updateSubArea(name: string): void;

    makeDirty(name: string): void;

    update(): void;

    needUpdate(): void;

    isComplete(): boolean;

    use(): this;

    release(): null;

    destroy(): void;
}
