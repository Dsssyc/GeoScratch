import { gpuWebMercatorQuadCoverMapMetaCodec } from '../../packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.js'
import { GPURuntime, type BufferResource, type SubmissionBuilder, type SubmittedWork } from 'geoscratch/scratch'
import {
    GeoDiagnosticError, GpuWebMercatorQuadCover, WebMercatorQuad, createGeoViewSnapshot, createGeoViewSource,
    gpuWebMercatorQuadCoverPolicy, tileMatrixCoverage, webMercatorPlanarTileSpatialProfile,
    webMercatorQuadAddressCodec, type GeoViewSnapshot, type GpuWebMercatorQuadCoverFrame,
} from 'geoscratch/geo'

const WORLD = 40_075_016.6855784
const MAX_LEVEL = 14
const CELL_COUNT = 128
const QUALITY = 5 * 1.005
// The independent double-precision point check excludes clip boundaries and allows
// 0.02 reference pixels for the kernel's f32 coordinate/Jacobian rounding.
const QUALITY_ROUNDOFF = 0.02
const CLIP_MARGIN = 1e-5
type Patch = { level: number, row: number, col: number }
type Domain = { minLevel: number, maxLevel: number, row: number, col: number,
    width: number, height: number, maximumPatches: number, elevation: number, metadataChild?: boolean, verticalRange?: readonly [number, number], fullCandidates?: boolean }
type Scenario = { name: string, zoom: number, pitch: number, x?: number, y?: number,
    altitude?: number, viewport?: readonly [number, number], fov?: number,
    equalTo?: string, anchor?: string, expect?: 'empty' | 'overflow' | 'bounded' | 'unbounded', singular?: boolean }
const world: Domain = { minLevel: 0, maxLevel: MAX_LEVEL, row: 0, col: 0,
    width: 1, height: 1, maximumPatches: 2048, elevation: 0 }

export type CameraCoverComparison = {
    initialize(builder: SubmissionBuilder): void
    encode(builder: SubmissionBuilder, frame: GpuWebMercatorQuadCoverFrame, view: GeoViewSnapshot): void
    check(view: GeoViewSnapshot, words: Uint32Array, submitted: SubmittedWork): Promise<void>
    dispose(): void
}

