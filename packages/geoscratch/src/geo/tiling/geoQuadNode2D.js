import { BoundingBox2D } from '../../core/box/boundingBox2D.js'

/**
 * @typedef {object} MapOptions
 * @property {BoundingBox2D} cameraBounds
 * @property {Array[number]} cameraPos
 * @property {number} zoomLevel
 */

export class GeoQuadNode2D {

    /**
     * @param {number} level 
     * @param {number} id 
     * @param {GeoQuadNode2D} [parent]
     */
    constructor(level = 0, id = 0, parent = undefined) {

        this.parent = parent
        this.level = level
        this.id = id

        this.size = 180. / Math.pow(2, level)

        const childhoodId = this.id % 4
        const minLon = (this.parent ? this.parent.bBox.boundary.x : -180.) + (childhoodId % 2) * this.size
        const maxLon = minLon + this.size
        const minLat = (this.parent ? this.parent.bBox.boundary.y : -90.) + Math.floor((childhoodId / 2)) * this.size
        const maxLat = minLat + this.size

        this.bBox = new BoundingBox2D(
            minLon, minLat,
            maxLon, maxLat
        )

        /**
         * @type {GeoQuadNode2D[]}
         */
        this.children = []
    }

    release() {
        
        this.bBox = this.bBox.release()
        this.children = null
        this.parent = null
        this.level = null
        this.size = null
        this.id = null
        return null
    }

    /**
     * @param {MapOptions} options
     * @returns 
     */
    isSubdividable(options) {

        const center = this.bBox.center
        const hDistance = Math.ceil(Math.abs(center[0] - options.cameraPos[0]) / this.size)
        const vDistance = Math.ceil(Math.abs(center[1] - options.cameraPos[1]) / this.size)

        if (Math.max(hDistance, vDistance) <= 2) return true
        else return false
    }
}

export { GeoQuadNode2D as Node2D }
