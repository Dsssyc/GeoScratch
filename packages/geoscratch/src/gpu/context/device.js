export class Device {

    constructor() {
    }

    setDevice(device) {
        this.device = device
    }

    static async Create() {

        const deviceInstance = new Device();

        if (!navigator.gpu) {
            fail("ERROR:: this browser does not support WebGPU");
            return;
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            fail("ERROR:: this browser supports WebGPU but it appears disabled");
            return;
        }

        const adapterFeatures = adapter.features;
        // Iterate through all the set values using values()
        console.log("Features supported by the adapter");
        const valueIterator = adapterFeatures.values();
        for (const value of valueIterator) {
            console.log(value);
        }

        deviceInstance.device = await adapter.requestDevice();
        deviceInstance.device.lost.then((info) => {
            console.error("ERROR:: WebGPU device was lost: ${info.message}");

            // "reason" will be "destroyed" if we intentionally destroy the device
            if (info.reason !== "destroyed") {
                // Try again
                this.Create();
            }
        });
        
        deviceInstance.isPrepared = true;
        console.log(deviceInstance.device);

        return deviceInstance;
    }
}

function fail(msg) {
    alert(msg);
}

let device = {
    device: undefined,
    setDevice(device) {
        this.device = device
    }
}

// async function StartDash() {

//     if (device.device) return

//     Device.Create().then((deviceInstance) => {

//         device.setDevice(deviceInstance.device)
//     })
// }

async function StartDash() {

    if (device.device) return device.device

    if (!navigator.gpu) {
        fail("ERROR:: this browser does not support WebGPU")
        return
    }

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
        fail("ERROR:: this browser supports WebGPU but it appears disabled")
        return
    }

    const adapterFeatures = adapter.features
    // Iterate through all the set values using values()
    console.log("Features supported by the adapter")

    const valueIterator = adapterFeatures.values()
    for (const value of valueIterator) {
        console.log(value)
    }
    
    const instance = await adapter.requestDevice()
    instance.lost.then(async(info) => {
        console.error("ERROR:: WebGPU device was lost: ${info.message}")

        // "reason" will be "destroyed" if we intentionally destroy the device
        if (info.reason !== "destroyed") {
            // Try again
            await StartDash()
        }
    })
    
    console.log(instance)
    device.setDevice(instance)
    return device.device
}

export default function getDevice() {

    while(true) {

        if (device.device) break
    }

    return device.device
}

export {
    StartDash, 
    device,
}