export async function runCameraCoverProof(
    createComparison?: (runtime: GPURuntime, cover: GpuWebMercatorQuadCover) => Promise<CameraCoverComparison>
) {

    const runtime = await GPURuntime.create({ label: 'Independent native camera cover proof' })
    const uncaptured: string[] = []
    runtime.device.addEventListener('uncapturederror', event => uncaptured.push(event.error.message))
    const rows: unknown[] = []
    const observedCovers = new Map<string, string>()
    let epoch = 0
    try {
        const ordinary: Scenario[] = [ { name: 'A-initial', zoom: 10, pitch: 0, anchor: 'A' } ]
        for (let pitch = 0; pitch <= 85; pitch += 5) {
            ordinary.push({ name: `pitch-${pitch}`, zoom: 10, pitch })
        }
        for (const x of [ -15000, -5000, 0, 5000, 15000 ]) {
            ordinary.push({ name: `move-${x}`, zoom: 10, pitch: 70, x, y: x / 4 })
        }
        for (let zoom = 8; zoom <= 14; zoom++) {
            ordinary.push({ name: `zoom-${zoom}`, zoom, pitch: 70 })
        }
        for (const multiplier of [ 0.5, 1, 2 ]) {
            ordinary.push({ name: `altitude-${multiplier}`, zoom: 10, pitch: 80,
                altitude: WORLD / 2 ** 10 * 1.5 * multiplier })
        }
        ordinary.push(
            { name: 'extreme-wide-top', zoom: 13, pitch: 0, viewport: [16384, 128] },
            { name: 'wide-fov', zoom: 10, pitch: 80, fov: 110 * Math.PI / 180 },
            { name: 'A-return', zoom: 10, pitch: 0, equalTo: 'A' },
        )
        await runDomain(world, ordinary)
        await runDomain({ ...world, elevation: 1500 }, [
            { name: 'elevated-plane', zoom: 10, pitch: 75 },
            { name: 'elevated-camera', zoom: 10, pitch: 75, altitude: 12000 },
        ])
        await runDomain({ ...world, maxLevel: 18, elevation: 1500, metadataChild: true }, [
            { name: 'partial-metadata-A', zoom: 16, pitch: 0, altitude: 2000, anchor: 'metadata-A' },
            { name: 'partial-metadata-pitched', zoom: 16, pitch: 65, altitude: 2000 },
            { name: 'partial-metadata-A-return', zoom: 16, pitch: 0, altitude: 2000, equalTo: 'metadata-A' },
        ])
        const volume: Domain = { minLevel: 20, maxLevel: 24, row: 524287, col: 524288,
            width: 1, height: 1, maximumPatches: 512, elevation: 0, verticalRange: [-120, 500] }
        const volumeX = 19.10925707129402, volumeY = 19.10925707129402
        const volumeScenarios: Scenario[] = [
            { name: 'height-volume-A', zoom: 20, pitch: 0, x: volumeX, y: volumeY, altitude: 10, anchor: 'volume-A' },
            ...[0, 30, 60, 85].map(pitch => ({ name: `height-volume-pitch-${pitch}`, zoom: 20, pitch,
                x: volumeX, y: volumeY, altitude: 10 })),
            { name: 'height-volume-above', zoom: 20, pitch: 0, x: volumeX, y: volumeY, altitude: 510 },
            { name: 'height-volume-A-return', zoom: 20, pitch: 0, x: volumeX, y: volumeY, altitude: 10, equalTo: 'volume-A' },
        ]
        await runDomain(volume, volumeScenarios)
        await runDomain({ ...volume, fullCandidates: true }, volumeScenarios)
        for (const elevation of [-100, 250, 499]) await runDomain({ ...volume, elevation }, [
            { name: `height-volume-surface-${elevation}`, zoom: 20, pitch: 0, x: volumeX, y: volumeY, altitude: 510 },
        ])
        const finite: Domain = { ...world, minLevel: 4, maxLevel: 8, row: 7, col: 8,
            width: 2, height: 2, maximumPatches: 1024, verticalRange: [-120, 500] }
        const finiteScenarios = [0, 45, 80].map(pitch => ({ name: `finite-volume-${pitch}`,
            zoom: 6, pitch, x: 300000, y: -200000 }))
        await runDomain(finite, finiteScenarios)
        await runDomain({ ...finite, fullCandidates: true }, finiteScenarios)
        // This stress view has an explicit small output budget. A valid complete cut
        // or an explicit capacity failure is allowed; partial success is never allowed.
        await runDomain({ ...world, maximumPatches: 128 }, [
            { name: 'budgeted-extreme-wide-pitched', zoom: 13, pitch: 70,
                viewport: [16384, 128], expect: 'bounded' },
        ])
        const local: Domain = { minLevel: 22, maxLevel: 24, row: 2_000_000, col: 3_000_000,
            width: 2, height: 2, maximumPatches: 256, elevation: 0 }
        const localX = ((local.col + 1) / 2 ** local.minLevel - 0.5) * WORLD
        const localY = (0.5 - (local.row + 1) / 2 ** local.minLevel) * WORLD
        await runDomain(local, [
            { name: 'z24-A', zoom: 24, pitch: 0, x: localX, y: localY, anchor: 'local-A' },
            { name: 'z24-millimetres', zoom: 24, pitch: 0, x: localX + 0.005, y: localY - 0.003 },
            { name: 'z24-pitched', zoom: 24, pitch: 70, x: localX, y: localY },
            { name: 'outside-domain-empty', zoom: 10, pitch: 0, expect: 'empty' },
            { name: 'z24-A-return', zoom: 24, pitch: 0, x: localX, y: localY, equalTo: 'local-A' },
        ])
        await runDomain({ ...world, maxLevel: 0, verticalRange: [-120, 500] }, [
            { name: 'uncertified-quality', zoom: 10, pitch: 0, singular: true, expect: 'unbounded' },
            { name: 'quality-after-failure', zoom: 10, pitch: 0 },
        ])
        await runDomain({ ...world, maximumPatches: 1 }, [
            { name: 'real-patch-overflow', zoom: 10, pitch: 0, expect: 'overflow' },
        ])
    } finally {
        runtime.dispose()
    }
    const terminal = runtime.diagnostics.snapshot()
    assert(uncaptured.length === 0, 'Uncaptured native errors', uncaptured)
    assert(terminal.resources.length === 0 && terminal.readbacks.length === 0 &&
        terminal.readbackCommands.length === 0 && terminal.pendingOperations.length === 0 &&
        terminal.readbackMemory.currentStagingBytes === 0 && terminal.readbackMemory.activeMappings === 0,
    'Runtime ownership did not converge', terminal)
    return {
        adapter: runtime.adapterInfo, dpr: window.devicePixelRatio, rows, uncaptured,
        limits: { coverage: 'Finite screen-ray and local tile-centre samples; not a continuous proof',
            quality: 'Independent point Jacobians at multiple actual heights inside declared volumes; algebraic bound documented separately',
            dpr: 'Actual browser DPR and capture presentationSize vary; no Surface is created',
            qualityRoundoffReferencePixels: QUALITY_ROUNDOFF, clipMargin: CLIP_MARGIN },
        cleanup: { runtimeDisposed: runtime.isDisposed, resources: terminal.resources.length,
            readbacks: terminal.readbacks.length, commands: terminal.readbackCommands.length,
            stagingBytes: terminal.readbackMemory.currentStagingBytes,
            activeMappings: terminal.readbackMemory.activeMappings },
    }

    async function runDomain(domain: Domain, scenarios: readonly Scenario[]) {

        const coverage = tileMatrixCoverage({ tileMatrixSet: WebMercatorQuad, limits: [ {
            matrixId: String(domain.minLevel), minTileRow: domain.row,
            maxTileRow: domain.row + domain.height - 1, minTileCol: domain.col,
            maxTileCol: domain.col + domain.width - 1,
        }, ...(domain.metadataChild ? [{ matrixId: String(domain.minLevel + 1),
            minTileRow: domain.row * 2, maxTileRow: domain.row * 2,
            minTileCol: domain.col * 2, maxTileCol: domain.col * 2 }] : []) ] })
        const cover = await GpuWebMercatorQuadCover.create(runtime, {
            spatialProfile: webMercatorPlanarTileSpatialProfile({
                addressCodec: webMercatorQuadAddressCodec({ coverage, coordinateBits: 52 }),
            }),
            policy: gpuWebMercatorQuadCoverPolicy({ minimumMatrixLevel: domain.minLevel,
                maximumMatrixLevel: domain.maxLevel, maximumPatches: domain.maximumPatches,
                cellsPerPatchEdge: CELL_COUNT, maximumCellSpanReferencePixels: 5,
                refinementTolerance: 0.005 }),
            maximumCandidates: 1_048_576,
            verticalRangeMeters: domain.verticalRange ?? [domain.elevation, domain.elevation],
            ...(domain.metadataChild ? { verticalBounds: coverage.limits.map(limit => ({
                matrixLevel: Number(limit.matrixId), tileRow: limit.minTileRow,
                tileCol: limit.minTileCol, minimumVerticalMeters: domain.elevation,
                maximumVerticalMeters: domain.elevation,
            })) } : {}),
        })
        const comparison = await createComparison?.(runtime, cover)
        const candidateOverrides = domain.fullCandidates ? cover.templates().map(template => {
            const fields = gpuWebMercatorQuadCoverMapMetaCodec.artifact.fields
            const offset = (name: string) => fields.find(field => field.name === name)!.offset
            const start = offset('refinementCandidateCount')
            const data = new Uint32Array((offset('candidateDispatch') + 12 - start) / 4)
            let count = 0
            for (let level = domain.minLevel; level < domain.maxLevel; level++) {
                const scale = 2 ** (level - domain.minLevel)
                const width = domain.width * scale
                count += width * domain.height * scale
                data.set([domain.row * scale, domain.col * scale, width, count],
                    (offset('candidateWindows') - start) / 4 + 4 * level)
            }
            data[0] = count
            data.set([Math.ceil(count / 64), 1, 1], (offset('candidateDispatch') - start) / 4)
            assert(count <= 1_048_576, 'Exhaustive test domain exceeds its workspace')
            return runtime.createUploadCommand({ label: 'Test full finite candidate domain',
                target: template.mapMeta.region({ offset: start, size: data.byteLength }), data })
        }) : []
        const observers = await Promise.all(cover.templates().map(template => createObserver(
            runtime, template.state, template.patches, domain.maximumPatches)))
        const initialization = runtime.submission()
        cover.initialize(initialization)
        comparison?.initialize(initialization)
        for (const observer of observers) initialization.clear(observer.clear)
        const initialized = initialization.submit()
        await initialized.done
        assert((await initialized.nativeOutcome).status === 'observed-succeeded', 'Initialization failed')
        const anchors = new Map<string, { sorted: string, raw: string }>()
        try {
            for (const scenario of scenarios) {
                document.documentElement.dataset.cameraCoverScenario = scenario.name
                document.documentElement.dataset.cameraCoverStage = 'preparing'
                const view = makeView(scenario, ++epoch)
                document.documentElement.dataset.cameraCoverFrameEpoch = String(epoch)
                const source = createGeoViewSource({ id: 'native-cover-capture', capture: () => ({
                    view, presentationSize: {
                        width: view.referenceViewport[0] * window.devicePixelRatio,
                        height: view.referenceViewport[1] * window.devicePixelRatio,
                    },
                }) })
                const capture = source.capture()
                const token = cover.writeView(capture.view)
                try {
                    const frame = cover.frame(token)
                    const observer = observers[frame.parity]!
                    const builder = runtime.submission()
                    cover.encode(builder, frame)
                    if (domain.fullCandidates) {
                        // A second complete construction with only the search domain
                        // replaced. No consumer sees the first cut in this test.
                        builder.upload(candidateOverrides[frame.parity]!)
                        const commands = cover.commandsFor(frame)
                        builder.compute(cover.identityObjects().passes[0]!, [commands.evaluate, commands.generate])
                    }
                    comparison?.encode(builder, frame, view)
                    builder.compute(observer.pass, [observer.command]).readback(observer.readback)
                    cover.capture(builder, frame)
                    const submitted = builder.submit()
                    document.documentElement.dataset.cameraCoverStage = 'submitted'
                    const bytes = await observer.readback.result({ after: submitted }).toBytes()
                    document.documentElement.dataset.cameraCoverStage = 'readback-ready'
                    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
                    let feedback
                    let rejected = false
                    try { feedback = await cover.feedback(frame, submitted) }
                    catch (error) {
                        if (!(error instanceof GeoDiagnosticError)) throw error
                        rejected = true
                    }
                    await submitted.done
                    const native = await submitted.nativeOutcome
                    assert(native.status === 'observed-succeeded', `${scenario.name}: native failure`, native)
                    assert(words[0] === view.frameEpoch, `${scenario.name}: stale frame epoch`)
                    await comparison?.check(view, words, submitted)
                    const failed = words[3]! > 0 || words[4]! > 0 || words[7]! > 1 || words[10] === 0xffff_ffff
                    if (scenario.expect === 'overflow' || scenario.expect === 'unbounded' || (scenario.expect === 'bounded' && failed)) {
                        if (scenario.expect === 'unbounded') assert(words[10] === 0xffff_ffff, 'Missing quality failure marker')
                        assert(failed && rejected && words[2] === 0,
                            'Real overflow did not invalidate all consumer-visible patches', Array.from(words.slice(0, 11)))
                        rows.push({ name: scenario.name, overflow: true,
                            maximumPatches: domain.maximumPatches, state: Array.from(words.slice(0, 11)) })
                        document.documentElement.dataset.cameraCoverStage = 'validated'
                        continue
                    }
                    assert(!failed && !rejected, `${scenario.name}: cover failed`, Array.from(words.slice(0, 11)))
                    const count = words[2]!
                    assert(count <= domain.maximumPatches, `${scenario.name}: output capacity exceeded`)
                    const patches = Array.from({ length: count }, (_, index): Patch => ({
                        level: words[11 + index * 3]!, row: words[12 + index * 3]!, col: words[13 + index * 3]!,
                    }))
                    assert(scenario.expect === 'empty' ? count === 0 : count > 0,
                        `${scenario.name}: unexpected empty/nonempty cover`, count)
                    let validation
                    try { validation = validateIndependent(domain, view, patches) }
                    catch (error) {
                        throw new Error(`${scenario.name}: independent cover validation failed: ${JSON.stringify({
                            feedback, view, domain, patches,
                            reason: error instanceof Error ? error.message : String(error),
                        })}`)
                    }
                    const raw = patches.map(identity).join(';')
                    const sorted = patches.map(identity).sort().join(';')
                    if (domain.fullCandidates) assert(raw === observedCovers.get(scenario.name),
                        `${scenario.name}: bounded search differs from complete finite enumeration`)
                    else observedCovers.set(scenario.name, raw)
                    if (scenario.anchor) anchors.set(scenario.anchor, { sorted, raw })
                    if (scenario.equalTo) {
                        const previous = anchors.get(scenario.equalTo)
                        assert(previous?.sorted === sorted && previous.raw === raw,
                            `${scenario.name}: A-B-A identities or output ordering changed`)
                    }
                    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted))
                    const orderedDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
                    rows.push({ name: `${domain.fullCandidates ? 'full-' : ''}${scenario.name}`, patchCount: count,
                        orderedIdentitySha256: Array.from(new Uint8Array(orderedDigest), x => x.toString(16).padStart(2, '0')).join(''),
                        identitySha256: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''),
                        presentationSize: capture.presentationSize, referenceViewport: view.referenceViewport,
                        feedback, validation, nativeStatus: native.status })
                    document.documentElement.dataset.cameraCoverStage = 'validated'
                } finally { token.dispose() }
            }
        } finally { comparison?.dispose(); for (const upload of candidateOverrides) upload.dispose(); cover.dispose() }
    }
}

