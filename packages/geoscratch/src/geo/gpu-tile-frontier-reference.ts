import {
    WebMercatorQuad,
    type WebMercatorQuadTileBounds,
} from './web-mercator-quad.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import {
    compareGpuTileFrontierPathOrder,
    gpuTileFrontierPathIsPrefix,
    validateGpuTileFrontierDescriptor,
    type GpuTileFrontierDemand,
    type GpuTileFrontierDescriptor,
    type GpuTileFrontierFacts,
    type GpuTileFrontierLevelMetric,
    type GpuTileFrontierView,
} from './gpu-tile-frontier-layout.js'
import type { VirtualRasterPageIdentity } from './virtual-raster.js'

export type GpuTileFrontierReferenceLodState = 'retain' | 'refine' | 'coarsen'

export type GpuTileFrontierReferenceEntry = Readonly<{
    page: VirtualRasterPageIdentity
    compactIndex: number
    physicalSlot: number
    generation: number
    contentEpoch: number
    residencySnapshotEpoch: number
    previousLodState: GpuTileFrontierReferenceLodState
    lastVisibleFrame: number
    lastDemandFrame: number
    childDemandMask: number
}>

export type GpuTileFrontierReferenceResidentPage = Readonly<{
    page: VirtualRasterPageIdentity
    compactIndex: number
    physicalSlot: number
    generation: number
    contentEpoch: number
    residencySnapshotEpoch: number
}>

export type GpuTileFrontierReferenceInput = Readonly<{
    descriptor: GpuTileFrontierDescriptor
    view: GpuTileFrontierView
    currentFrontier: readonly GpuTileFrontierReferenceEntry[]
    residentPages: readonly GpuTileFrontierReferenceResidentPage[]
    failedPages?: readonly VirtualRasterPageIdentity[]
}>

export type GpuTileFrontierReferenceOutput = Readonly<{
    nextFrontier: readonly GpuTileFrontierReferenceEntry[]
    visible: readonly GpuTileFrontierReferenceEntry[]
    demands: readonly GpuTileFrontierDemand[]
    facts: GpuTileFrontierFacts
}>

type EntryEvaluation = Readonly<{
    entry: GpuTileFrontierReferenceEntry
    matrixLevel: number
    visible: boolean
    sse: number
    projectedArea: number
}>

type RefineCandidate = Readonly<{
    evaluation: EntryEvaluation
    children: readonly VirtualRasterPageIdentity[]
    missingChildren: readonly VirtualRasterPageIdentity[]
    priority: number
    sticky: boolean
}>

type RefinePressure = Readonly<{
    candidates: readonly RefineCandidate[]
    blockedKeys: ReadonlySet<string>
    candidateCount: number
}>

type CoarsenCandidate = Readonly<{
    parent: VirtualRasterPageIdentity
    siblings: readonly GpuTileFrontierReferenceEntry[]
}>

const PRIORITY_BUCKET_COUNT = 256
const U32_MAX = 0xffff_ffff

