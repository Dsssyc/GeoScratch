import { createGeoDiagnostic, GeoDiagnosticError, throwGeoDiagnostic } from './diagnostics.js'
import { createGeoViewSnapshot, type GeoViewSnapshot } from './geo-view.js'
import { gpuWebMercatorQuadCoverCandidates } from './gpu-web-mercator-quad-cover-candidates.js'
import { gpuWebMercatorQuadCoverMapMetaCodec } from './gpu-web-mercator-quad-cover-layout.js'
import { snapshotWebMercatorCoverVerticalBounds } from './gpu-web-mercator-quad-cover-vertical-bounds.js'
import type { WebMercatorTileVerticalBounds } from './gpu-web-mercator-quad-cover.js'
import type { WebMercatorPlanarTileSpatialProfile } from './tile-spatial-profile.js'
import { WebMercatorQuad } from './web-mercator-quad.js'
import { WebMercatorQuadCoverKernel } from './web-mercator-quad-cover-kernel.js'

export type WebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanReferencePixels: number
    refinementTolerance: number
}>

export type WebMercatorQuadCoverDescriptor = Readonly<{
    spatialProfile: WebMercatorPlanarTileSpatialProfile
    policy: WebMercatorQuadCoverPolicy
    verticalRangeMeters: readonly [number, number]
    maximumCandidates?: number
    verticalBounds?: readonly WebMercatorTileVerticalBounds[]
}>

export type WebMercatorQuadCoverPatch = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
}>

export type WebMercatorQuadCoverSelectionFacts = Readonly<{
    coverId: string
    selectionId: string
    selectionRevision: number
    frameEpoch: number
    candidateCount: number
    patchCount: number
    descriptorOverflowCount: number
    lookupOverflowCount: number
    maximumAdjacentLevelDelta: number
    finestMatrixLevel: number
    minimumMatrixLevel?: number
    maximumMatrixLevel?: number
    minimumCellSpanReferencePixels?: number
    maximumCellSpanReferencePixels?: number
}>

/** Complete immutable CPU geometry, independent of raster availability and later selections. */
export type WebMercatorQuadCoverSelection = Readonly<{
    kind: 'web-mercator-quad-cover-selection'
    id: string
    coverId: string
    revision: number
    view: GeoViewSnapshot
    patches: readonly WebMercatorQuadCoverPatch[]
    facts: WebMercatorQuadCoverSelectionFacts
}>

export type WebMercatorQuadCoverFacts = Readonly<{
    id: string
    selectionPath: 'cpu-camera-inverse-webmercatorquad-cover'
    disposed: boolean
    policy: WebMercatorQuadCoverPolicy
    coordinateBits: number
    lookupCapacity: number
    candidateCapacity: number
    workspaceBytes: number
    coverageLimitCount: number
    verticalBoundsMode: 'global' | 'hierarchy'
    verticalBoundCount: number
}>

type NormalizedDescriptor = WebMercatorQuadCoverDescriptor & Readonly<{ maximumCandidates: number }>

/** @internal Packed storage never crosses the public API boundary. */
export type WebMercatorQuadCoverSelectionData = Readonly<{
    owner: WebMercatorQuadCover
    descriptor: NormalizedDescriptor
    mapMeta: Uint8Array
    patches: Uint32Array
    lookup: Uint32Array
    state: Uint32Array
}>

const owners = new WeakMap<WebMercatorQuadCover, NormalizedDescriptor>()
const selections = new WeakMap<WebMercatorQuadCoverSelection, WebMercatorQuadCoverSelectionData>()
let nextCoverId = 1

/** Computes stateless, certified standard-tile cuts on the CPU and owns only bounded CPU workspace. */
export class WebMercatorQuadCover {
    #id = `geo-web-mercator-quad-cover-${nextCoverId++}`
    #descriptor: NormalizedDescriptor
    #kernel: WebMercatorQuadCoverKernel | undefined
    #lookupCapacity: number
    #selectionSequence = 0

