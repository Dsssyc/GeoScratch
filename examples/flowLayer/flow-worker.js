self.addEventListener('message', event => {

    if (event.data?.type !== 'load-field') return
    void loadField(event.data)
})

async function loadField({ requestId, index, url }) {

    try {
        const uvs = new Float32Array(await fetchArrayBuffer(url))
        let maxSpeed = -Infinity
        for (let offset = 0; offset < uvs.length; offset += 2) {
            maxSpeed = Math.max(maxSpeed, Math.hypot(uvs[offset], uvs[offset + 1]))
        }
        self.postMessage({
            type: 'field-loaded',
            requestId,
            index,
            url,
            maxSpeed,
            uvs,
        }, [ uvs.buffer ])
    } catch (error) {
        self.postMessage({
            type: 'field-failed',
            requestId,
            index,
            url,
            error: serializeError(error),
        })
    }
}

async function fetchArrayBuffer(url) {

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    return response.arrayBuffer()
}

function serializeError(error) {

    return {
        name: error instanceof Error ? error.name : 'NonErrorFailure',
        message: error instanceof Error ? error.message : String(error),
    }
}
