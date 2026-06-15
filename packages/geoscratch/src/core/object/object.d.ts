export class ScratchObject {

    uuid: string;
    
    name: string;

    refCount: number;

    constructor(): ScratchObject
    
    use(): void

    release(): null

    destroy(): void
}