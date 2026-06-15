export class Monitor {

    constructor();

    set memorySizeInBytes(value: number);
    get memorySizeInBytes(): number;

    getMemoryInMB(): number;
}

declare const monitor: Monitor;
export default monitor;