    constructor(input: WebMercatorQuadCoverDescriptor) {
        const descriptor = snapshotDescriptor(input)
        const capacity = lookupCapacity(descriptor.policy.maximumPatches)
        const first = descriptor.spatialProfile.coverage.limits[0]!
        this.#descriptor = descriptor
        this.#lookupCapacity = capacity
        try {
            this.#kernel = new WebMercatorQuadCoverKernel({
                coordinateBits: descriptor.spatialProfile.coordinateBits,
                row: first.minTileRow, col: first.minTileCol,
                width: first.maxTileCol - first.minTileCol + 1,
                height: first.maxTileRow - first.minTileRow + 1,
                limits: descriptor.spatialProfile.coverage.limits,
                verticalRange: descriptor.verticalRangeMeters,
                ...(descriptor.verticalBounds === undefined ? {} : { verticalBounds: descriptor.verticalBounds }),
            }, descriptor.policy, capacity)
        } catch (cause) {
            throw new GeoDiagnosticError(createGeoDiagnostic({
                code: 'GEO_WEB_MERCATOR_COVER_WORKSPACE_ALLOCATION_FAILED',
                phase: 'selection', subject: { kind: 'web-mercator-quad-cover', id: this.id },
                message: 'CPU cover workspace could not be allocated.',
                actual: { maximumPatches: descriptor.policy.maximumPatches, lookupCapacity: capacity },
            }), { cause })
        }
        owners.set(this, descriptor)
        Object.preventExtensions(this)
    }

    get id(): string { return this.#id }
    get descriptor(): WebMercatorQuadCoverDescriptor { return this.#descriptor }
    get isDisposed(): boolean { return this.#kernel === undefined }

    select(input: GeoViewSnapshot): WebMercatorQuadCoverSelection {
        if (this.#kernel === undefined) return selectionFailure(this.id, 'disposed', {})
        if (input?.kind !== 'geo-view-snapshot') return selectionFailure(this.id, 'view', {})
        // Validate and copy the camera boundary. Geometry never observes later host mutation.
        const view = createGeoViewSnapshot(input)
        const mapMeta = gpuWebMercatorQuadCoverMapMetaCodec.pack(mapMetadata(this.#descriptor, view))
        const result = this.#kernel.run(mapMeta)
        if (!Number.isSafeInteger(this.#kernel.candidateCount) || this.#kernel.candidateCount > 0xffff_ffff)
            return selectionFailure(this.id, 'work-counter-overflow', { candidateCount: this.#kernel.candidateCount })
        const id = `${this.id}/selection-${this.#selectionSequence + 1}`
        const revision = this.#selectionSequence + 1
        const facts = selectionFacts(this.id, id, revision, result.state, this.#descriptor.policy.maximumPatches)
        const patches = result.patches.slice()
        const patchFacts: WebMercatorQuadCoverPatch[] = []
        for (let i = 0; i < patches.length; i += 3) {
            patchFacts.push(Object.freeze({ matrixLevel: patches[i], tileRow: patches[i + 1], tileCol: patches[i + 2] }))
        }
        const selection: WebMercatorQuadCoverSelection = Object.freeze({
            kind: 'web-mercator-quad-cover-selection', id, coverId: this.id, revision,
            view, patches: Object.freeze(patchFacts), facts,
        })
        selections.set(selection, Object.freeze({ owner: this, descriptor: this.#descriptor,
            mapMeta, patches, lookup: result.lookup.slice(), state: result.state.slice() }))
        this.#selectionSequence++
        return selection
    }

    facts(): WebMercatorQuadCoverFacts {
        const descriptor = this.#descriptor
        return Object.freeze({
            id: this.id, selectionPath: 'cpu-camera-inverse-webmercatorquad-cover',
            disposed: this.isDisposed, policy: descriptor.policy,
            coordinateBits: descriptor.spatialProfile.coordinateBits,
            lookupCapacity: this.#lookupCapacity, candidateCapacity: descriptor.maximumCandidates,
            workspaceBytes: this.isDisposed ? 0 : this.#lookupCapacity * 20 + descriptor.policy.maximumPatches * 16 + 44,
            coverageLimitCount: descriptor.spatialProfile.coverage.limits.length,
            verticalBoundsMode: descriptor.verticalBounds === undefined ? 'global' : 'hierarchy',
            verticalBoundCount: descriptor.verticalBounds?.length ?? 0,
        })
    }

    dispose(): void { this.#kernel = undefined }
}

Object.freeze(WebMercatorQuadCover.prototype)

/** @internal Checks closed selection identity without exposing storage to package consumers. */
export function webMercatorQuadCoverSelectionData(
    selection: WebMercatorQuadCoverSelection,
    owner?: WebMercatorQuadCover
): WebMercatorQuadCoverSelectionData {
    const data = selections.get(selection)
    if (data === undefined || (owner !== undefined && data.owner !== owner)) {
        return selectionFailure(owner?.id, 'foreign-selection', { selectionId: selection?.id })
    }
    return data
}

/** @internal Borrows immutable configuration, including after workspace disposal. */
export function webMercatorQuadCoverDescriptor(cover: WebMercatorQuadCover): NormalizedDescriptor {
    const descriptor = owners.get(cover)
    if (descriptor === undefined) return selectionFailure(undefined, 'foreign-cover', {})
    return descriptor
}

/** @internal Authenticates a selector without evaluating structural lookalike getters. */
export function isWebMercatorQuadCover(value: unknown): value is WebMercatorQuadCover {
    return typeof value === 'object' && value !== null && owners.has(value as WebMercatorQuadCover)
}

/** Validates and snapshots reference-pixel geometry quality and hard output capacity. */
export function webMercatorQuadCoverPolicy(input: WebMercatorQuadCoverPolicy): WebMercatorQuadCoverPolicy {
    if (!level(input?.minimumMatrixLevel) || !level(input?.maximumMatrixLevel) ||
        input.minimumMatrixLevel > input.maximumMatrixLevel ||
        !positiveInteger(input.maximumPatches) || !positiveInteger(input.cellsPerPatchEdge) ||
        !Number.isFinite(input.maximumCellSpanReferencePixels) || input.maximumCellSpanReferencePixels <= 0 ||
        !Number.isFinite(input.refinementTolerance) || input.refinementTolerance < 0 || input.refinementTolerance > .1) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_POLICY_INVALID', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' }, message: 'CPU cover requires ordered levels, finite quality and positive capacity.',
            expected: { levels: '0 <= minimum <= maximum <= 24', refinementTolerance: '[0, 0.1]' }, actual: input })
    }
    return Object.freeze({ minimumMatrixLevel: input.minimumMatrixLevel, maximumMatrixLevel: input.maximumMatrixLevel,
        maximumPatches: input.maximumPatches, cellsPerPatchEdge: input.cellsPerPatchEdge,
        maximumCellSpanReferencePixels: input.maximumCellSpanReferencePixels, refinementTolerance: input.refinementTolerance })
}

function snapshotDescriptor(input: WebMercatorQuadCoverDescriptor): NormalizedDescriptor {
    const spatialProfile = input?.spatialProfile
    if (spatialProfile?.kind !== 'tile-spatial-profile' || spatialProfile.coverage?.tileMatrixSet !== WebMercatorQuad ||
        spatialProfile.addressCodec?.coverage !== spatialProfile.coverage) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_PROFILE_INVALID', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' }, message: 'CPU cover requires one matching WebMercator planar profile.' })
    }
    const policy = webMercatorQuadCoverPolicy(input.policy)
    const maximumCandidates = input.maximumCandidates ?? Math.max(16384, policy.maximumPatches * 64)
    if (!positiveInteger(maximumCandidates) || maximumCandidates > 0xffff_ffff) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_CANDIDATE_BUDGET_INVALID', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' }, actual: { maximumCandidates } })
    }
    const limits = spatialProfile.coverage.limits
    if (limits.length === 0 || !limits.every((limit, i) => Number(limit.matrixId) === policy.minimumMatrixLevel + i) ||
        policy.maximumMatrixLevel >= spatialProfile.coordinateBits || input.verticalRangeMeters?.length !== 2 ||
        input.verticalRangeMeters.some(value => !Number.isFinite(value)) || input.verticalRangeMeters[0] > input.verticalRangeMeters[1]) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_DESCRIPTOR_INVALID', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' }, message: 'CPU cover profile levels or vertical ranges are inconsistent.' })
    }
    const rounds = policy.maximumPatches * (policy.maximumMatrixLevel - policy.minimumMatrixLevel + 1)
    if (!Number.isSafeInteger(rounds) || rounds > 0xffff_ffff) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_CLOSURE_BUDGET_INVALID', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover' }, actual: { maximumRounds: rounds } })
    }
    const verticalRangeMeters = Object.freeze([...input.verticalRangeMeters]) as readonly [number, number]
    const verticalBounds = snapshotWebMercatorCoverVerticalBounds(input.verticalBounds, limits, verticalRangeMeters)
    return Object.freeze({ spatialProfile, policy, maximumCandidates, verticalRangeMeters,
        ...(verticalBounds === undefined ? {} : { verticalBounds }) })
}

