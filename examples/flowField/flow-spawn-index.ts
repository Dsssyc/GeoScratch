export type FlowSpawnSample = Readonly<{
    available: boolean
    speed: number
}>

export type FlowSpawnIndex<Candidate> = Readonly<{
    candidates: readonly Candidate[]
    count: number
    capacity: number
    dormant: boolean
}>

/** CPU reference for the bounded GPU support-cell compaction contract. */
export function compactFlowSpawnCandidates<Candidate>(input: Readonly<{
    candidates: readonly Candidate[]
    samples: readonly FlowSpawnSample[]
    activitySpawn: number
    capacity: number
}>): FlowSpawnIndex<Candidate> {

    if (!Array.isArray(input?.candidates) || !Array.isArray(input?.samples) ||
        input.candidates.length !== input.samples.length ||
        !Number.isFinite(input.activitySpawn) || input.activitySpawn < 0 ||
        !Number.isSafeInteger(input.capacity) || input.capacity < 0) {
        throw new TypeError('Flow spawn compaction requires aligned samples and bounded capacity')
    }
    const candidates: Candidate[] = []
    for (let index = 0; index < input.candidates.length; index++) {
        const sample = input.samples[index]
        if (typeof sample?.available !== 'boolean' ||
            !Number.isFinite(sample.speed) || sample.speed < 0) {
            throw new TypeError(`Flow spawn sample ${index} is invalid`)
        }
        if (!sample.available || sample.speed < input.activitySpawn) continue
        if (candidates.length === input.capacity) {
            throw new RangeError('Flow spawn index capacity was exceeded')
        }
        candidates.push(input.candidates[index]!)
    }
    const immutableCandidates = Object.freeze(candidates)
    return Object.freeze({
        candidates: immutableCandidates,
        count: immutableCandidates.length,
        capacity: input.capacity,
        dormant: immutableCandidates.length === 0,
    })
}

/** Selects one compacted support cell without whole-domain rejection sampling. */
export function selectFlowSpawnCandidate<Candidate>(
    index: FlowSpawnIndex<Candidate>,
    randomState: number
): Candidate | undefined {

    if (!Number.isSafeInteger(randomState) || randomState < 0 || randomState > 0xffff_ffff ||
        !Array.isArray(index?.candidates) || !Number.isSafeInteger(index?.count) ||
        index.count !== index.candidates.length || !Number.isSafeInteger(index?.capacity) ||
        index.capacity < index.count || index.dormant !== (index.count === 0)) {
        throw new TypeError('Flow spawn selection requires a coherent bounded index and u32 state')
    }
    return index.count === 0 ? undefined : index.candidates[randomState % index.count]
}
