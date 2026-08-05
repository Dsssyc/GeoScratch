import type { CoordinateDimension } from './coordinate-domain.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import type {
    TileCoordinate,
    TileCoordinateDescriptor,
    TileMatrixCoverage,
    TileMatrixId,
    TileMatrixLimits,
} from './tile-matrix.js'
import type {
    OwnedVirtualRasterPagePayload,
    VirtualRasterPageData,
} from './virtual-raster-transfer.js'

export type VirtualRasterFieldKind =
    | 'scalar'
    | 'color'
    | 'categorical'
    | 'mask'
    | 'vector'
    | 'multiband'

export type VirtualRasterSampleType = 'unorm8' | 'float32'
export type VirtualRasterFilter = 'nearest' | 'bilinear'
export type VirtualRasterOuterBoundary = 'clamp' | 'no-data'

export type VirtualRasterAddressSpaceDescriptor = Readonly<{
    id: string
    dimensions: CoordinateDimension
    extent: readonly number[]
    pageSize: readonly number[]
    levelCount: number
}>

export type VirtualRasterTileAddressSpaceDescriptor = Readonly<{
    id: string
    coverage: TileMatrixCoverage
}>

export type VirtualRasterPageDescriptor = Readonly<{
    level: number
    x: number
    y?: number
    z?: number
}>

export type VirtualRasterPageIdentity = Readonly<{
    kind: 'virtual-raster-page'
    addressSpaceId: string
    dimensions: CoordinateDimension
    level: number
    coordinates: readonly number[]
    key: string
    tile?: TileCoordinate
}>

export type VirtualRasterPlaneDescriptor = Readonly<{
    id: string
    addressSpace: VirtualRasterAddressSpace
    kind: VirtualRasterFieldKind
    channels: 1 | 2 | 3 | 4
    sampleType: VirtualRasterSampleType
    gpuFormat: GPUTextureFormat
    noData?: number
    scale?: number | readonly number[]
    offset?: number | readonly number[]
    auxiliaryAxes?: readonly Readonly<{ name: string, value: string | number }>[]
}>

export type VirtualRasterPlane = Readonly<{
    kind: 'virtual-raster-plane'
    id: string
    addressSpace: VirtualRasterAddressSpace
    fieldKind: VirtualRasterFieldKind
    channels: 1 | 2 | 3 | 4
    sampleType: VirtualRasterSampleType
    gpuFormat: GPUTextureFormat
    noData?: number
    scale: readonly number[]
    offset: readonly number[]
    auxiliaryAxes: readonly Readonly<{ name: string, value: string | number }>[]
}>

export type VirtualRasterSamplingProfileDescriptor = Readonly<{
    filter: VirtualRasterFilter
    level: number
    outerBoundary: VirtualRasterOuterBoundary
}>

export type VirtualRasterSamplingProfile = Readonly<{
    kind: 'virtual-raster-sampling-profile'
    filter: VirtualRasterFilter
    level: number
    outerBoundary: VirtualRasterOuterBoundary
}>

export type VirtualRasterPagePayload = OwnedVirtualRasterPagePayload

export type VirtualRasterCpuPage = Readonly<{
    page: VirtualRasterPageIdentity
    width: number
    height: number
    channels: number
    data: VirtualRasterPageData
}>

export type VirtualRasterCpuPageProvider = Readonly<{
    get(page: VirtualRasterPageIdentity): VirtualRasterCpuPage | undefined
}>

export type VirtualRasterSourceLoadContext = Readonly<{
    signal: AbortSignal
}>

export type VirtualRasterSourceDescriptor = Readonly<{
    id: string
    loadPage(
        page: VirtualRasterPageIdentity,
        context: VirtualRasterSourceLoadContext
    ): Promise<VirtualRasterPagePayload>
}>

export type VirtualRasterSource = Readonly<{
    kind: 'virtual-raster-source'
    id: string
    loadPage(
        page: VirtualRasterPageIdentity,
        context: VirtualRasterSourceLoadContext
    ): Promise<VirtualRasterPagePayload>
}>

export type VirtualRasterSnapshotResolveStatus = 'resident' | 'fallback' | 'missing' | 'failed'

export type VirtualRasterPageTableEntry = Readonly<{
    requestedPage: VirtualRasterPageIdentity
    status: VirtualRasterSnapshotResolveStatus
    requestedLevel: number
    resolvedLevel?: number
    resolvedPage?: VirtualRasterPageIdentity
    physicalSlot?: number
    generation?: number
    contentEpoch?: number
}>

export type VirtualRasterSampleStatus = 'resident' | 'fallback' | 'missing' | 'no-data'

export type VirtualRasterSample = Readonly<{
    status: VirtualRasterSampleStatus
    value?: readonly number[]
    requestedLevel: number
    resolvedLodRange: readonly [number, number]
    physicalSlots: readonly number[]
}>

export type VirtualRasterAccessorDescriptor = Readonly<{
    addressSpace: VirtualRasterAddressSpace
    plane: VirtualRasterPlane
}>

export type VirtualRasterSampleDescriptor = Readonly<{
    texel: readonly [number, number]
    profile: VirtualRasterSamplingProfile
}>

