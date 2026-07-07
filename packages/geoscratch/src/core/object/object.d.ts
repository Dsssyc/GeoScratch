export class ScratchObject {

    uuid: string;
    name: string;
    refCount: number;

    constructor();

    use(): this;

    release(): null;

    destroy(): void;
}
