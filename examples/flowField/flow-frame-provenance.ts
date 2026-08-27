import type { TemporalVelocitySnapshot } from './temporal-velocity-raster.ts'

/** Predicts the exact active-pair provenance encoded before dependent GPU sampling. */
export function flowEncodedTemporalSnapshot(
    acknowledged: TemporalVelocitySnapshot,
    currentSnapshotEpoch: number,
    nextSnapshotEpoch: number
): TemporalVelocitySnapshot {

    if (!Number.isSafeInteger(currentSnapshotEpoch) || currentSnapshotEpoch <= 0 ||
        !Number.isSafeInteger(nextSnapshotEpoch) || nextSnapshotEpoch <= 0 ||
        currentSnapshotEpoch < acknowledged.currentSnapshotEpoch ||
        nextSnapshotEpoch < acknowledged.nextSnapshotEpoch) {
        throw new Error('Flow Field publication epochs moved backwards')
    }
    const residencyAdvance = Number(
        currentSnapshotEpoch > acknowledged.currentSnapshotEpoch
    ) + Number(nextSnapshotEpoch > acknowledged.nextSnapshotEpoch)
    return Object.freeze({
        ...acknowledged,
        temporalResidencyEpoch: acknowledged.temporalResidencyEpoch + residencyAdvance,
        currentSnapshotEpoch,
        nextSnapshotEpoch,
    })
}