function mapMetadata(descriptor: NormalizedDescriptor, view: GeoViewSnapshot): Record<string, unknown> {
    const candidates = gpuWebMercatorQuadCoverCandidates(descriptor, view)
    if (!Number.isSafeInteger(candidates.candidateCount) || candidates.candidateCount > descriptor.maximumCandidates) {
        return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED', phase: 'selection',
            subject: { kind: 'web-mercator-quad-cover', viewId: view.id },
            expected: { maximumCandidates: descriptor.maximumCandidates },
            actual: { candidateCount: candidates.candidateCount, conservativeFallback: candidates.conservativeFallback,
                fallbackReasons: candidates.fallbackReasons } })
    }
    const candidateWindows = Array.from({ length: 25 }, () => [0, 0, 0, 0])
    for (const w of candidates.windows) candidateWindows[w.matrixLevel] = w.count === 0
        ? [0, 0, 0, w.offset] : [w.minTileRow, w.minTileCol, w.maxTileCol - w.minTileCol + 1, w.offset + w.count]
    const matrix = view.clipFromRelativeWorld
    const camera = descriptor.spatialProfile.encodeCamera([
        view.cameraHigh[0] + view.cameraLow[0], view.cameraHigh[1] + view.cameraLow[1],
    ])
    return {
        clipFromRelativeWorld: [matrix.slice(0, 4), matrix.slice(4, 8), matrix.slice(8, 12), matrix.slice(12, 16)],
        cameraHigh: view.cameraHigh, cameraLow: view.cameraLow,
        cameraFixedLow: camera.low, cameraFixedHigh: camera.high,
        referenceViewport: view.referenceViewport, verticalFovRadians: view.verticalFovRadians,
        frameEpoch: view.frameEpoch, residencySnapshotEpoch: view.residencySnapshotEpoch,
        candidateDispatch: [0, 0, 0], refinementCandidateCount: candidates.refinementCandidateCount,
        candidateWindows, clipWPositive: candidates.clipWPositive, clipWNegative: candidates.clipWNegative,
        clipWResidual: candidates.clipWResidual,
    }
}

