export class Numeric {

    constructor(type: string, data: any);

    set data(value: any);

    get data(): any;

    get type(): string;

    get state(): { type: string, value: Function };
}
