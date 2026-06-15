export interface SphereGeometry {
    indices: number[];
    vertices: number[];
    normals: number[];
    uvs: number[];
}

export function sphere(
    radius?: number,
    widthSegments?: number,
    heightSegments?: number,
    phiStart?: number,
    phiLength?: number,
    thetaStart?: number,
    thetaLength?: number
): SphereGeometry;