export type VirtualRasterAccessorWgslOptions = Readonly<{
    namespace?: string
    group: number
    pageTableBinding: number
    atlasBinding: number
}>

const snapshotRecords = new WeakMap<
    VirtualRasterSnapshot,
    ReadonlyMap<string, VirtualRasterPageTableEntry>
>()
const snapshotPhysicalMappings = new WeakMap<
    VirtualRasterSnapshot,
    ReadonlyMap<number, VirtualRasterPhysicalPage>
>()

export type VirtualRasterPhysicalPage = Readonly<{
    page: VirtualRasterPageIdentity
    physicalSlot: number
    generation: number
    contentEpoch: number
    byteLength: number
    width: number
    height: number
    channels: number
    contentVersion: string
}>

export class VirtualRasterAddressSpace {

    readonly kind = 'virtual-raster-address-space'
    readonly id: string
    readonly dimensions: CoordinateDimension
    readonly extent: readonly number[]
    readonly pageSize: readonly number[]
    readonly levelCount: number
    readonly pageTableEntryCount: number
    readonly tileCoverage?: TileMatrixCoverage
    readonly #levelOffsets: readonly number[]
    readonly #tileLimitsByLevel: readonly TileMatrixLimits[]
    readonly #tileLevelsByMatrix: ReadonlyMap<TileMatrixId, number>

