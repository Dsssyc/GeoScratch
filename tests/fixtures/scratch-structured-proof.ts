export interface CorrectReceiver {
    execute(value: number): void
}

export interface WrongReceiver {
    wrongReceiverOnly(value: number): void
}

export interface DescriptorFixture {
    size: number
    usage: number
}

declare const correctReceiver: CorrectReceiver
declare const wrongReceiver: WrongReceiver

correctReceiver.execute(1)
wrongReceiver.wrongReceiverOnly(2)

const descriptor: DescriptorFixture = {
    size: 16,
    usage: 4,
}

descriptor.size = 32
void descriptor.size

new URL('https://example.test/')

// commentOnlyOperation()
const ordinaryString = 'stringOnlyOperation()'
void ordinaryString

export function rawDeviceCreateBuffer(device: GPUDevice): GPUBuffer {

    return device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST,
    })
}

const correctProfileContracts = [
    {
        name: 'wgsl-source',
        proofProfiles: [ 'wgsl-source' ],
        requiredEnableExtensions: [],
        requiredFeatures: [],
        requiredLanguageFeatures: [],
        requiredLimits: [],
        requiredDependencies: [],
        requiredConditions: [],
    },
]
const correctProfileResults = []
for (const contract of correctProfileContracts) {
    const proof = runProfileFixture(contract)
    correctProfileResults.push(proof)
}

const wrongProfileContracts = [
    {
        name: 'wgsl-source',
        proofProfiles: [ 'wgsl-source' ],
        requiredEnableExtensions: [],
        requiredFeatures: [],
        requiredLanguageFeatures: [],
        requiredLimits: [],
        requiredDependencies: [],
        requiredConditions: [],
    },
]
const wrongProfileResults = []
for (const contract of wrongProfileContracts) {
    runProfileFixture(contract)
    const unrelated = { name: 'unrelated' }
    wrongProfileResults.push(unrelated)
}

function runProfileFixture(
    contract: { name: string }
): { name: string } {

    return { name: contract.name }
}
