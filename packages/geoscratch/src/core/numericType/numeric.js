export class Numeric {

    constructor(type, data) {

        this._type = type
        this._data = data
    }

    /**
     * @param {any} value
     */
    set data(value) {

        this._data = value
    }

    get data() {

        return this._data
    }

    get type() {

        return this._type
    }
}