    constructor(
        descriptor: VirtualRasterAddressSpaceDescriptor | VirtualRasterTileAddressSpaceDescriptor
    ) {

        if ('coverage' in descriptor) {
            if (typeof descriptor.id !== 'string' || descriptor.id.length === 0 ||
                descriptor.coverage?.kind !== 'tile-matrix-coverage') {
                throwAddressSpaceInvalid(descriptor)
            }
            const limits = Object.freeze([ ...descriptor.coverage.limits ].reverse())
            const matrices = limits.map(limit => descriptor.coverage.tileMatrixSet.matrix(limit.matrixId))
            const tileWidth = matrices[0]!.tileWidth
            const tileHeight = matrices[0]!.tileHeight
            if (matrices.some(matrix =>
                matrix.tileWidth !== tileWidth || matrix.tileHeight !== tileHeight
            )) {
                throwAddressSpaceInvalid(descriptor)
            }
            const finest = limits[0]!
            this.id = descriptor.id
            this.dimensions = 2
            this.extent = Object.freeze([
                (finest.maxTileCol - finest.minTileCol + 1) * tileWidth,
                (finest.maxTileRow - finest.minTileRow + 1) * tileHeight,
            ])
            this.pageSize = Object.freeze([ tileWidth, tileHeight ])
            this.levelCount = limits.length
            this.pageTableEntryCount = descriptor.coverage.entryCount
            this.tileCoverage = descriptor.coverage
            this.#tileLimitsByLevel = limits
            this.#tileLevelsByMatrix = new Map(limits.map((limit, level) => [
                limit.matrixId,
                level,
            ]))
            this.#levelOffsets = Object.freeze(limits.map(limit =>
                descriptor.coverage.index({
                    matrixId: limit.matrixId,
                    tileRow: limit.minTileRow,
                    tileCol: limit.minTileCol,
                })
            ))
            Object.freeze(this)
            return
        }
        if (typeof descriptor.id !== 'string' || descriptor.id.length === 0 ||
            !isDimension(descriptor.dimensions) ||
            descriptor.extent.length !== descriptor.dimensions ||
            descriptor.pageSize.length !== descriptor.dimensions ||
            descriptor.extent.some(value => !isPositiveInteger(value)) ||
            descriptor.pageSize.some(value => !isPositiveInteger(value)) ||
            !isPositiveInteger(descriptor.levelCount)) {
            throwAddressSpaceInvalid(descriptor)
        }
        this.id = descriptor.id
        this.dimensions = descriptor.dimensions
        this.extent = Object.freeze([ ...descriptor.extent ])
        this.pageSize = Object.freeze([ ...descriptor.pageSize ])
        this.levelCount = descriptor.levelCount
        this.#tileLimitsByLevel = Object.freeze([])
        this.#tileLevelsByMatrix = new Map()
        const offsets: number[] = []
        let count = 0
        for (let level = 0; level < this.levelCount; level++) {
            offsets.push(count)
            count += product(this.pageGrid(level))
        }
        this.#levelOffsets = Object.freeze(offsets)
        this.pageTableEntryCount = count
        Object.freeze(this)
    }

    levelExtent(level: number): readonly number[] {

        this.#assertLevel(level)
        const limit = this.#tileLimitsByLevel[level]
        if (limit !== undefined) {
            return Object.freeze([
                (limit.maxTileCol - limit.minTileCol + 1) * this.pageSize[0]!,
                (limit.maxTileRow - limit.minTileRow + 1) * this.pageSize[1]!,
            ])
        }
        const scale = 2 ** level
        return Object.freeze(this.extent.map(value => Math.max(1, Math.ceil(value / scale))))
    }

    pageGrid(level: number): readonly number[] {

        const extent = this.levelExtent(level)
        return Object.freeze(extent.map((value, axis) =>
            Math.ceil(value / this.pageSize[axis]!),
        ))
    }

    levelOffset(level: number): number {

        this.#assertLevel(level)
        return this.#levelOffsets[level]!
    }

    page(descriptor: VirtualRasterPageDescriptor): VirtualRasterPageIdentity {

        this.#assertLevel(descriptor.level)
        const limit = this.#tileLimitsByLevel[descriptor.level]
        if (limit !== undefined) {
            const tile = this.tileCoverage!.tileMatrixSet.tile({
                matrixId: limit.matrixId,
                tileRow: descriptor.y ?? -1,
                tileCol: descriptor.x,
            })
            if (!this.tileCoverage!.contains(tile)) {
                return throwGeoDiagnostic({
                    code: 'GEO_VIRTUAL_RASTER_PAGE_INVALID',
                    phase: 'virtual-raster',
                    subject: { kind: 'virtual-raster-address-space', id: this.id },
                    message: 'A tile virtual page must be inside finite TileMatrixLimits.',
                    expected: { limit },
                    actual: tile,
                })
            }
            return Object.freeze({
                kind: 'virtual-raster-page',
                addressSpaceId: this.id,
                dimensions: 2,
                level: descriptor.level,
                coordinates: Object.freeze([ tile.tileCol, tile.tileRow ]),
                key: tile.key,
                tile,
            })
        }
        const coordinates = [ descriptor.x ]
        if (this.dimensions >= 2) coordinates.push(descriptor.y ?? 0)
        if (this.dimensions >= 3) coordinates.push(descriptor.z ?? 0)
        const grid = this.pageGrid(descriptor.level)
        if (coordinates.length !== this.dimensions ||
            coordinates.some((value, axis) =>
                !Number.isSafeInteger(value) || value < 0 || value >= grid[axis]!,
            )) {
            throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PAGE_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'Virtual page coordinates must be inside the selected level grid.',
                expected: { level: descriptor.level, grid },
                actual: { coordinates },
            })
        }
        return Object.freeze({
            kind: 'virtual-raster-page',
            addressSpaceId: this.id,
            dimensions: this.dimensions,
            level: descriptor.level,
            coordinates: Object.freeze(coordinates),
            key: `${descriptor.level}/${coordinates.join('/')}`,
        })
    }

    parent(page: VirtualRasterPageIdentity): VirtualRasterPageIdentity | undefined {

        this.assertPage(page)
        if (this.tileCoverage !== undefined) {
            const parent = this.tileCoverage.parent(page.tile!)
            return parent === undefined ? undefined : this.pageFromTile(parent)
        }
        if (page.level + 1 >= this.levelCount) return undefined
        const coordinates = page.coordinates.map(value => Math.floor(value / 2))
        return this.page({
            level: page.level + 1,
            x: coordinates[0]!,
            ...(this.dimensions >= 2 ? { y: coordinates[1]! } : {}),
            ...(this.dimensions >= 3 ? { z: coordinates[2]! } : {}),
        })
    }

    rootPage(): VirtualRasterPageIdentity {

        if (this.tileCoverage !== undefined) {
            const limit = this.tileCoverage.limits[0]!
            return this.pageFromTile({
                matrixId: limit.matrixId,
                tileRow: limit.minTileRow,
                tileCol: limit.minTileCol,
            })
        }
        return this.page({
            level: this.levelCount - 1,
            x: 0,
            ...(this.dimensions >= 2 ? { y: 0 } : {}),
            ...(this.dimensions >= 3 ? { z: 0 } : {}),
        })
    }

    tableIndex(page: VirtualRasterPageIdentity): number {

        this.assertPage(page)
        if (this.tileCoverage !== undefined) return this.tileCoverage.index(page.tile!)
        const grid = this.pageGrid(page.level)
        let localIndex = page.coordinates[0]!
        if (this.dimensions >= 2) localIndex += page.coordinates[1]! * grid[0]!
        if (this.dimensions >= 3) {
            localIndex += page.coordinates[2]! * grid[0]! * grid[1]!
        }
        return this.#levelOffsets[page.level]! + localIndex
    }

    pages(): readonly VirtualRasterPageIdentity[] {

        const pages: VirtualRasterPageIdentity[] = []
        if (this.tileCoverage !== undefined) {
            for (let level = 0; level < this.levelCount; level++) {
                const limit = this.#tileLimitsByLevel[level]!
                for (let row = limit.minTileRow; row <= limit.maxTileRow; row++) {
                    for (let col = limit.minTileCol; col <= limit.maxTileCol; col++) {
                        pages.push(this.page({ level, x: col, y: row }))
                    }
                }
            }
            return Object.freeze(pages)
        }
        for (let level = 0; level < this.levelCount; level++) {
            const grid = this.pageGrid(level)
            const depth = this.dimensions >= 3 ? grid[2]! : 1
            const height = this.dimensions >= 2 ? grid[1]! : 1
            for (let z = 0; z < depth; z++) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < grid[0]!; x++) {
                        pages.push(this.page({
                            level,
                            x,
                            ...(this.dimensions >= 2 ? { y } : {}),
                            ...(this.dimensions >= 3 ? { z } : {}),
                        }))
                    }
                }
            }
        }
        return Object.freeze(pages)
    }

    assertPage(page: VirtualRasterPageIdentity): void {

        if (page.addressSpaceId !== this.id || page.dimensions !== this.dimensions) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PAGE_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'A virtual page must belong to the address space that consumes it.',
                expected: { addressSpaceId: this.id, dimensions: this.dimensions },
                actual: page,
            })
        }
        const expected = this.page({
            level: page.level,
            x: page.coordinates[0]!,
            ...(this.dimensions >= 2 ? { y: page.coordinates[1]! } : {}),
            ...(this.dimensions >= 3 ? { z: page.coordinates[2]! } : {}),
        })
        if (expected.key !== page.key ||
            (this.tileCoverage !== undefined && expected.tile?.key !== page.tile?.key)) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PAGE_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-page', id: page.key },
                message: 'Virtual page identity fields are inconsistent.',
                expected,
                actual: page,
            })
        }
    }

    pageFromTile(descriptor: TileCoordinateDescriptor): VirtualRasterPageIdentity {

        if (this.tileCoverage === undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_ADDRESS_SPACE_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'Only a tile-coverage address space can create a page from a tile.',
                actual: descriptor,
            })
        }
        const level = this.#tileLevelsByMatrix.get(descriptor.matrixId)
        if (level === undefined || !this.tileCoverage.contains(descriptor)) {
            return throwGeoDiagnostic({
                code: 'GEO_TILE_MATRIX_COVERAGE_MISS',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'A standard tile must be inside this virtual raster coverage.',
                expected: { limits: this.tileCoverage.limits },
                actual: descriptor,
            })
        }
        return this.page({
            level,
            x: descriptor.tileCol,
            y: descriptor.tileRow,
        })
    }

    matrixId(level: number): TileMatrixId {

        this.#assertLevel(level)
        const matrixId = this.#tileLimitsByLevel[level]?.matrixId
        if (matrixId === undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_ADDRESS_SPACE_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'A dense address space has no TileMatrix identifier.',
                actual: { level },
            })
        }
        return matrixId
    }

    levelForMatrix(matrixId: TileMatrixId): number {

        const level = this.#tileLevelsByMatrix.get(matrixId)
        if (level === undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_TILE_MATRIX_COVERAGE_MISS',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'TileMatrix identifier is outside this virtual raster coverage.',
                expected: { matrixIds: [ ...this.#tileLevelsByMatrix.keys() ] },
                actual: { matrixId },
            })
        }
        return level
    }

    #assertLevel(level: number): void {

        if (!Number.isSafeInteger(level) || level < 0 || level >= this.levelCount) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_LEVEL_INVALID',
                phase: 'virtual-raster',
                subject: { kind: 'virtual-raster-address-space', id: this.id },
                message: 'Virtual raster level is outside the address-space pyramid.',
                expected: { minimum: 0, maximum: this.levelCount - 1 },
                actual: { level },
            })
        }
    }
}

