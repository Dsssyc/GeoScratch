export function plane(time = 5) {

    function middle(v1, v2) {

        return [
            (v1[0] + v2[0]) / 2,
            (v1[1] + v2[1]) / 2,
        ]
    }

    const indices = []
    const positions = []
    const vertexMap = new Map()
    function add2Map(v) {
        
        const key = v.join('-')
        if(!vertexMap.has(key))vertexMap.set(key, positions.length / 2)
        positions.push(v[0])
        positions.push(v[1])
        return v
    }

    const tl = add2Map([0.0, 1.0])
    const bl = add2Map([0.0, 0.0])
    const tr = add2Map([1.0, 1.0])
    const br = add2Map([1.0, 0.0])
    const firstTriangle = {
        fst: tl,
        snd: bl,
        ted: br,
        level: 0,
    }
    const secondTriangle = {
        fst: br,
        snd: tr,
        ted: tl,
        level: 0,
    }
    const stack = []
    stack.push(firstTriangle)
    stack.push(secondTriangle)

    const triangles = []
    while(stack.length) {

        const triangle = stack.pop(stack)

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

        indices.push(vertexMap.get(kV1))
        indices.push(vertexMap.get(kV2))
        indices.push(vertexMap.get(kV3))
    })

    return {
        positions,
        indices,
    }
}