function makeView(scenario: Scenario, epoch: number): GeoViewSnapshot {

    const viewport = scenario.viewport ?? [1280, 800]
    const altitude = scenario.altitude ?? WORLD / 2 ** scenario.zoom * 1.5
    const fov = scenario.fov ?? Math.PI / 3
    const f = 1 / Math.tan(fov / 2), far = altitude * 16
    const pitch = scenario.pitch * Math.PI / 180, c = Math.cos(pitch), s = Math.sin(pitch)
    const projection = [f / (viewport[0] / viewport[1]), 0, 0, 0, 0, f, 0, 0,
        0, 0, far / (1 - far), -1, 0, 0, far / (1 - far), 0]
    const rotation = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
    const matrix = new Float64Array(16)
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
        for (let k = 0; k < 4; k++) matrix[col * 4 + row]! += projection[k * 4 + row]! * rotation[col * 4 + k]!
    }
    const camera = [scenario.x ?? 0, scenario.y ?? 0, altitude]
    if (scenario.singular) matrix.fill(0)
    return createGeoViewSnapshot({ id: 'native-camera-cover', clipFromRelativeWorld: matrix,
        cameraHigh: camera.map(Math.fround) as [number, number, number],
        cameraLow: camera.map(x => x - Math.fround(x)) as [number, number, number],
        referenceViewport: viewport, verticalFovRadians: fov, cameraLatitudeRadians: 0,
        cameraPitchRadians: pitch, zoomHint: scenario.zoom, frameEpoch: epoch, residencySnapshotEpoch: 1 })
}

