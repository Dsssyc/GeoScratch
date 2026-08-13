type PlaneVertex = [number, number]

type PlaneTriangle = {
    fst: PlaneVertex
    snd: PlaneVertex
    ted: PlaneVertex
    level: number
}

export interface PlaneGeometry {
    positions: number[]
    indices: number[]
}

/** Generates a recursively subdivided CPU-side plane without allocating GPU resources. */
export function plane(time = 5): PlaneGeometry {

    function middle(v1: PlaneVertex, v2: PlaneVertex): PlaneVertex {

        return [
            (v1[0] + v2[0]) / 2,
            (v1[1] + v2[1]) / 2,
        ]
    }

    const indices: number[] = []
    const positions: number[] = []
    const vertexMap = new Map<string, number>()
    function add2Map(v: PlaneVertex): PlaneVertex {

        const key = v.join('-')
        if (!vertexMap.has(key)) vertexMap.set(key, positions.length / 2)
        positions.push(v[0])
        positions.push(v[1])
        return v
    }

    const tl = add2Map([0.0, 1.0])
    const bl = add2Map([0.0, 0.0])
    const tr = add2Map([1.0, 1.0])
    const br = add2Map([1.0, 0.0])
    const firstTriangle: PlaneTriangle = {
        fst: tl,
        snd: bl,
        ted: br,
        level: 0,
    }
    const secondTriangle: PlaneTriangle = {
        fst: br,
        snd: tr,
        ted: tl,
        level: 0,
    }
    const stack: PlaneTriangle[] = []
    stack.push(firstTriangle)
    stack.push(secondTriangle)

    const triangles: PlaneTriangle[] = []
    while (stack.length) {

        const triangle = stack.pop() as PlaneTriangle

        if (triangle.level >= time) {
            triangles.push(triangle)
            continue
        }

        const oV1 = triangle.fst
        const oV2 = triangle.snd
        const oV3 = triangle.ted
        const nV = add2Map(middle(oV1, oV3))
        stack.push({ fst: oV1, snd: nV, ted: oV2, level: triangle.level + 0.5 })
        stack.push({ fst: oV3, snd: nV, ted: oV2, level: triangle.level + 0.5 })
    }

    triangles.forEach(triangle => {

        const kV1 = triangle.fst.join('-')
        const kV2 = triangle.snd.join('-')
        const kV3 = triangle.ted.join('-')

        indices.push(vertexMap.get(kV1) as number)
        indices.push(vertexMap.get(kV2) as number)
        indices.push(vertexMap.get(kV3) as number)
    })

    return {
        positions,
        indices,
    }
}
