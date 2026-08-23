import { layoutCodec } from '../scratch/index.js'

export const gpuWebMercatorQuadDemandPolicyCodec = layoutCodec({
    name: 'GpuWebMercatorQuadDemandPolicy',
    fields: [
        { name: 'minimumSourceMatrixLevel', type: 'u32' },
        { name: 'sourceMaximumMatrixLevel', type: 'u32' },
        { name: 'maximumDemands', type: 'u32' },
        { name: 'coordinateBits', type: 'u32' },
    ],
}, { usage: [ 'uniform', 'storage', 'readback' ] })

export const gpuWebMercatorQuadDemandLimitCodec = layoutCodec({
    name: 'GpuWebMercatorQuadDemandLimit',
    fields: [
        { name: 'matrixLevel', type: 'u32' },
        { name: 'minTileRow', type: 'u32' },
        { name: 'maxTileRow', type: 'u32' },
        { name: 'minTileCol', type: 'u32' },
        { name: 'maxTileCol', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadDemandCodec = layoutCodec({
    name: 'GpuWebMercatorQuadDemand',
    fields: [
        { name: 'desiredSampleLevel', type: 'u32' },
        { name: 'sourceLevelCeiling', type: 'u32' },
        { name: 'requestMatrixLevel', type: 'u32' },
        { name: 'tileRow', type: 'u32' },
        { name: 'tileCol', type: 'u32' },
        { name: 'priority', type: 'u32' },
        { name: 'decisionFrameEpoch', type: 'u32' },
        { name: 'residencySnapshotEpoch', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })

export const gpuWebMercatorQuadDemandStateCodec = layoutCodec({
    name: 'GpuWebMercatorQuadDemandState',
    fields: [
        { name: 'frameEpoch', type: 'u32' },
        { name: 'demandCount', type: 'u32' },
        { name: 'overflowCount', type: 'u32' },
        { name: 'sourceLevelCeiling', type: 'u32' },
    ],
}, { usage: [ 'storage', 'readback' ] })