export class VirtualRasterSnapshot {

    readonly kind = 'virtual-raster-snapshot'
    readonly addressSpace: VirtualRasterAddressSpace
    readonly epoch: number
    readonly pageTable: readonly VirtualRasterPageTableEntry[]
    readonly residentPageCount: number
    readonly logicalGpuBytes: number

    constructor(
        addressSpace: VirtualRasterAddressSpace,
        epoch: number,
        pageTable: readonly VirtualRasterPageTableEntry[],
        physicalMappings: ReadonlyMap<number, VirtualRasterPhysicalPage>
    ) {

        if (pageTable.length !== addressSpace.pageTableEntryCount) {
            throw new TypeError('VirtualRasterSnapshot page-table size does not match its address space.')
        }
        this.addressSpace = addressSpace
        this.epoch = epoch
        this.pageTable = Object.freeze([ ...pageTable ])
        this.residentPageCount = physicalMappings.size
        this.logicalGpuBytes = pageTable.length * 8 * 4 +
            [ ...physicalMappings.values() ].reduce((sum, page) => sum + page.byteLength, 0)
        snapshotRecords.set(this, new Map(pageTable.map(entry => [ entry.requestedPage.key, entry ])))
        snapshotPhysicalMappings.set(this, new Map(physicalMappings))
        Object.freeze(this)
    }

    resolve(page: VirtualRasterPageIdentity): VirtualRasterPageTableEntry {

        this.addressSpace.assertPage(page)
        const result = snapshotRecords.get(this)?.get(page.key)
        if (result === undefined) throw new TypeError('Virtual raster snapshot record is unavailable.')
        return result
    }
}

export class VirtualRasterAccessor {

    readonly addressSpace: VirtualRasterAddressSpace
    readonly plane: VirtualRasterPlane

