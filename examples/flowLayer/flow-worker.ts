type FlowWorkerError = Readonly<{
    name: string
    message: string
}>

type FlowFieldLoadRequest = Readonly<{
    type: 'load-field'
    requestId: number
    index: number
    url: string
}>

type FlowFieldLoadedMessage = Readonly<{
    type: 'field-loaded'
    requestId: number
    index: number
    url: string
    maxSpeed: number
    uvs: Float32Array
}>

type FlowFieldFailedMessage = Readonly<{
    type: 'field-failed'
    requestId: number
    index: number
    url: string
    error: FlowWorkerError
}>

type FlowWorkerScope = Readonly<{
    postMessage(
        message: FlowFieldLoadedMessage | FlowFieldFailedMessage,
        transfer?: Transferable[]
    ): void
}>

self.addEventListener('message', (event: MessageEvent<FlowFieldLoadRequest>) => {

    if (event.data?.type !== 'load-field') return
    void loadField(event.data)
})

async function loadField({ requestId, index, url }: FlowFieldLoadRequest) {

    try {
        const uvs = new Float32Array(await fetchArrayBuffer(url))
        let maxSpeed = -Infinity
        for (let offset = 0; offset < uvs.length; offset += 2) {
            maxSpeed = Math.max(maxSpeed, Math.hypot(uvs[offset], uvs[offset + 1]))
        }
        (self as unknown as FlowWorkerScope).postMessage({
            type: 'field-loaded',
            requestId,
            index,
            url,
            maxSpeed,
            uvs,
        } satisfies FlowFieldLoadedMessage, [ uvs.buffer ])
    } catch (error) {
        (self as unknown as FlowWorkerScope).postMessage({
            type: 'field-failed',
            requestId,
            index,
            url,
            error: serializeError(error),
        } satisfies FlowFieldFailedMessage)
    }
}

async function fetchArrayBuffer(url: string) {

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    return response.arrayBuffer()
}

function serializeError(error: unknown): FlowWorkerError {

    return {
        name: error instanceof Error ? error.name : 'NonErrorFailure',
        message: error instanceof Error ? error.message : String(error),
    }
}