export function evaluateGpuTileFrontierReference(
    input: GpuTileFrontierReferenceInput
): GpuTileFrontierReferenceOutput {

    validateGpuTileFrontierDescriptor(input.descriptor)
    validateView(input.view)
    const current = validateCurrentFrontier(input)
    const metrics = new Map(input.descriptor.levelMetrics.map(metric => [
        metric.matrixLevel,
        metric,
    ]))
    const residents = residentMap(input)
    const failedPageKeys = terminalFailurePageKeys(input)
    const active: GpuTileFrontierReferenceEntry[] = []
    let staleGenerationCount = 0
    for (const entry of current) {
        const resident = residents.get(entry.page.key)
        if (resident === undefined ||
            resident.compactIndex !== entry.compactIndex ||
            resident.generation !== entry.generation ||
            resident.physicalSlot !== entry.physicalSlot ||
            resident.contentEpoch !== entry.contentEpoch ||
            resident.residencySnapshotEpoch !== input.view.residencySnapshotEpoch ||
            entry.residencySnapshotEpoch > input.view.residencySnapshotEpoch) {
            staleGenerationCount++
            continue
        }
        active.push(entry.residencySnapshotEpoch === resident.residencySnapshotEpoch
            ? entry
            : Object.freeze({
                ...entry,
                residencySnapshotEpoch: resident.residencySnapshotEpoch,
            }))
    }

    // Evaluate fixed-input visibility and SSE before any transition or budget decision.
    const evaluations = active.map(entry => evaluateEntry(entry, input.view, metrics))
    const evaluatedActive = Object.freeze(evaluations.map(evaluation => evaluation.entry))
    if (!frontierIsBalanced(evaluatedActive)) {
        invalidReference('The current frontier must satisfy the level-difference-one invariant.', {
            pages: evaluatedActive.map(entry => entry.page.key),
        })
    }
    const liveRefineEvaluations = evaluations.filter(evaluation => evaluation.visible &&
            evaluation.matrixLevel < input.descriptor.policy.maximumMatrixLevel &&
            evaluation.sse > input.descriptor.policy.refineErrorPixels)
    const terminalBlockedRefineCount = liveRefineEvaluations.filter(evaluation =>
        childPages(input.descriptor, evaluation.entry.page).some(child =>
            failedPageKeys.has(child.key)
        )
    ).length
    const liveRefineCandidates = liveRefineEvaluations
        .filter(evaluation => !childPages(input.descriptor, evaluation.entry.page).some(child =>
            failedPageKeys.has(child.key)
        ))
        .map(evaluation => createRefineCandidate(input, evaluation, residents))
    const refinePressure = createRefinePressure(
        input,
        evaluations,
        evaluatedActive,
        liveRefineCandidates,
        residents
    )

    // Select whole refine transactions through 256 priority buckets and canonical tie order.
    const selectedRefines = selectRefineBudget(
        input,
        evaluatedActive.length,
        refinePressure.candidates
    )
    const selectedRefineKeys = new Set(selectedRefines.selected.map(candidate =>
        candidate.evaluation.entry.page.key
    ))
    const refineOutputs = new Map<string, readonly GpuTileFrontierReferenceEntry[]>()
    const acceptedRefineKeys = new Set<string>()
    const demands: GpuTileFrontierDemand[] = []
    let fallbackCount = refinePressure.blockedKeys.size + terminalBlockedRefineCount
    let acceptedRefineCount = 0
    for (const candidate of selectedRefines.selected) {
        const parent = candidate.evaluation.entry
        if (!refineKeepsBalance(parent, evaluatedActive)) {
            fallbackCount++
            continue
        }
        if (candidate.missingChildren.length === 0) {
            const children = candidate.children.map(page => entryFromResident(
                residents.get(page.key)!,
                input.view.frameEpoch,
                'refine'
            ))
            const candidateOutputs = new Map(refineOutputs)
            candidateOutputs.set(parent.page.key, children)
            if (!frontierIsBalanced(compactCanonical(
                evaluatedActive,
                candidateOutputs,
                new Map()
            ))) {
                fallbackCount++
                continue
            }
            refineOutputs.set(parent.page.key, children)
            acceptedRefineKeys.add(parent.page.key)
            acceptedRefineCount++
            continue
        }
        fallbackCount++
        let childDemandMask = 0
        for (const child of candidate.missingChildren) {
            const childMask = physicalChildMask(child)
            childDemandMask |= childMask
            demands.push(Object.freeze({
                page: child,
                parent: parent.page,
                parentCompactIndex: parent.compactIndex,
                parentPhysicalSlot: parent.physicalSlot,
                parentGeneration: parent.generation,
                priority: candidate.priority,
                decisionFrameEpoch: input.view.frameEpoch,
                residencySnapshotEpoch: input.view.residencySnapshotEpoch,
                childMask,
            }))
        }
        refineOutputs.set(parent.page.key, [ Object.freeze({
            ...parent,
            previousLodState: 'refine',
            lastDemandFrame: input.view.frameEpoch,
            childDemandMask,
        }) ])
    }
    demands.sort((left, right) =>
        compareGpuTileFrontierPathOrder(left.page, right.page) ||
        left.parentCompactIndex - right.parentCompactIndex ||
        left.childMask - right.childMask
    )

    // Coarsen only complete canonical sibling groups after refine acceptance is known.
    const coarsenCandidates = collectCoarsenCandidates(
        input,
        evaluations,
        residents,
        selectedRefineKeys
    )
    const coarsenGracePendingCount = countPendingCoarsenGraceGroups(
        input,
        evaluations,
        residents,
        selectedRefineKeys
    )
    const coarsenOutputs = new Map<string, readonly GpuTileFrontierReferenceEntry[]>()
    let acceptedCoarsenCount = 0
    for (const candidate of coarsenCandidates) {
        const parentResident = residents.get(candidate.parent.key)
        if (parentResident === undefined) continue
        if (!coarsenKeepsBalance(candidate, evaluatedActive, acceptedRefineKeys)) {
            fallbackCount++
            continue
        }
        const lastVisibleFrame = Math.max(...candidate.siblings.map(sibling =>
            sibling.lastVisibleFrame
        ))
        const parentEntry = entryFromResident(
            parentResident,
            lastVisibleFrame,
            'coarsen'
        )
        const candidateOutputs = new Map(coarsenOutputs)
        candidateOutputs.set(candidate.siblings[0]!.page.key, [ parentEntry ])
        for (const sibling of candidate.siblings.slice(1)) {
            candidateOutputs.set(sibling.page.key, [])
        }
        if (!frontierIsBalanced(compactCanonical(
            evaluatedActive,
            refineOutputs,
            candidateOutputs
        ))) {
            fallbackCount++
            continue
        }
        coarsenOutputs.clear()
        for (const [ key, output ] of candidateOutputs) coarsenOutputs.set(key, output)
        acceptedCoarsenCount++
    }

    const nextFrontier = compactCanonical(evaluatedActive, refineOutputs, coarsenOutputs)

    // Visible output is a stable prefix compaction over the accepted next frontier.
    const visible = Object.freeze(nextFrontier.filter(entry =>
        evaluateEntry(entry, input.view, metrics).visible
    ))
    const selectedLevels = nextFrontier.map(matrixLevelOf)
    const maximumObservedSse = evaluations.reduce(
        (maximum, evaluation) => Math.max(maximum, evaluation.sse),
        0
    )
    const budgetLimitedCount = selectedRefines.rejectedCount
    const facts: GpuTileFrontierFacts = Object.freeze({
        frameEpoch: input.view.frameEpoch,
        residencySnapshotEpoch: input.view.residencySnapshotEpoch,
        activeFrontierCount: nextFrontier.length,
        visibleInstanceCount: visible.length,
        refineCandidateCount: refinePressure.candidateCount,
        coarsenCandidateCount: coarsenCandidates.length,
        coarsenGracePendingCount,
        demandCount: demands.length,
        fallbackCount,
        staleGenerationCount,
        budgetLimitedCount,
        maximumObservedSse,
        ...(selectedLevels.length === 0 ? {} : {
            minimumSelectedMatrixLevel: Math.min(...selectedLevels),
            maximumSelectedMatrixLevel: Math.max(...selectedLevels),
        }),
        frontierOverflow: false,
        demandOverflow: false,
        visibleOverflow: false,
        convergenceState: budgetLimitedCount > 0
            ? 'budget-limited'
            : demands.length > 0 || acceptedRefineCount > 0 ||
                acceptedCoarsenCount > 0 || coarsenGracePendingCount > 0
                ? 'transitioning'
                : 'converged',
    })

    return Object.freeze({
        nextFrontier,
        visible,
        demands: Object.freeze(demands),
        facts,
    })
}

