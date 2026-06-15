export interface PlaneGeometry {
    positions: number[];
    indices: number[];
}

export function plane(time?: number): PlaneGeometry;
