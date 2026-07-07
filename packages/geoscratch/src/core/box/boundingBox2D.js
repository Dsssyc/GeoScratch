import { vec4f } from "../numericType/vec4f.js"

export class BoundingBox2D {

    constructor(xMin, yMin, xMax, yMax) {

        this._boundary = vec4f()
        this._boundary.x = xMin !== undefined ? xMin : Infinity
        this._boundary.y = yMin !== undefined ? yMin : Infinity
        this._boundary.z = xMax !== undefined ? xMax : -Infinity
        this._boundary.w = yMax !== undefined ? yMax : -Infinity
    }

    static create(xMin, yMin, xMax, yMax) {

        return new BoundingBox2D(xMin, yMin, xMax, yMax)
    }

    get boundary() {

        return this._boundary
    }

    update(x, y) {
        
        this._boundary.x = x < this._boundary.x ? x : this._boundary.x
        this._boundary.y = y < this._boundary.y ? y : this._boundary.y
        this._boundary.z = x > this._boundary.z ? x : this._boundary.z
        this._boundary.w = y > this._boundary.w ? y : this._boundary.w
    }

    updateByBox(box) {

        this.update(box._boundary.x, box._boundary.y)
        this.update(box._boundary.z, box._boundary.w)
    }

    /**
     * @param {BoundingBox2D} bBox 
     */
    overlap(bBox) {

        if (this._boundary.x > bBox._boundary.z || this._boundary.z < bBox._boundary.x) return false
        if (this._boundary.y > bBox._boundary.w || this._boundary.w < bBox._boundary.y) return false

        return true
    }

    get center() {

        return [
            (this._boundary.x + this._boundary.z) / 2,
            (this._boundary.y + this._boundary.w) / 2,
        ]
    }

    get size() {
        
        return [
            this._boundary.z - this._boundary.x,
            this._boundary.w - this._boundary.y,
        ]
    }

    reset(xMin, yMin, xMax, yMax) {
        
        this._boundary.x = xMin !== undefined ? xMin : Infinity
        this._boundary.y = yMin !== undefined ? yMin : Infinity
        this._boundary.z = xMax !== undefined ? xMax : -Infinity
        this._boundary.w = yMax !== undefined ? yMax : -Infinity
    }

    release() {

        this._boundary = null
        return null
    }
}

export function boundingBox2D(xMin, yMin, xMax, yMax) {

    return BoundingBox2D.create(xMin, yMin, xMax, yMax)
}