    constructor(descriptor: VirtualRasterAccessorDescriptor) {

        if (descriptor.addressSpace.dimensions !== 2 ||
            descriptor.plane.addressSpace !== descriptor.addressSpace) {
            throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_ACCESSOR_INVALID',
                phase: 'sampling',
                subject: { kind: 'virtual-raster-plane', id: descriptor.plane.id },
                message: 'The physical virtual-raster accessor currently requires its owning 2D address space.',
                expected: { dimensions: 2, addressSpaceId: descriptor.addressSpace.id },
                actual: {
                    dimensions: descriptor.addressSpace.dimensions,
                    addressSpaceId: descriptor.plane.addressSpace.id,
                },
            })
        }
        this.addressSpace = descriptor.addressSpace
        this.plane = descriptor.plane
        Object.freeze(this)
    }

    sample(
        snapshot: VirtualRasterSnapshot,
        descriptor: VirtualRasterSampleDescriptor,
        cpuPages: VirtualRasterCpuPageProvider
    ): VirtualRasterSample {

        if (snapshot.addressSpace !== this.addressSpace) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_SNAPSHOT_MISMATCH',
                phase: 'sampling',
                subject: { kind: 'virtual-raster-plane', id: this.plane.id },
                message: 'Sampling requires a snapshot from the accessor address space.',
                expected: { addressSpaceId: this.addressSpace.id },
                actual: { addressSpaceId: snapshot.addressSpace.id },
            })
        }
        if (descriptor.profile.level >= this.addressSpace.levelCount) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_LEVEL_INVALID',
                phase: 'sampling',
                subject: { kind: 'virtual-raster-plane', id: this.plane.id },
                message: 'Sampling level is outside the virtual raster pyramid.',
                expected: { maximum: this.addressSpace.levelCount - 1 },
                actual: { level: descriptor.profile.level },
            })
        }
        return descriptor.profile.filter === 'nearest'
            ? this.#nearest(snapshot, descriptor.texel, descriptor.profile, cpuPages)
            : this.#bilinear(snapshot, descriptor.texel, descriptor.profile, cpuPages)
    }

    wgslModule(options: VirtualRasterAccessorWgslOptions): string {

        const namespace = normalizeNamespace(options.namespace, 'GeoVirtualRaster')
        for (const [ name, value ] of Object.entries({
            group: options.group,
            pageTableBinding: options.pageTableBinding,
            atlasBinding: options.atlasBinding,
        })) {
            if (!Number.isSafeInteger(value) || value < 0) {
                return throwGeoDiagnostic({
                    code: 'GEO_VIRTUAL_RASTER_ACCESSOR_INVALID',
                    phase: 'sampling',
                    subject: { kind: 'wgsl-module', id: namespace },
                    message: 'Virtual raster WGSL bindings must be non-negative integers.',
                    expected: { [name]: 'non-negative integer' },
                    actual: { [name]: value },
                })
            }
        }
        const levelExtents = Array.from({ length: this.addressSpace.levelCount }, (_, level) => {
            const extent = this.addressSpace.levelExtent(level)
            return `vec2u(${extent[0]}u, ${extent[1]}u)`
        }).join(', ')
        const pageGrids = Array.from({ length: this.addressSpace.levelCount }, (_, level) => {
            const grid = this.addressSpace.pageGrid(level)
            return `vec2u(${grid[0]}u, ${grid[1]}u)`
        }).join(', ')
        const levelOffsets = Array.from({ length: this.addressSpace.levelCount }, (_, level) =>
            `${this.addressSpace.levelOffset(level)}u`,
        ).join(', ')
        const scale = channelVector(this.plane.scale)
        const offset = channelVector(this.plane.offset)
        const rawScale = this.plane.sampleType === 'unorm8' ? '255.0' : '1.0'
        const noData = this.plane.noData === undefined
            ? 'false'
            : `abs(raw.x * ${rawScale} - ${Math.fround(this.plane.noData)}) < 0.5`

        return `struct ${namespace}Sample {\n` +
            `    value: vec4f,\n    status: u32,\n    requested_level: u32,\n    resolved_level: u32,\n}\n\n` +
            `@group(${options.group}) @binding(${options.pageTableBinding}) var<storage, read> ${namespace}_page_table: array<u32>;\n` +
            `@group(${options.group}) @binding(${options.atlasBinding}) var ${namespace}_atlas: texture_2d<f32>;\n\n` +
            `const ${namespace}_page_size = vec2u(${this.addressSpace.pageSize[0]}u, ${this.addressSpace.pageSize[1]}u);\n` +
            `const ${namespace}_level_extent = array<vec2u, ${this.addressSpace.levelCount}>(${levelExtents});\n` +
            `const ${namespace}_page_grid = array<vec2u, ${this.addressSpace.levelCount}>(${pageGrids});\n` +
            `const ${namespace}_level_offset = array<u32, ${this.addressSpace.levelCount}>(${levelOffsets});\n\n` +
            `fn ${namespace}_missing(level: u32) -> ${namespace}Sample { return ${namespace}Sample(vec4f(0.0), 0u, level, level); }\n\n` +
            `fn ${namespace}_load_texel(input_texel: vec2i, level: u32) -> ${namespace}Sample {\n` +
            `    let extent = ${namespace}_level_extent[level];\n` +
            `    let texel = vec2u(clamp(input_texel, vec2i(0), vec2i(extent) - vec2i(1)));\n` +
            `    let page = texel / ${namespace}_page_size;\n` +
            `    let table_index = ${namespace}_level_offset[level] + page.y * ${namespace}_page_grid[level].x + page.x;\n` +
            `    let base = table_index * 8u;\n` +
            `    let status = ${namespace}_page_table[base + 3u];\n` +
            `    if (status == 0u) { return ${namespace}_missing(level); }\n` +
            `    let resolved_level = ${namespace}_page_table[base + 2u];\n` +
            `    let level_scale = 1u << (resolved_level - level);\n` +
            `    let resolved_texel = texel / level_scale;\n` +
            `    let local_texel = resolved_texel % ${namespace}_page_size;\n` +
            `    let slot = vec2u(${namespace}_page_table[base], ${namespace}_page_table[base + 1u]);\n` +
            `    let raw = textureLoad(${namespace}_atlas, vec2i(slot * ${namespace}_page_size + local_texel), 0);\n` +
            `    if (${noData}) { return ${namespace}Sample(vec4f(0.0), 3u, level, resolved_level); }\n` +
            `    let decoded = raw * ${rawScale} * ${scale} + ${offset};\n` +
            `    return ${namespace}Sample(decoded, status, level, resolved_level);\n}\n\n` +
            `fn ${namespace}_sample_nearest(texel: vec2f, level: u32) -> ${namespace}Sample {\n` +
            `    return ${namespace}_load_texel(vec2i(floor(texel + vec2f(0.5))), level);\n}\n\n` +
            `fn ${namespace}_sample_bilinear(texel: vec2f, level: u32) -> ${namespace}Sample {\n` +
            `    let base_texel = vec2i(floor(texel));\n` +
            `    let fraction = fract(texel);\n` +
            `    let tl = ${namespace}_load_texel(base_texel, level);\n` +
            `    let tr = ${namespace}_load_texel(base_texel + vec2i(1, 0), level);\n` +
            `    let bl = ${namespace}_load_texel(base_texel + vec2i(0, 1), level);\n` +
            `    let br = ${namespace}_load_texel(base_texel + vec2i(1, 1), level);\n` +
            `    if (tl.status == 0u || tr.status == 0u || bl.status == 0u || br.status == 0u) { return ${namespace}_missing(level); }\n` +
            `    if (tl.status == 3u || tr.status == 3u || bl.status == 3u || br.status == 3u) { return ${namespace}Sample(vec4f(0.0), 3u, level, max(max(tl.resolved_level, tr.resolved_level), max(bl.resolved_level, br.resolved_level))); }\n` +
            `    let value = mix(mix(tl.value, tr.value, fraction.x), mix(bl.value, br.value, fraction.x), fraction.y);\n` +
            `    let status = max(max(tl.status, tr.status), max(bl.status, br.status));\n` +
            `    let resolved_level = max(max(tl.resolved_level, tr.resolved_level), max(bl.resolved_level, br.resolved_level));\n` +
            `    return ${namespace}Sample(value, status, level, resolved_level);\n}\n\n` +
            `fn ${namespace}_sample_vertex(texel: vec2f, level: u32) -> ${namespace}Sample { return ${namespace}_sample_bilinear(texel, level); }\n` +
            `fn ${namespace}_sample_fragment(texel: vec2f, level: u32) -> ${namespace}Sample { return ${namespace}_sample_bilinear(texel, level); }\n` +
            `fn ${namespace}_sample_compute(texel: vec2f, level: u32) -> ${namespace}Sample { return ${namespace}_sample_bilinear(texel, level); }\n`
    }

    #nearest(
        snapshot: VirtualRasterSnapshot,
        texel: readonly [number, number],
        profile: VirtualRasterSamplingProfile,
        cpuPages: VirtualRasterCpuPageProvider
    ): VirtualRasterSample {

        const resolved = this.#loadTexel(snapshot, [
            Math.floor(texel[0] + 0.5),
            Math.floor(texel[1] + 0.5),
        ], profile, cpuPages)
        return sampleFromResolved([ resolved ], profile.level, resolved.value)
    }

    #bilinear(
        snapshot: VirtualRasterSnapshot,
        texel: readonly [number, number],
        profile: VirtualRasterSamplingProfile,
        cpuPages: VirtualRasterCpuPageProvider
    ): VirtualRasterSample {

        const x = Math.floor(texel[0])
        const y = Math.floor(texel[1])
        const fx = texel[0] - x
        const fy = texel[1] - y
        const samples = [
            this.#loadTexel(snapshot, [ x, y ], profile, cpuPages),
            this.#loadTexel(snapshot, [ x + 1, y ], profile, cpuPages),
            this.#loadTexel(snapshot, [ x, y + 1 ], profile, cpuPages),
            this.#loadTexel(snapshot, [ x + 1, y + 1 ], profile, cpuPages),
        ]
        if (samples.some(sample => sample.status === 'missing' || sample.status === 'no-data')) {
            return sampleFromResolved(samples, profile.level, undefined)
        }
        const top = mixChannels(samples[0]!.value!, samples[1]!.value!, fx)
        const bottom = mixChannels(samples[2]!.value!, samples[3]!.value!, fx)
        return sampleFromResolved(samples, profile.level, mixChannels(top, bottom, fy))
    }

    #loadTexel(
        snapshot: VirtualRasterSnapshot,
        inputTexel: readonly [number, number],
        profile: VirtualRasterSamplingProfile,
        cpuPages: VirtualRasterCpuPageProvider
    ): ResolvedCpuTexel {

        const extent = this.addressSpace.levelExtent(profile.level)
        if (profile.outerBoundary === 'no-data' && (
            inputTexel[0] < 0 || inputTexel[1] < 0 ||
            inputTexel[0] >= extent[0]! || inputTexel[1] >= extent[1]!
        )) {
            return { status: 'no-data', resolvedLevel: profile.level }
        }
        const texel = [
            clamp(inputTexel[0], 0, extent[0]! - 1),
            clamp(inputTexel[1], 0, extent[1]! - 1),
        ] as const
        const requestedPage = this.addressSpace.page({
            level: profile.level,
            x: Math.floor(texel[0] / this.addressSpace.pageSize[0]!),
            y: Math.floor(texel[1] / this.addressSpace.pageSize[1]!),
        })
        const entry = snapshot.resolve(requestedPage)
        if (entry.status === 'missing' || entry.status === 'failed' ||
            entry.physicalSlot === undefined || entry.resolvedLevel === undefined) {
            return { status: 'missing', resolvedLevel: profile.level }
        }
        if (entry.resolvedPage === undefined) {
            return { status: 'missing', resolvedLevel: profile.level }
        }
        const physical = cpuPages.get(entry.resolvedPage)
        if (physical === undefined) return { status: 'missing', resolvedLevel: profile.level }
        const levelScale = 2 ** (entry.resolvedLevel - profile.level)
        const resolvedTexel = [
            Math.floor(texel[0] / levelScale),
            Math.floor(texel[1] / levelScale),
        ]
        const local = [
            resolvedTexel[0]! % this.addressSpace.pageSize[0]!,
            resolvedTexel[1]! % this.addressSpace.pageSize[1]!,
        ]
        const pixel = local[1]! * physical.width + local[0]!
        const value: number[] = []
        for (let channel = 0; channel < this.plane.channels; channel++) {
            const raw = physical.data[pixel * this.plane.channels + channel]
            if (raw === undefined || (this.plane.noData !== undefined && raw === this.plane.noData)) {
                return {
                    status: 'no-data',
                    resolvedLevel: entry.resolvedLevel,
                    physicalSlot: entry.physicalSlot,
                }
            }
            value.push(raw * this.plane.scale[channel]! + this.plane.offset[channel]!)
        }
        return {
            status: entry.status,
            value,
            resolvedLevel: entry.resolvedLevel,
            physicalSlot: entry.physicalSlot,
        }
    }
}

