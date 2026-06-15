import { Vec4f } from "../numericType/vec4f";

export class BoundingBox2D {

    constructor(xMin?: number, yMin?: number, xMax?: number, yMax?: number): BoundingBox2D;

    static create(xMin?: number, yMin?: number, xMax?: number, yMax?: number): BoundingBox2D;

    update(x: number, y: number): void;

    updateByBox(box: BoundingBox2D): void;

    overlap(bBox: BoundingBox2D): Boolean;

    get center(): number[];

    get size(): number[];

    get boundary(): Vec4f;

    reset(xMin?: number, yMin?: number, xMax?: number, yMax?: number): void;

    release(): null;
}

export function boundingBox2D(xMin?: number, yMin?: number, xMax?: number, yMax?: number): BoundingBox2D