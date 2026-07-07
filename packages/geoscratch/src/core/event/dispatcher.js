export class EventDispatcher {

    /**
     * @param {boolean} [async] 
     */
    constructor(async = true) {

        /**
         * @type {{[type: string]: [Function]}}
         */
        this.listeners = {}
        /**
         * @type {[any]}
         */
        this.events = []
        /**
         * Activate each frame
         * @type {Function}
         */
        this.handleEvents = async ? this.handleEventsAsync : this.handleEventsSync
    }

    /**
     * @param {string} type 
     * @param {Function} callback 
     */
    addEventListeners(type, callback) {

        if (!this.listeners[type]) this.listeners[type] = []

        this.listeners[type].push(callback)
    }

    /**
     * @param {string} type 
     * @param {Function} callback 
     */
    removeEventListeners(type, callback) {

        const stack = this.listeners[type]
        if (stack && stack.length) {
            for (let i = 0; i < stack.length; i++) {
                if (stack[i] === callback) {
                    stack.splice(i, 1)
                    return
                }
            }
        }
    }

    /**
     * @param {any} event 
     */
    dispatchEvent(event) {

        const stack = this.listeners[event.type]
        if (!stack) {
            console.warn(`No listeners for event type: ${event.type}`)
            return
        }

        if (stack &&  stack.length) {
            stack.forEach(callback => {
                callback.call(this, event)
            })
        }

        // Promise.resolve().then( () => {

        //     // if (stack &&  stack.length) {
        //     //     stack.forEach(callback => {
        //     //         callback.call(this, event)
        //     //     })
        //     // }
        // })

        // this.events.push(event)
    }

    /**
     * @param {any} event 
     */
    handleEvent(event) {

        const stack = this.listeners[event.type]
        if (stack &&  stack.length) {
            stack.forEach(callback => {
                callback.call(this, event)
            })
        }
    }

    handleEventsSync() {

        this.events.forEach(event => {
            this.handleEvent(event)
        })
        this.events = []
    }

    handleEventsAsync() {

        Promise.resolve().then( () => {

            this.handleEventsSync()
        })
    }
}