function terminalFailurePageKeys(
    input: GpuTileFrontierReferenceInput
): ReadonlySet<string> {

    const result = new Set<string>()
    for (const page of input.failedPages ?? []) {
        input.descriptor.gpuState.addressSpace.assertPage(page)
        if (result.has(page.key)) {
            invalidReference('Terminally failed frontier pages must be unique.', {
                page: page.key,
            })
        }
        result.add(page.key)
    }
    return result
}

function residentMap(
    input: GpuTileFrontierReferenceInput
): Map<string, GpuTileFrontierReferenceResidentPage> {

    if (!Array.isArray(input.residentPages)) {
        invalidReference('Resident frontier pages must be an array.', input.residentPages)
    }
    const result = new Map<string, GpuTileFrontierReferenceResidentPage>()
    const compactIndexes = new Set<number>()
    const physicalSlots = new Set<number>()
    for (const resident of input.residentPages) {
        const expectedCompactIndex = compactIndexForPage(input.descriptor, resident.page)
        if (result.has(resident.page.key) ||
            compactIndexes.has(resident.compactIndex) ||
            physicalSlots.has(resident.physicalSlot) ||
            !u32(resident.compactIndex) ||
            resident.compactIndex !== expectedCompactIndex ||
            !u32(resident.physicalSlot) ||
            resident.physicalSlot >= input.descriptor.gpuState.maxPhysicalPages ||
            !u32(resident.generation) ||
            !u32(resident.contentEpoch) ||
            !u32(resident.residencySnapshotEpoch)) {
            invalidReference(
                'Resident frontier pages, compact indexes, and physical slots must be canonical and one-to-one.',
                resident
            )
        }
        result.set(resident.page.key, resident)
        compactIndexes.add(resident.compactIndex)
        physicalSlots.add(resident.physicalSlot)
    }
    return result
}

function validateCurrentFrontier(
    input: GpuTileFrontierReferenceInput
): readonly GpuTileFrontierReferenceEntry[] {

    if (!Array.isArray(input.currentFrontier) ||
        input.currentFrontier.length > input.descriptor.policy.maximumActiveTiles) {
        invalidReference(
            'Current frontier must be an array within active-frontier capacity.',
            {
                currentFrontierLength: input.currentFrontier?.length,
                maximumActiveTiles: input.descriptor.policy.maximumActiveTiles,
            }
        )
    }
    const pageKeys = new Set<string>()
    const compactIndexes = new Set<number>()
    for (const entry of input.currentFrontier) {
        validateEntry(input.descriptor, entry)
        if (pageKeys.has(entry.page.key) || compactIndexes.has(entry.compactIndex)) {
            invalidReference(
                'Current frontier page keys and compact indexes must be canonical and one-to-one.',
                entry
            )
        }
        pageKeys.add(entry.page.key)
        compactIndexes.add(entry.compactIndex)
    }
    const canonical = canonicalEntries(input.currentFrontier)
    for (let index = 1; index < canonical.length; index++) {
        if (gpuTileFrontierPathIsPrefix(
            canonical[index - 1]!.page,
            canonical[index]!.page
        )) {
            invalidReference(
                'Current frontier tile paths must be prefix-free.',
                {
                    prefix: canonical[index - 1]!.page.key,
                    candidate: canonical[index]!.page.key,
                }
            )
        }
    }
    return canonical
}

