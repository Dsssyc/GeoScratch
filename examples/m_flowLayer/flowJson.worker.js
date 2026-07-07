import { Delaunay } from 'd3-delaunay'
import * as scr from 'geoscratch'

self.addEventListener('message', (event) => {

  const { url } = event.data
  parseBin(url)
  // parseStations(url)
})

async function parseBin(url) {

  const uvs = new Float32Array(await fetchArrayBuffer(url))

  let maxSpeed = -Infinity
  for (let i = 0; i < uvs.length / 2; i++) {
      
      const u = uvs[2 * i + 0]
      const v = uvs[2 * i + 1]

      const speed = Math.sqrt(u * u + v * v)
      maxSpeed = speed > maxSpeed ? speed : maxSpeed
  }

  self.postMessage({ url, maxSpeed, uvs }) 
}

async function parseStations(url) {

  const data = await fetchJson(url)
  const { maxSpeed, indices, attributes } = triangulate(data.stations)
  self.postMessage({
    url,
    maxSpeed,
    indices,
    attributes
  })
}

async function fetchArrayBuffer(url) {

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    }
    return response.arrayBuffer()
}

async function fetchJson(url) {

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    }
    return response.json()
}

function encodeFloatToDouble(value) {

    const result = new Float32Array(2);
    result[0] = value;
    
    const delta = value - result[0];
    result[1] = delta;
    return result;
}

function triangulate(data) {

    const vertices = []
    data.forEach(station => {
        
        vertices.push(station.lon)
        vertices.push(station.lat)
    })
    const meshes = new Delaunay(vertices)

    let maxSpeed = 0.0
    const attributes = []
    for (let i = 0; i < meshes.points.length; i += 2) {

        const station = data[Math.floor(i / 2)]
        const x = encodeFloatToDouble(scr.MercatorCoordinate.mercatorXfromLon(meshes.points[i + 0]))
        const y = encodeFloatToDouble(scr.MercatorCoordinate.mercatorYfromLat(meshes.points[i + 1]))

        attributes.push(x[0])
        attributes.push(y[0])
        attributes.push(x[1])
        attributes.push(y[1])
        attributes.push(station.u)
        attributes.push(station.v)

        const speed = Math.sqrt(station.u * station.u + station.v * station.v)
        maxSpeed = speed > maxSpeed ? speed : maxSpeed
    }
    
    return { maxSpeed, indices: meshes.triangles, attributes }
}