type ResolvedCpuTexel = {
    status: VirtualRasterSampleStatus
    value?: readonly number[]
    resolvedLevel: number
    physicalSlot?: number
}

export function virtualRasterAddressSpace(
    descriptor: VirtualRasterAddressSpaceDescriptor
): VirtualRasterAddressSpace {

    return new VirtualRasterAddressSpace(descriptor)
}

export function virtualRasterTileAddressSpace(
    descriptor: VirtualRasterTileAddressSpaceDescriptor
): VirtualRasterAddressSpace {

    return new VirtualRasterAddressSpace(descriptor)
}

export function virtualRasterPlane(descriptor: VirtualRasterPlaneDescriptor): VirtualRasterPlane {

    if (descriptor.addressSpace.dimensions !== 2 ||
        ![ 1, 2, 3, 4 ].includes(descriptor.channels)) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_PLANE_INVALID',
            phase: 'virtual-raster',
            subject: { kind: 'virtual-raster-plane', id: descriptor.id },
            message: 'Physical virtual-raster planes currently require a 2D address space and one to four channels.',
            expected: { dimensions: 2, channels: '1..4' },
            actual: { dimensions: descriptor.addressSpace.dimensions, channels: descriptor.channels },
        })
    }
    const scale = normalizeChannels(descriptor.scale ?? 1, descriptor.channels, 'scale', descriptor.id)
    const offset = normalizeChannels(descriptor.offset ?? 0, descriptor.channels, 'offset', descriptor.id)
    const plane: {
        kind: 'virtual-raster-plane'
        id: string
        addressSpace: VirtualRasterAddressSpace
        fieldKind: VirtualRasterFieldKind
        channels: 1 | 2 | 3 | 4
        sampleType: VirtualRasterSampleType
        gpuFormat: GPUTextureFormat
        noData?: number
        scale: readonly number[]
        offset: readonly number[]
        auxiliaryAxes: readonly Readonly<{ name: string, value: string | number }>[]
    } = {
        kind: 'virtual-raster-plane',
        id: descriptor.id,
        addressSpace: descriptor.addressSpace,
        fieldKind: descriptor.kind,
        channels: descriptor.channels,
        sampleType: descriptor.sampleType,
        gpuFormat: descriptor.gpuFormat,
        scale,
        offset,
        auxiliaryAxes: Object.freeze((descriptor.auxiliaryAxes ?? []).map(axis => Object.freeze({ ...axis }))),
    }
    if (descriptor.noData !== undefined) plane.noData = descriptor.noData
    return Object.freeze(plane)
}

