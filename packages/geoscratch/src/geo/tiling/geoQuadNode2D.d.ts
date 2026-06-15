import { BoundingBox2D } from '../../core/box/boundingBox2D'

export interface MapOptions {

    cameraBounds: BoundingBox2D;
    cameraPos: number[];
    zoomLevel: number;
}

export class GeoQuadNode2D {

    constructor(level: number = 0, id: number = 0, parent: GeoQuadNode2D = undefined): GeoQuadNode2D;

    release(): null;

    isSubdividable(options: MapOptions): Boolean;
}

export { GeoQuadNode2D as Node2D }