function validateEntry(
    descriptor: GpuTileFrontierDescriptor,
    entry: GpuTileFrontierReferenceEntry
): void {

    const expectedCompactIndex = compactIndexForPage(descriptor, entry.page)
    if (!u32(entry.compactIndex) ||
        entry.compactIndex !== expectedCompactIndex ||
        !u32(entry.physicalSlot) ||
        entry.physicalSlot >= descriptor.gpuState.maxPhysicalPages ||
        !u32(entry.generation) ||
        !u32(entry.contentEpoch) ||
        !u32(entry.residencySnapshotEpoch) ||
        !u32(entry.lastVisibleFrame) ||
        !u32(entry.lastDemandFrame) ||
        !u32(entry.childDemandMask) ||
        ![ 'retain', 'refine', 'coarsen' ].includes(entry.previousLodState)) {
        invalidReference('Frontier entries must contain bounded canonical GPU facts.', entry)
    }
}

function compactIndexForPage(
    descriptor: GpuTileFrontierDescriptor,
    page: VirtualRasterPageIdentity
): number {

    try {
        descriptor.gpuState.addressSpace.assertPage(page)
    } catch {
        invalidReference('Frontier records require pages from the descriptor address space.', page)
    }
    if (page.tile === undefined) {
        invalidReference('Frontier records require tile-backed page identities.', page)
    }
    let compactIndex: number
    try {
        compactIndex = descriptor.addressCodec.coverage.index(page.tile)
    } catch {
        invalidReference('Frontier record pages must lie within descriptor coverage.', page)
    }
    if (!u32(compactIndex)) {
        invalidReference('Frontier record compact indexes must fit the packed u32 ABI.', {
            page: page.key,
            compactIndex,
        })
    }
    return compactIndex
}

function validateView(view: GpuTileFrontierView): void {

    const matrix = Array.from(view.clipFromRelativeWorld)
    const values = [
        ...matrix,
        ...view.cameraHigh,
        ...view.cameraLow,
        ...view.viewport,
        view.verticalFovRadians,
        view.cameraLatitudeRadians,
        view.zoomHint,
        view.frameEpoch,
        view.residencySnapshotEpoch,
    ]
    if (matrix.length !== 16 ||
        view.cameraHigh.length !== 3 ||
        view.cameraLow.length !== 3 ||
        view.viewport.length !== 2 ||
        values.some(value => !Number.isFinite(value)) ||
        view.viewport.some(value => value <= 0) ||
        view.verticalFovRadians <= 0 ||
        view.verticalFovRadians >= Math.PI ||
        !u32(view.frameEpoch) ||
        !u32(view.residencySnapshotEpoch)) {
        invalidReference('GPU tile frontier view facts must be finite and dimensionally exact.', view)
    }
}

function evaluateEntry(
    entry: GpuTileFrontierReferenceEntry,
    view: GpuTileFrontierView,
    metrics: ReadonlyMap<number, GpuTileFrontierLevelMetric>
): EntryEvaluation {

    const matrixLevel = matrixLevelOf(entry)
    const metric = metrics.get(matrixLevel)
    if (metric === undefined) {
        invalidReference('A frontier entry has no metric for its matrix level.', {
            page: entry.page.key,
            matrixLevel,
        })
    }
    const bounds = WebMercatorQuad.tileBounds(entry.page.tile!)
    const corners = clipCorners(bounds, metric, view)
    const visible = !outsideClip(corners)
    const evaluatedEntry = visible && entry.lastVisibleFrame !== view.frameEpoch
        ? Object.freeze({ ...entry, lastVisibleFrame: view.frameEpoch })
        : entry
    const distance = distanceToBounds(bounds, metric, view)
    const sse = metric.geometricErrorMeters * view.viewport[1] /
        (2 * Math.tan(view.verticalFovRadians / 2) * Math.max(distance, 1e-6))
    return Object.freeze({
        entry: evaluatedEntry,
        matrixLevel,
        visible,
        sse,
        projectedArea: visible ? projectedArea(corners) : 0,
    })
}

