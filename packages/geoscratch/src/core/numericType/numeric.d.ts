export class Numeric {

    constructor(type: string, data: any): Numeric;

    set data(value: any): void;

    get data(): any;

    get type(): string

    get state(): { type: string, value: Function };
}