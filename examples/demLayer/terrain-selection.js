export const TERRAIN_BOUNDARY = Object.freeze([
    120.04373606134682,
    31.173901952209487,
    121.96623240116922,
    32.08401085804678,
])

export const MAX_TERRAIN_NODES = 5000

export function selectTerrainNodes({
    cameraPos,
    zoomLevel,
    maxLevel = 14,
    maxNodes = MAX_TERRAIN_NODES,
    terrainBoundary = TERRAIN_BOUNDARY,
}) {

    assertPoint(cameraPos, 'cameraPos')
    assertFinite(zoomLevel, 'zoomLevel')
    assertNonNegativeInteger(maxLevel, 'maxLevel')
    assertPositiveInteger(maxNodes, 'maxNodes')
    assertBounds(terrainBoundary, 'terrainBoundary')

    const stack = [ createNode(0, 0), createNode(0, 1) ]
    const candidates = []
    let maxVisibleLevel = 0
    let sectorRange = [ 0, 0 ]
    const terminalLevel = Math.min(maxLevel, zoomLevel)

    while (stack.length > 0) {
        const node = stack.pop()
        if (!overlaps(node.bounds, terrainBoundary)) continue

        if (!isSubdividable(node, cameraPos) || node.level >= terminalLevel) {
            candidates.push(node)
            if (node.level > maxVisibleLevel) {
                const size = node.bounds[2] - node.bounds[0]
                sectorRange = [ size, size ]
                maxVisibleLevel = node.level
            }
            continue
        }

        for (let childId = 0; childId < 4; childId++) {
            stack.push(createNode(node.level + 1, 4 * node.id + childId, node.bounds))
        }
    }

    const eligible = candidates.filter(node => node.level + 5 >= maxVisibleLevel)
    const selected = eligible.slice(0, maxNodes)
    const nodeLevels = selected.map(node => node.level)
    const nodeBoxes = selected.flatMap(node => node.bounds)
    const tileBox = selected.length === 0
        ? [ 0, 0, 0, 0 ]
        : selected.reduce((bounds, node) => [
            Math.min(bounds[0], node.bounds[0]),
            Math.min(bounds[1], node.bounds[1]),
            Math.max(bounds[2], node.bounds[2]),
            Math.max(bounds[3], node.bounds[3]),
        ], [ Infinity, Infinity, -Infinity, -Infinity ])
    const minVisibleLevel = selected.reduce(
        (minimum, node) => Math.min(minimum, node.level),
        maxLevel
    )

    return Object.freeze({
        version: 1,
        cameraPos: freezeArray(cameraPos),
        zoomLevel,
        maxLevel,
        maxNodes,
        terrainBoundary: freezeArray(terrainBoundary),
        candidateCount: candidates.length,
        selectedCount: eligible.length,
        cappedCount: selected.length,
        droppedCount: eligible.length - selected.length,
        visibleNodeCount: selected.length,
        tileBox: freezeArray(tileBox),
        levelRange: freezeArray([ minVisibleLevel, maxVisibleLevel ]),
        sectorRange: freezeArray(sectorRange),
        nodeLevels: freezeArray(nodeLevels),
        nodeBoxes: freezeArray(nodeBoxes),
    })
}

function createNode(level, id, parentBounds) {

    const size = 180 / 2 ** level
    const childhoodId = id % 4
    const minLon = (parentBounds?.[0] ?? -180) + (childhoodId % 2) * size
    const minLat = (parentBounds?.[1] ?? -90) + Math.floor(childhoodId / 2) * size

    return {
        level,
        id,
        bounds: [ minLon, minLat, minLon + size, minLat + size ],
    }
}

function isSubdividable(node, cameraPos) {

    const centerX = (node.bounds[0] + node.bounds[2]) / 2
    const centerY = (node.bounds[1] + node.bounds[3]) / 2
    const size = node.bounds[2] - node.bounds[0]
    const horizontalDistance = Math.ceil(Math.abs(centerX - cameraPos[0]) / size)
    const verticalDistance = Math.ceil(Math.abs(centerY - cameraPos[1]) / size)

    return Math.max(horizontalDistance, verticalDistance) <= 2
}

function overlaps(a, b) {

    if (a[0] > b[2] || a[2] < b[0]) return false
    if (a[1] > b[3] || a[3] < b[1]) return false
    return true
}

function freezeArray(values) {

    return Object.freeze(Array.from(values))
}

function assertFinite(value, name) {

    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`)
}

function assertPoint(value, name) {

    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
        throw new TypeError(`${name} must be a two-number sequence`)
    }
    if (value.length !== 2) throw new TypeError(`${name} must contain two numbers`)
    assertFinite(value[0], `${name}[0]`)
    assertFinite(value[1], `${name}[1]`)
}

function assertBounds(value, name) {

    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
        throw new TypeError(`${name} must be a four-number sequence`)
    }
    if (value.length !== 4) throw new TypeError(`${name} must contain four numbers`)
    for (let index = 0; index < value.length; index++) assertFinite(value[index], `${name}[${index}]`)
    if (value[0] > value[2] || value[1] > value[3]) throw new RangeError(`${name} must be ordered`)
}

function assertNonNegativeInteger(value, name) {

    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
}

function assertPositiveInteger(value, name) {

    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
}