export function virtualRasterSource(descriptor: VirtualRasterSourceDescriptor): VirtualRasterSource {

    if (typeof descriptor.id !== 'string' || descriptor.id.length === 0 ||
        typeof descriptor.loadPage !== 'function') {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_SOURCE_INVALID',
            phase: 'source',
            subject: { kind: 'virtual-raster-source', id: descriptor.id },
            message: 'A virtual-raster source requires a stable id and async page loader.',
            expected: { id: 'non-empty string', loadPage: 'function' },
            actual: descriptor,
        })
    }
    return Object.freeze({
        kind: 'virtual-raster-source',
        id: descriptor.id,
        loadPage: descriptor.loadPage,
    })
}

export function virtualRasterSamplingProfile(
    descriptor: VirtualRasterSamplingProfileDescriptor
): VirtualRasterSamplingProfile {

    if ((descriptor.filter !== 'nearest' && descriptor.filter !== 'bilinear') ||
        (descriptor.outerBoundary !== 'clamp' && descriptor.outerBoundary !== 'no-data') ||
        !Number.isSafeInteger(descriptor.level) || descriptor.level < 0) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_SAMPLING_PROFILE_INVALID',
            phase: 'sampling',
            subject: { kind: 'virtual-raster-sampling-profile' },
            message: 'Virtual raster sampling requires a supported filter, boundary policy, and explicit level.',
            expected: { filter: 'nearest | bilinear', outerBoundary: 'clamp | no-data', level: 'non-negative integer' },
            actual: descriptor,
        })
    }
    return Object.freeze({ kind: 'virtual-raster-sampling-profile', ...descriptor })
}