function selectionFacts(coverId: string, selectionId: string, selectionRevision: number, state: Uint32Array, maximumPatches: number): WebMercatorQuadCoverSelectionFacts {
    const [frameEpoch, candidateCount, patchCount, descriptorOverflowCount, lookupOverflowCount,
        minimumMatrixLevel, maximumMatrixLevel, maximumAdjacentLevelDelta, finestMatrixLevel,
        minimumCellSpanQ8, maximumCellSpanQ8] = state
    const reason = patchCount > maximumPatches ? 'patch-capacity' : descriptorOverflowCount ? 'descriptor-overflow' :
        lookupOverflowCount ? 'lookup-overflow' : maximumAdjacentLevelDelta > 1 ? 'adjacency' :
        maximumCellSpanQ8 === 0xffff_ffff ? 'unbounded-quality' : undefined
    if (reason) return selectionFailure(coverId, reason, { frameEpoch, candidateCount, patchCount,
        descriptorOverflowCount, lookupOverflowCount, maximumAdjacentLevelDelta, maximumCellSpanQ8 })
    return Object.freeze({ coverId, selectionId, selectionRevision, frameEpoch, candidateCount, patchCount,
        descriptorOverflowCount, lookupOverflowCount, maximumAdjacentLevelDelta, finestMatrixLevel,
        ...(patchCount === 0 ? {} : { minimumMatrixLevel, maximumMatrixLevel,
            minimumCellSpanReferencePixels: minimumCellSpanQ8 / 256, maximumCellSpanReferencePixels: maximumCellSpanQ8 / 256 }) })
}

function lookupCapacity(patches: number): number {
    const capacity = 2 ** Math.ceil(Math.log2(patches * 2))
    if (!Number.isSafeInteger(capacity) || capacity * 20 > 0xffff_ffff || patches * 12 > 0xffff_ffff)
        return selectionFailure(undefined, 'buffer-capacity', { maximumPatches: patches })
    return capacity
}

function level(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 24 }
function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }
function selectionFailure(coverId: string | undefined, reason: string, actual: Record<string, unknown>): never {
    return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_SELECTION_INVALID', phase: 'selection',
        subject: { kind: 'web-mercator-quad-cover', ...(coverId === undefined ? {} : { id: coverId }) },
        message: 'CPU cover selection is unavailable, foreign or uncertified.', actual: { reason, ...actual } })
}