function validateIndependent(domain: Domain, view: GeoViewSnapshot, patches: readonly Patch[]) {

    const scale = 2 ** domain.maxLevel
    const bounds = patches.map(p => ({ west: p.col * 2 ** (domain.maxLevel - p.level),
        east: (p.col + 1) * 2 ** (domain.maxLevel - p.level),
        north: p.row * 2 ** (domain.maxLevel - p.level),
        south: (p.row + 1) * 2 ** (domain.maxLevel - p.level) }))
    const rootScale = 2 ** (domain.maxLevel - domain.minLevel)
    for (const [index, patch] of patches.entries()) {
        const b = bounds[index]!
        assert(patch.level >= domain.minLevel && patch.level <= domain.maxLevel &&
            patch.row < 2 ** patch.level && patch.col < 2 ** patch.level &&
            b.west >= domain.col * rootScale && b.east <= (domain.col + domain.width) * rootScale &&
            b.north >= domain.row * rootScale && b.south <= (domain.row + domain.height) * rootScale,
        'Nonstandard or out-of-domain identity', patch)
    }
    let neighborPairs = 0
    for (let a = 0; a < patches.length; a++) for (let b = a + 1; b < patches.length; b++) {
        const left = bounds[a]!, right = bounds[b]!
        const overlapX = Math.max(left.west, right.west) < Math.min(left.east, right.east)
        const overlapY = Math.max(left.north, right.north) < Math.min(left.south, right.south)
        assert(!(overlapX && overlapY), 'Duplicate, ancestor/descendant, or overlapping patches', [patches[a], patches[b]])
        const adjacent = ((left.east === right.west || right.east === left.west ||
            (left.east === scale && right.west === 0) || (right.east === scale && left.west === 0)) && overlapY) ||
            ((left.south === right.north || right.south === left.north) && overlapX)
        if (adjacent) {
            neighborPairs++
            assert(Math.abs(patches[a]!.level - patches[b]!.level) <= 1,
                'Independent edge check found a 2:1 violation', [patches[a], patches[b]])
        }
    }
    const camera = view.cameraHigh.map((x, i) => x + view.cameraLow[i]!)
    const matrix = Array.from(view.clipFromRelativeWorld, Math.fround)
    const inverse = invert(matrix)
    let coveredSamples = 0, qualitySamples = 0, maximumObservedStretch = 0, finiteTileSamples = 0
    const check = (relative: readonly number[]) => {
        const clip = transform(matrix, [...relative, 1])
        if (!insideClip(clip)) return
        const nx = (relative[0]! + camera[0]!) / WORLD + 0.5
        const ny = 0.5 - (relative[1]! + camera[1]!) / WORLD
        const rootX = nx * 2 ** domain.minLevel, rootY = ny * 2 ** domain.minLevel
        if (rootX < domain.col || rootX >= domain.col + domain.width ||
            rootY < domain.row || rootY >= domain.row + domain.height) return
        const owners = patches.filter(p => Math.floor(nx * 2 ** p.level) === p.col &&
            Math.floor(ny * 2 ** p.level) === p.row)
        assert(owners.length === 1, 'Visible plane sample lacks one unique standard patch',
            { normalized: [nx, ny], owners: owners.map(identity), frameEpoch: view.frameEpoch })
        coveredSamples++
        const owner = owners[0]!
        if (owner.level < domain.maxLevel) {
            const stretch = pointStretch(matrix, clip, view.referenceViewport, WORLD / 2 ** owner.level / CELL_COUNT)
            qualitySamples++
            maximumObservedStretch = Math.max(maximumObservedStretch, stretch)
            assert(stretch <= QUALITY + QUALITY_ROUNDOFF,
                'A visible leaf sample exceeds the independent projected-cell quality bound',
                { owner, stretch, threshold: QUALITY, frameEpoch: view.frameEpoch })
        }
    }
    // Independent screen-ray/plane intersections test the whole visible footprint,
    // not just centres of the patches emitted by the GPU.
    for (let row = 0; row < 17; row++) for (let col = 0; col < 65; col++) {
        const x = -0.98 + 1.96 * col / 64, y = -0.98 + 1.96 * row / 16
        const near = transform(inverse, [x, y, 0, 1]), far = transform(inverse, [x, y, 1, 1])
        const a = near.slice(0, 3).map(v => v / near[3]!)
        const b = far.slice(0, 3).map(v => v / far[3]!)
        const dz = b[2]! - a[2]!
        if (Math.abs(dz) < 1e-12) continue
        const t = (domain.elevation - camera[2]! - a[2]!) / dz
        if (t < 0 || t > 1) continue
        check(a.map((value, axis) => value + t * (b[axis]! - value)))
    }
    // The z22..z24 fixture is small enough to enumerate every tile at every level,
    // independently of the candidate windows and of the GPU's emitted patches.
    if (domain.maxLevel - domain.minLevel <= 3) {
        for (let level = domain.minLevel; level <= domain.maxLevel; level++) {
            const factor = 2 ** (level - domain.minLevel)
            for (let row = domain.row * factor; row < (domain.row + domain.height) * factor; row++) {
                for (let col = domain.col * factor; col < (domain.col + domain.width) * factor; col++) {
                    finiteTileSamples++
                    check([(col + 0.5) / 2 ** level * WORLD - WORLD / 2 - camera[0]!,
                        WORLD / 2 - (row + 0.5) / 2 ** level * WORLD - camera[1]!,
                        domain.elevation - camera[2]!])
                }
            }
        }
    }
    for (const patch of patches) for (const u of [0.25, 0.5, 0.75]) for (const v of [0.25, 0.5, 0.75]) {
        check([(patch.col + u) / 2 ** patch.level * WORLD - WORLD / 2 - camera[0]!,
            WORLD / 2 - (patch.row + v) / 2 ** patch.level * WORLD - camera[1]!,
            domain.elevation - camera[2]!])
    }
    assert(patches.length === 0 || coveredSamples > 0, 'Nonempty scenario had no independent visible samples')
    return { neighborPairs, coveredSamples, qualitySamples, maximumObservedStretch, finiteTileSamples }
}