function createRefinePressure(
    input: GpuTileFrontierReferenceInput,
    evaluations: readonly EntryEvaluation[],
    active: readonly GpuTileFrontierReferenceEntry[],
    liveCandidates: readonly RefineCandidate[],
    residents: ReadonlyMap<string, GpuTileFrontierReferenceResidentPage>
): RefinePressure {

    const evaluationsByKey = new Map(evaluations.map(evaluation => [
        evaluation.entry.page.key,
        evaluation,
    ]))
    const candidateByKey = new Map<string, RefineCandidate>()
    const candidateKeys = new Set<string>()
    const blockedKeys = new Set<string>()
    const blockersByCandidate = new Map<string, GpuTileFrontierReferenceEntry[]>()
    for (const candidate of liveCandidates) {
        const parent = candidate.evaluation.entry
        candidateKeys.add(parent.page.key)
        const parentLevel = candidate.evaluation.matrixLevel
        const blockers = active.filter(neighbor =>
            neighbor.page.key !== parent.page.key &&
            areNeighbors(parent, neighbor) &&
            matrixLevelOf(neighbor) < parentLevel
        )
        blockersByCandidate.set(parent.page.key, blockers)
        if (blockers.length === 0) candidateByKey.set(parent.page.key, candidate)
        else blockedKeys.add(parent.page.key)
    }
    for (const candidate of liveCandidates) {
        for (const blocker of blockersByCandidate.get(candidate.evaluation.entry.page.key)!) {
            candidateKeys.add(blocker.page.key)
            if (blockedKeys.has(blocker.page.key)) continue
            const evaluation = evaluationsByKey.get(blocker.page.key)!
            const pressureCandidate = createRefineCandidate(input, evaluation, residents)
            const existing = candidateByKey.get(blocker.page.key)
            candidateByKey.set(blocker.page.key, Object.freeze({
                ...pressureCandidate,
                priority: Math.max(
                    existing?.priority ?? 0,
                    candidate.priority,
                    pressureCandidate.priority
                ),
            }))
        }
    }
    return Object.freeze({
        candidates: Object.freeze([ ...candidateByKey.values() ]),
        blockedKeys,
        candidateCount: candidateKeys.size,
    })
}

function createRefineCandidate(
    input: GpuTileFrontierReferenceInput,
    evaluation: EntryEvaluation,
    residents: ReadonlyMap<string, GpuTileFrontierReferenceResidentPage>
): RefineCandidate {

    const children = childPages(input.descriptor, evaluation.entry.page)
    const missingChildren = children.filter(page => {
        const resident = residents.get(page.key)
        return resident === undefined ||
            resident.residencySnapshotEpoch !== input.view.residencySnapshotEpoch
    })
    const missingChildMask = missingChildren.reduce(
        (mask, child) => mask | physicalChildMask(child),
        0
    )
    return Object.freeze({
        evaluation,
        children,
        missingChildren,
        priority: priorityBucket(input, evaluation, missingChildren.length),
        sticky: evaluation.entry.previousLodState === 'refine' &&
            (evaluation.entry.childDemandMask & missingChildMask) !== 0,
    })
}

function selectRefineBudget(
    input: GpuTileFrontierReferenceInput,
    currentCount: number,
    candidates: readonly RefineCandidate[]
): Readonly<{ selected: readonly RefineCandidate[], rejectedCount: number }> {

    const buckets = Array.from(
        { length: PRIORITY_BUCKET_COUNT },
        () => [] as RefineCandidate[]
    )
    const canonical = [ ...candidates ].sort((left, right) =>
        compareGpuTileFrontierPathOrder(
            left.evaluation.entry.page,
            right.evaluation.entry.page
        )
    )
    for (const candidate of canonical) {
        buckets[candidate.priority]!.push(candidate)
    }
    const selected: RefineCandidate[] = []
    let demandCount = 0
    let transitionPages = 0
    const accept = (candidate: RefineCandidate): boolean => {
        const nextActiveCount = currentCount + (selected.length + 1) * 3
        const nextDemandCount = demandCount + candidate.missingChildren.length
        const nextTransitionPages = transitionPages + candidate.missingChildren.length
        if (nextActiveCount > input.descriptor.policy.maximumActiveTiles ||
            nextDemandCount > input.descriptor.policy.maximumDemands ||
            nextTransitionPages > input.descriptor.policy.transitionReservePages) return false
        selected.push(candidate)
        demandCount = nextDemandCount
        transitionPages = nextTransitionPages
        return true
    }
    for (const candidate of canonical) {
        if (candidate.sticky) accept(candidate)
    }
    for (let bucket = PRIORITY_BUCKET_COUNT - 1; bucket >= 0; bucket--) {
        for (const candidate of buckets[bucket]!) {
            if (!candidate.sticky) accept(candidate)
        }
    }
    return Object.freeze({
        selected: Object.freeze(selected),
        rejectedCount: candidates.length - selected.length,
    })
}

function physicalChildMask(page: VirtualRasterPageIdentity): number {

    const tile = page.tile!
    return 1 << ((tile.tileRow % 2) * 2 + tile.tileCol % 2)
}

