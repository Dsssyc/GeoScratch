export function sphere (radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI) {


    widthSegments = Math.max(3, Math.floor(widthSegments));
    heightSegments = Math.max(2, Math.floor(heightSegments));

    const thetaEnd = Math.min(thetaStart + thetaLength, Math.PI);

    let index = 0;
    const grid = [];

    const vertex = new Float32Array(3);
    const normal = new Float32Array(3);

    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    for (let iy = 0; iy <= heightSegments; iy ++) {
        const verticesRow = [];
        const v= iy / heightSegments;
        let uOffset = 0;

        if (iy === 0 && thetaStart === 0) {
            uOffset = 0.5 / widthSegments;
        } else if (iy === heightSegments && thetaEnd === Math.PI) {
            uOffset = -0.5 / widthSegments;
        }

        for (let ix = 0; ix <= widthSegments; ix ++) {
            const u = ix / widthSegments;

            // Vertex
            vertex[0] = -radius * Math.cos(phiStart + u * phiLength) * Math.sin(thetaStart + v * thetaLength);
            vertex[1] = radius * Math.cos(thetaStart + v * thetaLength);
            vertex[2] = radius * Math.sin(phiStart + u * phiLength) * Math.sin(thetaStart + v * thetaLength);

            vertices.push(...vertex);

            // Normal
            normal[0] = vertex[0];
            normal[1] = vertex[1];
            normal[2] = vertex[2];
            let len = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
            if (len > 0) {
                len = 1 / Math.sqrt(len);
            }
            normal[0] *= len;
            normal[1] *= len;
            normal[2] *= len;
            normals.push(...normal);

            // UV
            uvs.push(u + uOffset, 1 - v);

            verticesRow.push(index++);
        }

        grid.push(verticesRow);
    }

    // Indices
    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = grid[iy][ix + 1];
            const b = grid[iy][ix];
            const c = grid[iy + 1][ix];
            const d = grid[iy + 1][ix + 1];

            if (iy !== 0 || thetaStart > 0) indices.push(a, b, d);
            if (iy !== heightSegments - 1 || thetaEnd < Math.PI) indices.push(b, c, d);
        }
    }

    return {
        indices,
        vertices,
        normals,
        uvs
    }
}