function pointStretch(matrix: readonly number[], clip: readonly number[], viewport: readonly number[], cell: number) {

    const w = clip[3]!
    const derivatives = [0, 1].map(axis => [0, 1].map(screen =>
        cell * viewport[screen]! / 2 *
        (matrix[axis * 4 + screen]! * w - clip[screen]! * matrix[axis * 4 + 3]!) / (w * w)))
    const [x, y] = derivatives
    const xx = x![0]! ** 2 + x![1]! ** 2, yy = y![0]! ** 2 + y![1]! ** 2
    const xy = x![0]! * y![0]! + x![1]! * y![1]!
    return Math.sqrt((xx + yy + Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2)
}

function insideClip(p: readonly number[]) {

    const w = p[3]!
    return w > 0 && Math.abs(p[0]! / w) < 1 - CLIP_MARGIN &&
        Math.abs(p[1]! / w) < 1 - CLIP_MARGIN && p[2]! / w > 1e-9 && p[2]! / w < 1 - 1e-9
}

function transform(matrix: readonly number[], point: readonly number[]) {

    return [0, 1, 2, 3].map(row => point.reduce((sum, x, col) => sum + matrix[col * 4 + row]! * x, 0))
}

function invert(matrix: readonly number[]) {

    const rows = [0, 1, 2, 3].map(row => [0, 1, 2, 3].map(col => matrix[col * 4 + row]!)
        .concat([0, 1, 2, 3].map(col => col === row ? 1 : 0)))
    for (let col = 0; col < 4; col++) {
        let pivot = col
        for (let row = col + 1; row < 4; row++) if (Math.abs(rows[row]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = row
        ;[rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!]
        const divisor = rows[col]![col]!
        assert(Math.abs(divisor) > 1e-18, 'Fixture projection is singular')
        rows[col] = rows[col]!.map(x => x / divisor)
        for (let row = 0; row < 4; row++) if (row !== col) {
            const factor = rows[row]![col]!
            rows[row] = rows[row]!.map((x, i) => x - factor * rows[col]![i]!)
        }
    }
    return Array.from({ length: 16 }, (_, i) => rows[i % 4]![4 + Math.floor(i / 4)]!)
}

async function createObserver(runtime: GPURuntime, state: BufferResource, patches: BufferResource, capacity: number) {

    const words = 11 + capacity * 3
    const output = await runtime.createBuffer({ label: 'Independent cover observation', size: words * 4, usage: 0x8c })
    const clear = runtime.createClearBufferCommand({ target: output.region() })
    const shader = await runtime.createShaderModule({ sourceParts: [ { code: `
        @group(0) @binding(0) var<storage, read> stateWords: array<u32>;
        @group(0) @binding(1) var<storage, read> patchWords: array<u32>;
        @group(0) @binding(2) var<storage, read_write> observed: array<u32>;
        @compute @workgroup_size(64) fn observe(@builtin(global_invocation_id) id: vec3u) {
            let index = id.x;
            if (index < 11u) { observed[index] = stateWords[index]; return; }
            if (index >= ${words}u) { return; }
            let offset = index - 11u;
            observed[index] = 0u;
            if (offset < min(stateWords[2], ${capacity}u) * 3u) { observed[index] = patchWords[offset]; }
        }
    ` } ] })
    const layout = await runtime.createBindLayout({ group: 0, entries: [
        { binding: 0, name: 'stateWords', type: 'read-storage', visibility: ['compute'], minBindingSize: 44 },
        { binding: 1, name: 'patchWords', type: 'read-storage', visibility: ['compute'], minBindingSize: capacity * 12 },
        { binding: 2, name: 'observed', type: 'storage', visibility: ['compute'], minBindingSize: words * 4 },
    ] })
    const bindings = await runtime.createBindSet(layout, { stateWords: state.region(),
        patchWords: patches.region(), observed: output.region() })
    const program = runtime.createProgram({ compute: { module: shader, entryPoint: 'observe' } })
    const pipeline = await runtime.createComputePipeline({ program, layout: { mode: 'explicit', bindLayouts: [layout] } })
    const command = runtime.createDispatchCommand({ pipeline, bindSets: [{ set: bindings }],
        count: { workgroups: [Math.ceil(words / 64), 1, 1] }, whenMissing: 'throw',
        resources: { read: [state, patches, output].map(resource => ({ resource,
            contentEpoch: 'current-at-step' as const })), write: [output] } })
    const pass = runtime.createComputePass({ label: 'Observe actual cover descriptors' })
    const readback = await runtime.createReadbackCommand({ source: { region: output.region(),
        contentEpoch: 'current-at-step' }, whenMissing: 'throw' })
    return { clear, pass, command, readback }
}

function identity(patch: Patch) { return `${patch.level}/${patch.row}/${patch.col}` }
function assert(condition: unknown, message: string, evidence?: unknown): asserts condition {
    if (!condition) throw new Error(`${message}${evidence === undefined ? '' : `: ${JSON.stringify(evidence)}`}`)
}