export function virtualRasterAccessor(
    descriptor: VirtualRasterAccessorDescriptor
): VirtualRasterAccessor {

    return new VirtualRasterAccessor(descriptor)
}

export function physicalPagesForSnapshot(
    snapshot: VirtualRasterSnapshot
): ReadonlyMap<number, VirtualRasterPhysicalPage> {

    const pages = snapshotPhysicalMappings.get(snapshot)
    if (pages === undefined) throw new TypeError('Virtual raster snapshot physical pages are unavailable.')
    return pages
}

function sampleFromResolved(
    samples: readonly ResolvedCpuTexel[],
    requestedLevel: number,
    value: readonly number[] | undefined
): VirtualRasterSample {

    const levels = samples.map(sample => sample.resolvedLevel)
    const slots = [ ...new Set(samples.flatMap(sample =>
        sample.physicalSlot === undefined ? [] : [ sample.physicalSlot ],
    )) ].sort((a, b) => a - b)
    const status: VirtualRasterSampleStatus = samples.some(sample => sample.status === 'missing')
        ? 'missing'
        : samples.some(sample => sample.status === 'no-data')
            ? 'no-data'
            : samples.some(sample => sample.status === 'fallback')
                ? 'fallback'
                : 'resident'
    const result: {
        status: VirtualRasterSampleStatus
        value?: readonly number[]
        requestedLevel: number
        resolvedLodRange: readonly [number, number]
        physicalSlots: readonly number[]
    } = {
        status,
        requestedLevel,
        resolvedLodRange: Object.freeze([ Math.min(...levels), Math.max(...levels) ]),
        physicalSlots: Object.freeze(slots),
    }
    if (value !== undefined) result.value = Object.freeze([ ...value ])
    return Object.freeze(result)
}

function mixChannels(a: readonly number[], b: readonly number[], ratio: number): number[] {

    return a.map((value, channel) => value * (1 - ratio) + b[channel]! * ratio)
}

function normalizeChannels(
    value: number | readonly number[],
    channels: number,
    role: string,
    planeId: string
): readonly number[] {

    const values = typeof value === 'number'
        ? Array.from({ length: channels }, () => value)
        : [ ...value ]
    if (values.length !== channels || values.some(channel => !Number.isFinite(channel))) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_PLANE_INVALID',
            phase: 'virtual-raster',
            subject: { kind: 'virtual-raster-plane', id: planeId },
            message: `${role} must provide one finite value per channel.`,
            expected: { channels },
            actual: { values },
        })
    }
    return Object.freeze(values)
}

function channelVector(values: readonly number[]): string {

    const expanded = Array.from({ length: 4 }, (_, index) =>
        `${Math.fround(values[Math.min(index, values.length - 1)]!)}f`,
    )
    return `vec4f(${expanded.join(', ')})`
}

function normalizeNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_ACCESSOR_INVALID',
            phase: 'sampling',
            subject: { kind: 'wgsl-module', id: namespace },
            message: 'Virtual raster WGSL namespace must be an identifier.',
            expected: { namespace: 'WGSL identifier' },
            actual: { namespace },
        })
    }
    return namespace
}

function isDimension(value: unknown): value is CoordinateDimension {

    return value === 1 || value === 2 || value === 3
}

function throwAddressSpaceInvalid(
    descriptor: VirtualRasterAddressSpaceDescriptor | VirtualRasterTileAddressSpaceDescriptor
): never {

    return throwGeoDiagnostic({
        code: 'GEO_VIRTUAL_RASTER_ADDRESS_SPACE_INVALID',
        phase: 'virtual-raster',
        subject: { kind: 'virtual-raster-address-space', id: descriptor.id },
        message: 'A virtual raster requires either finite dense axes or one finite 2D tile coverage.',
        expected: {
            dense: { dimensions: '1, 2, or 3', axisValues: 'positive integers' },
            tiled: { coverage: 'TileMatrixCoverage with a stable tile shape' },
        },
        actual: descriptor,
    })
}

function isPositiveInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function product(values: readonly number[]): number {

    return values.reduce((result, value) => result * value, 1)
}

function clamp(value: number, minimum: number, maximum: number): number {

    return Math.min(maximum, Math.max(minimum, value))
}
