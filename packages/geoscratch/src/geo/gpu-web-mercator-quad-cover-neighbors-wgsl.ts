/** Indexed closure helpers for one invocation owning the immutable input of each round. */
export const GPU_WEB_MERCATOR_QUAD_COVER_NEIGHBORS_WGSL = String.raw`
// The caller has finished sparse materialization before lending coverCandidates
// to this stage. Its first maximumPatches words become split marks. No other
// invocation may modify these marks, coverPatches, or coverLookup during a round.
// Creation validates maximumPatches * (maximumLevel - minimumLevel + 1) as u32.

fn coverLookupPatchIndex(
    matrixLevel: u32,
    tileRow: u32,
    tileCol: u32,
) -> u32 {
    for (var probe = 0u; probe < coverPolicy.lookupCapacity; probe += 1u) {
        let slot = GpuWebMercatorQuadCover_lookupSlot(
            matrixLevel,
            tileRow,
            tileCol,
            probe,
            coverPolicy.lookupCapacity,
        );
        let entry = coverLookup[slot];
        if (entry.occupied == 0u) { return 0xffffffffu; }
        if (entry.matrixLevel == matrixLevel &&
            entry.tileRow == tileRow &&
            entry.tileCol == tileCol) {
            return entry.patchIndex;
        }
    }
    return 0xffffffffu;
}

fn coverBuildIndexedLeafLookup() -> bool {
    coverClearLookup();
    for (var patchIndex = 0u; patchIndex < coverState.patchCount; patchIndex += 1u) {
        if (!coverLookupInsert(patchIndex)) {
            coverState.lookupOverflowCount += 1u;
            return false;
        }
    }
    return true;
}

// A same-level cell across an edge lies wholly inside any coarser neighbor.
// Prefix freedom makes that covering leaf unique. Fine neighbors are discovered
// by querying from their own fine side; no edge-length scan or corner test is
// needed. The selector's finite world has no west/east wrapping adjacency.
fn coverIndexedCoarserNeighbor(
    candidate: GpuWebMercatorQuadCoverPatch,
    edge: u32,
) -> u32 {
    let matrixWidth = 1u << candidate.matrixLevel;
    var tileRow = candidate.tileRow;
    var tileCol = candidate.tileCol;
    switch edge {
        case 0u: {
            if (tileCol == 0u) { return 0xffffffffu; }
            tileCol -= 1u;
        }
        case 1u: {
            if (tileCol + 1u >= matrixWidth) { return 0xffffffffu; }
            tileCol += 1u;
        }
        case 2u: {
            if (tileRow == 0u) { return 0xffffffffu; }
            tileRow -= 1u;
        }
        case 3u: {
            if (tileRow + 1u >= matrixWidth) { return 0xffffffffu; }
            tileRow += 1u;
        }
        default: { return 0xffffffffu; }
    }
    var matrixLevel = candidate.matrixLevel;
    loop {
        let shift = candidate.matrixLevel - matrixLevel;
        let patchIndex = coverLookupPatchIndex(
            matrixLevel,
            tileRow >> shift,
            tileCol >> shift,
        );
        if (patchIndex != 0xffffffffu) { return patchIndex; }
        if (matrixLevel == coverPolicy.minimumMatrixLevel) { break; }
        matrixLevel -= 1u;
    }
    return 0xffffffffu;
}

// Requires a complete leaf lookup for the current immutable coverPatches.
// Does not rebuild or clear lookup: callers can publish that same final index.
fn coverFinalizeAdjacentLevelDelta() {
    coverState.maximumAdjacentLevelDelta = 0u;
    for (var patchIndex = 0u; patchIndex < coverState.patchCount; patchIndex += 1u) {
        let candidate = coverPatches[patchIndex];
        for (var edge = 0u; edge < 4u; edge += 1u) {
            let neighborIndex = coverIndexedCoarserNeighbor(candidate, edge);
            if (neighborIndex == 0xffffffffu) { continue; }
            let neighbor = coverPatches[neighborIndex];
            coverState.maximumAdjacentLevelDelta = max(
                coverState.maximumAdjacentLevelDelta,
                candidate.matrixLevel - neighbor.matrixLevel,
            );
        }
    }
}

fn coverBalanceIndexedPatches() -> bool {
    let levelCount = coverPolicy.maximumMatrixLevel -
        coverPolicy.minimumMatrixLevel + 1u;
    let maximumRounds = coverPolicy.maximumPatches * levelCount;
    for (var iteration = 0u; iteration < maximumRounds; iteration += 1u) {
        if (!coverBuildIndexedLeafLookup()) { return false; }
        let inputCount = coverState.patchCount;
        for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
            coverCandidates[patchIndex] = 0u;
        }
        var changed = false;
        // Complete all queries and marks before replacing any parent. Every
        // lookup patchIndex refers to this round's unchanged input topology.
        for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
            let candidate = coverPatches[patchIndex];
            for (var edge = 0u; edge < 4u; edge += 1u) {
                let neighborIndex = coverIndexedCoarserNeighbor(candidate, edge);
                if (neighborIndex == 0xffffffffu) { continue; }
                if (candidate.matrixLevel >
                    coverPatches[neighborIndex].matrixLevel + 1u) {
                    coverCandidates[neighborIndex] = 1u;
                    changed = true;
                }
            }
        }
        if (!changed) {
            coverFinalizeAdjacentLevelDelta();
            return coverState.maximumAdjacentLevelDelta <= 1u;
        }
        for (var patchIndex = 0u; patchIndex < inputCount; patchIndex += 1u) {
            if (coverCandidates[patchIndex] != 0u && !coverSplitPatch(patchIndex)) {
                return false;
            }
        }
        coverCompactVisiblePatches();
    }
    // This is an explicit work budget, not a theorem that every input closes
    // within it. Recheck the actual final topology; the caller rejects and
    // revokes any result whose reported adjacency delta still exceeds one.
    if (!coverBuildIndexedLeafLookup()) { return false; }
    coverFinalizeAdjacentLevelDelta();
    return coverState.maximumAdjacentLevelDelta <= 1u;
}
`