function collectCoarsenCandidates(
    input: GpuTileFrontierReferenceInput,
    evaluations: readonly EntryEvaluation[],
    residents: ReadonlyMap<string, GpuTileFrontierReferenceResidentPage>,
    selectedRefineKeys: ReadonlySet<string>
): readonly CoarsenCandidate[] {

    const eligible = evaluations.filter(evaluation =>
        evaluation.matrixLevel > input.descriptor.policy.minimumMatrixLevel &&
        (evaluation.visible
            ? evaluation.sse < input.descriptor.policy.coarsenErrorPixels
            : Math.max(0, input.view.frameEpoch - evaluation.entry.lastVisibleFrame) >
                input.descriptor.policy.invisibleGraceFrames) &&
        !selectedRefineKeys.has(evaluation.entry.page.key)
    )
    const eligibleByKey = new Map(eligible.map(evaluation => [
        evaluation.entry.page.key,
        evaluation.entry,
    ]))
    const seenParents = new Set<string>()
    const candidates: CoarsenCandidate[] = []
    for (const evaluation of eligible) {
        const parent = input.descriptor.gpuState.addressSpace.parent(evaluation.entry.page)
        if (parent === undefined || seenParents.has(parent.key)) continue
        seenParents.add(parent.key)
        const siblingPages = childPages(input.descriptor, parent)
        const siblings = siblingPages.map(page => eligibleByKey.get(page.key))
        if (siblings.some(sibling => sibling === undefined) ||
            residents.get(parent.key)?.residencySnapshotEpoch !==
                input.view.residencySnapshotEpoch) continue
        candidates.push(Object.freeze({
            parent,
            siblings: Object.freeze(siblings as GpuTileFrontierReferenceEntry[]),
        }))
    }
    return Object.freeze(candidates.sort((left, right) =>
        compareGpuTileFrontierPathOrder(
            left.siblings[0]!.page,
            right.siblings[0]!.page
        )
    ))
}

function countPendingCoarsenGraceGroups(
    input: GpuTileFrontierReferenceInput,
    evaluations: readonly EntryEvaluation[],
    residents: ReadonlyMap<string, GpuTileFrontierReferenceResidentPage>,
    selectedRefineKeys: ReadonlySet<string>
): number {

    const evaluationsByKey = new Map(evaluations.map(evaluation => [
        evaluation.entry.page.key,
        evaluation,
    ]))
    const seenParents = new Set<string>()
    let pendingCount = 0
    for (const evaluation of evaluations) {
        if (evaluation.matrixLevel <= input.descriptor.policy.minimumMatrixLevel ||
            evaluation.visible ||
            Math.max(0, input.view.frameEpoch - evaluation.entry.lastVisibleFrame) >
                input.descriptor.policy.invisibleGraceFrames) continue
        const parent = input.descriptor.gpuState.addressSpace.parent(evaluation.entry.page)
        if (parent === undefined || seenParents.has(parent.key)) continue
        seenParents.add(parent.key)
        if (residents.get(parent.key)?.residencySnapshotEpoch !==
            input.view.residencySnapshotEpoch) continue
        const siblingEvaluations = childPages(input.descriptor, parent).map(page =>
            evaluationsByKey.get(page.key)
        )
        if (siblingEvaluations.some(sibling => sibling === undefined)) continue
        const groupCanCoarsenAfterGrace = siblingEvaluations.every(sibling => {
            const candidate = sibling!
            if (selectedRefineKeys.has(candidate.entry.page.key)) return false
            return candidate.visible
                ? candidate.sse < input.descriptor.policy.coarsenErrorPixels
                : candidate.matrixLevel > input.descriptor.policy.minimumMatrixLevel
        })
        if (groupCanCoarsenAfterGrace) pendingCount++
    }
    return pendingCount
}

function compactCanonical(
    active: readonly GpuTileFrontierReferenceEntry[],
    refineOutputs: ReadonlyMap<string, readonly GpuTileFrontierReferenceEntry[]>,
    coarsenOutputs: ReadonlyMap<string, readonly GpuTileFrontierReferenceEntry[]>
): readonly GpuTileFrontierReferenceEntry[] {

    const result: GpuTileFrontierReferenceEntry[] = []
    for (const entry of active) {
        const refine = refineOutputs.get(entry.page.key)
        const coarsen = coarsenOutputs.get(entry.page.key)
        if (refine !== undefined) result.push(...refine)
        else if (coarsen !== undefined) result.push(...coarsen)
        else result.push(entry)
    }
    return Object.freeze(result)
}

