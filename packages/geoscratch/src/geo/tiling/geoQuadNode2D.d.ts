import { BoundingBox2D } from '../../core/box/boundingBox2D'

export interface MapOptions {

    cameraBounds: BoundingBox2D;
    cameraPos: number[];
    zoomLevel: number;
}

export class GeoQuadNode2D {

    constructor(level?: number, id?: number, parent?: GeoQuadNode2D);

    release(): null;

    isSubdividable(options: MapOptions): boolean;
}

export { GeoQuadNode2D as Node2D }
