#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { Delaunay } from 'd3-delaunay'

function parseArguments(argv) {
    const values = new Map()
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index]
        const value = argv[index + 1]
        if (!name?.startsWith('--') || value === undefined) {
            throw new Error(`Invalid argument sequence near ${name ?? '<end>'}`)
        }
        values.set(name.slice(2), value)
    }
    for (const required of [ 'stations', 'station-count', 'expected-triangles', 'output' ]) {
        if (!values.has(required)) throw new Error(`Missing --${required}`)
    }
    return Object.freeze({
        stations: values.get('stations'),
        stationCount: Number(values.get('station-count')),
        expectedTriangles: Number(values.get('expected-triangles')),
        output: values.get('output'),
    })
}

const options = parseArguments(process.argv.slice(2))
if (!Number.isSafeInteger(options.stationCount) || options.stationCount <= 2) {
    throw new Error('station-count must be an integer greater than two')
}
if (!Number.isSafeInteger(options.expectedTriangles) || options.expectedTriangles <= 0) {
    throw new Error('expected-triangles must be a positive integer')
}

const payload = await readFile(options.stations)
const expectedBytes = options.stationCount * 2 * Float32Array.BYTES_PER_ELEMENT
if (payload.byteLength !== expectedBytes) {
    throw new Error(`Station byte length mismatch: expected ${expectedBytes}, received ${payload.byteLength}`)
}
const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
const coordinates = new Float64Array(options.stationCount * 2)
for (let index = 0; index < coordinates.length; index++) {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true)
    if (!Number.isFinite(value)) throw new Error(`Station coordinate ${index} is not finite`)
    coordinates[index] = value
}

const delaunay = new Delaunay(coordinates)
const triangleCount = delaunay.triangles.length / 3
if (triangleCount !== options.expectedTriangles) {
    throw new Error(
        `Delaunay triangle count mismatch: expected ${options.expectedTriangles}, received ${triangleCount}`
    )
}
const connectivity = Buffer.allocUnsafe(delaunay.triangles.length * Uint32Array.BYTES_PER_ELEMENT)
for (let index = 0; index < delaunay.triangles.length; index++) {
    connectivity.writeUInt32LE(delaunay.triangles[index], index * Uint32Array.BYTES_PER_ELEMENT)
}
await writeFile(options.output, connectivity)
process.stdout.write(JSON.stringify({ stationCount: options.stationCount, triangleCount }) + '\n')