function childPages(
    descriptor: GpuTileFrontierDescriptor,
    parent: VirtualRasterPageIdentity
): readonly VirtualRasterPageIdentity[] {

    const parentLevel = Number(parent.tile?.matrixId)
    const childLevel = parentLevel + 1
    if (!Number.isSafeInteger(parentLevel) ||
        childLevel > descriptor.policy.maximumMatrixLevel) return Object.freeze([])
    const row = parent.tile!.tileRow * 2
    const col = parent.tile!.tileCol * 2
    const candidates = [
        { matrixId: String(childLevel), tileRow: row, tileCol: col },
        { matrixId: String(childLevel), tileRow: row, tileCol: col + 1 },
        { matrixId: String(childLevel), tileRow: row + 1, tileCol: col },
        { matrixId: String(childLevel), tileRow: row + 1, tileCol: col + 1 },
    ]
    return Object.freeze(candidates
        .filter(candidate => descriptor.addressCodec.coverage.contains(candidate))
        .map(candidate => descriptor.gpuState.addressSpace.pageFromTile(candidate)))
}

function entryFromResident(
    resident: GpuTileFrontierReferenceResidentPage,
    lastVisibleFrame: number,
    state: GpuTileFrontierReferenceLodState
): GpuTileFrontierReferenceEntry {

    return Object.freeze({
        page: resident.page,
        compactIndex: resident.compactIndex,
        physicalSlot: resident.physicalSlot,
        generation: resident.generation,
        contentEpoch: resident.contentEpoch,
        residencySnapshotEpoch: resident.residencySnapshotEpoch,
        previousLodState: state,
        lastVisibleFrame,
        lastDemandFrame: 0,
        childDemandMask: 0,
    })
}

function refineKeepsBalance(
    parent: GpuTileFrontierReferenceEntry,
    active: readonly GpuTileFrontierReferenceEntry[]
): boolean {

    const parentLevel = matrixLevelOf(parent)
    return active.every(neighbor =>
        neighbor.page.key === parent.page.key ||
        !areNeighbors(parent, neighbor) ||
        matrixLevelOf(neighbor) >= parentLevel
    )
}

function coarsenKeepsBalance(
    candidate: CoarsenCandidate,
    active: readonly GpuTileFrontierReferenceEntry[],
    acceptedRefineKeys: ReadonlySet<string>
): boolean {

    const siblingKeys = new Set(candidate.siblings.map(sibling => sibling.page.key))
    const childLevel = matrixLevelOf(candidate.siblings[0]!)
    const parentEntry = candidate.siblings[0]!
    const parentBoundsEntry = Object.freeze({ ...parentEntry, page: candidate.parent })
    for (const entry of active) {
        if (siblingKeys.has(entry.page.key) || !areNeighbors(parentBoundsEntry, entry)) continue
        if (matrixLevelOf(entry) > childLevel || acceptedRefineKeys.has(entry.page.key)) return false
    }
    return true
}

function frontierIsBalanced(entries: readonly GpuTileFrontierReferenceEntry[]): boolean {

    for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
            const left = entries[leftIndex]!
            const right = entries[rightIndex]!
            if (areNeighbors(left, right) &&
                Math.abs(matrixLevelOf(left) - matrixLevelOf(right)) > 1) return false
        }
    }
    return true
}

function areNeighbors(
    left: Pick<GpuTileFrontierReferenceEntry, 'page'>,
    right: Pick<GpuTileFrontierReferenceEntry, 'page'>
): boolean {

    const leftBounds = normalizedBounds(left.page)
    const rightBounds = normalizedBounds(right.page)
    const verticalTouch = equal(leftBounds.east, rightBounds.west) ||
        equal(rightBounds.east, leftBounds.west)
    const horizontalTouch = equal(leftBounds.south, rightBounds.north) ||
        equal(rightBounds.south, leftBounds.north)
    return verticalTouch && overlap(leftBounds.north, leftBounds.south,
        rightBounds.north, rightBounds.south) ||
        horizontalTouch && overlap(leftBounds.west, leftBounds.east,
            rightBounds.west, rightBounds.east)
}

function normalizedBounds(page: VirtualRasterPageIdentity): Readonly<{
    west: number
    north: number
    east: number
    south: number
}> {

    const level = Number(page.tile!.matrixId)
    const scale = 2 ** level
    return Object.freeze({
        west: page.tile!.tileCol / scale,
        north: page.tile!.tileRow / scale,
        east: (page.tile!.tileCol + 1) / scale,
        south: (page.tile!.tileRow + 1) / scale,
    })
}

function priorityBucket(
    input: GpuTileFrontierReferenceInput,
    evaluation: EntryEvaluation,
    incrementalSlotCost: number
): number {

    const excess = Math.max(
        0,
        evaluation.sse - input.descriptor.policy.refineErrorPixels
    )
    const sseScore = Math.round(127 * excess / Math.max(
        evaluation.sse,
        input.descriptor.policy.refineErrorPixels
    ))
    const areaScore = Math.round(63 * Math.min(1, evaluation.projectedArea / 4))
    const age = Math.max(
        0,
        input.view.frameEpoch - evaluation.entry.lastDemandFrame
    )
    const ageScore = Math.min(63, age)
    const costPenalty = Math.min(63, Math.max(0, incrementalSlotCost - 1) * 8)
    return Math.max(0, Math.min(
        PRIORITY_BUCKET_COUNT - 1,
        sseScore + areaScore + ageScore - costPenalty
    ))
}

