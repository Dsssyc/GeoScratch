export class Monitor {

    constructor();

    set memorySizeInBytes(value): void;
    get memorySizeInBytes(): number;

    getMemoryInMB(): number;
}

const monitor: Monitor;
export default monitor;