function clipCorners(
    bounds: WebMercatorQuadTileBounds,
    metric: GpuTileFrontierLevelMetric,
    view: GpuTileFrontierView
): readonly (readonly [number, number, number, number])[] {

    const camera = [
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
        view.cameraHigh[2] + view.cameraLow[2],
    ]
    const result: (readonly [number, number, number, number])[] = []
    for (const x of [ bounds.projected.west, bounds.projected.east ]) {
        for (const y of [ bounds.projected.south, bounds.projected.north ]) {
            for (const z of [
                metric.minimumElevationMeters,
                metric.maximumElevationMeters,
            ]) {
                result.push(transformPoint(view.clipFromRelativeWorld, [
                    x - camera[0]!,
                    y - camera[1]!,
                    z - camera[2]!,
                ]))
            }
        }
    }
    return Object.freeze(result)
}

function transformPoint(
    matrix: ArrayLike<number>,
    point: readonly [number, number, number]
): readonly [number, number, number, number] {

    const [ x, y, z ] = point
    return Object.freeze([
        matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
        matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
        matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
        matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!,
    ])
}

function outsideClip(corners: readonly (readonly [number, number, number, number])[]): boolean {

    return [
        (corner: readonly number[]) => corner[0]! < -corner[3]!,
        (corner: readonly number[]) => corner[0]! > corner[3]!,
        (corner: readonly number[]) => corner[1]! < -corner[3]!,
        (corner: readonly number[]) => corner[1]! > corner[3]!,
        (corner: readonly number[]) => corner[2]! < 0,
        (corner: readonly number[]) => corner[2]! > corner[3]!,
    ].some(outside => corners.every(outside))
}

function projectedArea(
    corners: readonly (readonly [number, number, number, number])[]
): number {

    const points = corners
        .filter(corner => corner[3] !== 0)
        .map(corner => [ corner[0] / corner[3], corner[1] / corner[3] ] as const)
    if (points.length === 0) return 0
    const xs = points.map(point => Math.max(-1, Math.min(1, point[0])))
    const ys = points.map(point => Math.max(-1, Math.min(1, point[1])))
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
}

function distanceToBounds(
    bounds: WebMercatorQuadTileBounds,
    metric: GpuTileFrontierLevelMetric,
    view: GpuTileFrontierView
): number {

    const camera = [
        view.cameraHigh[0] + view.cameraLow[0],
        view.cameraHigh[1] + view.cameraLow[1],
        view.cameraHigh[2] + view.cameraLow[2],
    ] as const
    const dx = distanceToInterval(camera[0], bounds.projected.west, bounds.projected.east)
    const dy = distanceToInterval(camera[1], bounds.projected.south, bounds.projected.north)
    const dz = distanceToInterval(
        camera[2],
        metric.minimumElevationMeters,
        metric.maximumElevationMeters
    )
    return Math.hypot(dx, dy, dz)
}

function distanceToInterval(value: number, minimum: number, maximum: number): number {

    if (value < minimum) return minimum - value
    if (value > maximum) return value - maximum
    return 0
}

function matrixLevelOf(entry: Pick<GpuTileFrontierReferenceEntry, 'page'>): number {

    const matrixLevel = Number(entry.page.tile?.matrixId)
    if (!Number.isSafeInteger(matrixLevel) || matrixLevel < 0) {
        invalidReference('Reference frontier pages require numeric WebMercatorQuad levels.', entry.page)
    }
    return matrixLevel
}

function canonicalEntries(
    entries: readonly GpuTileFrontierReferenceEntry[]
): readonly GpuTileFrontierReferenceEntry[] {

    return Object.freeze([ ...entries ].sort((left, right) =>
        compareGpuTileFrontierPathOrder(left.page, right.page)
    ))
}

function overlap(
    leftMinimum: number,
    leftMaximum: number,
    rightMinimum: number,
    rightMaximum: number
): boolean {

    return Math.min(leftMaximum, rightMaximum) -
        Math.max(leftMinimum, rightMinimum) > 1e-12
}

function equal(left: number, right: number): boolean {

    return Math.abs(left - right) <= 1e-12
}

function u32(value: number): boolean {

    return Number.isSafeInteger(value) && value >= 0 && value <= U32_MAX
}

function invalidReference(message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code: 'GEO_GPU_TILE_FRONTIER_INVALID',
        phase: 'selection',
        subject: { kind: 'gpu-tile-frontier-reference' },
        message,
        expected: { input: 'finite canonical frontier records' },
        actual,
    })
}
