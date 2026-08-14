import type { CoordinateDimension, CoordinateDomain, LocalVector } from './coordinate-domain.js'
import { throwGeoDiagnostic } from './diagnostics.js'

export type PositionEncoding = 'cell-local-f32' | 'wide-fixed'
export type CoordinateOverflowPolicy = 'error'
export type CoordinateWrapPolicy = 'none' | 'periodic'

export type PositionPrecisionFacts = Readonly<{
    dimensions: CoordinateDimension
    encoding: PositionEncoding
    bytesPerPosition: number
    cellExtent?: readonly number[]
    fixedQuantum?: number
    representableRange: Readonly<{ minimum: string, maximum: string }>
    maxLocalUlp: number
    quantizationError: number
    overflowPolicy: CoordinateOverflowPolicy
    wrapPolicy: CoordinateWrapPolicy
    supportedOperations: readonly string[]
}>

export type CellLocalPosition = Readonly<{
    encoding: 'cell-local-f32'
    dimensions: CoordinateDimension
    cells: readonly number[]
    local: readonly number[]
}>

export type CellLocalPositionInput = Readonly<{
    cells: readonly number[]
    local: readonly number[]
}>

export type CellLocalF32CodecOptions = Readonly<{
    domain: CoordinateDomain
    cellExtent: number | readonly number[]
    maxLocalUlp?: number
    wrapPeriodCells?: number | readonly number[]
}>

export type WideFixedAxis = Readonly<{
    low: number
    high: number
}>

export type WideFixedPosition = Readonly<{
    encoding: 'wide-fixed'
    dimensions: CoordinateDimension
    limbs: readonly WideFixedAxis[]
}>

export type WideFixedCodecOptions = Readonly<{
    domain: CoordinateDomain
    quantum: number
}>

export type WideFixedLodAddress = Readonly<{
    page: bigint
    texel: number
    subTexel: bigint
}>

export type PositionWgslOptions = Readonly<{
    namespace?: string
}>

const I32_MIN = -2_147_483_648
const I32_MAX = 2_147_483_647
const U32_MASK = 0xffff_ffffn
const I64_MIN = -(1n << 63n)
const I64_MAX = (1n << 63n) - 1n
const U64_MODULUS = 1n << 64n

/** Encodes positions as integer cells plus bounded f32 locals for stable dynamic shader work. */
export class CellLocalF32Codec {

    readonly domain: CoordinateDomain
    readonly facts: PositionPrecisionFacts
    readonly #cellExtent: readonly number[]
    readonly #wrapPeriodCells: readonly number[] | undefined

    constructor(options: CellLocalF32CodecOptions) {

        this.domain = options.domain
        this.#cellExtent = normalizePositiveAxes(
            options.cellExtent,
            options.domain,
            'cellExtent'
        )
        this.#wrapPeriodCells = options.wrapPeriodCells === undefined
            ? undefined
            : normalizePositiveIntegerAxes(options.wrapPeriodCells, options.domain)
        const maxLocalUlp = Math.max(...this.#cellExtent) * 2 ** -23
        this.facts = Object.freeze({
            dimensions: options.domain.intrinsicDimensions,
            encoding: 'cell-local-f32',
            bytesPerPosition: options.domain.intrinsicDimensions * 8,
            cellExtent: this.#cellExtent,
            representableRange: Object.freeze({
                minimum: String(I32_MIN),
                maximum: String(I32_MAX),
            }),
            maxLocalUlp,
            quantizationError: maxLocalUlp / 2,
            overflowPolicy: 'error',
            wrapPolicy: this.#wrapPeriodCells === undefined ? 'none' : 'periodic',
            supportedOperations: Object.freeze([
                'normalize',
                'advance',
                'difference',
                'rebase',
                'camera-relative-difference',
                'pack',
                'unpack',
            ]),
        })
        Object.freeze(this)
    }

    normalize(input: CellLocalPositionInput): CellLocalPosition {

        assertAxisCount(this.domain, input.cells, 'cells')
        assertAxisCount(this.domain, input.local, 'local')
        const cells: number[] = []
        const local: number[] = []
        for (let axis = 0; axis < this.domain.intrinsicDimensions; axis++) {
            const inputCell = input.cells[axis]!
            const inputLocal = input.local[axis]!
            if (!Number.isSafeInteger(inputCell) || !Number.isFinite(inputLocal)) {
                throwCellOverflow(this.domain, axis, inputCell, inputLocal)
            }
            const extent = this.#cellExtent[axis]!
            let localValue = Math.fround(inputLocal)
            let carry = Math.floor(localValue / extent)
            localValue = Math.fround(localValue - carry * extent)
            if (localValue >= extent) {
                carry++
                localValue = 0
            } else if (localValue < 0) {
                carry--
                localValue = Math.fround(localValue + extent)
            }
            let cell = inputCell + carry
            const wrapPeriod = this.#wrapPeriodCells?.[axis]
            if (wrapPeriod !== undefined) cell = positiveModulo(cell, wrapPeriod)
            if (!Number.isSafeInteger(cell) || cell < I32_MIN || cell > I32_MAX) {
                throwCellOverflow(this.domain, axis, cell, localValue)
            }
            cells.push(cell)
            local.push(localValue)
        }
        return freezeCellPosition(this.domain.intrinsicDimensions, cells, local)
    }

    advance(position: CellLocalPosition, displacement: LocalVector): CellLocalPosition {

        this.#assertPosition(position)
        if (displacement.domainId !== this.domain.id ||
            displacement.basis !== this.domain.id ||
            displacement.dimensions !== this.domain.intrinsicDimensions) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_VECTOR_BASIS_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: this.domain.id, encoding: 'cell-local-f32' },
                message: 'A displacement must use the position domain basis.',
                expected: { domainId: this.domain.id, basis: this.domain.id },
                actual: { domainId: displacement.domainId, basis: displacement.basis },
            })
        }
        for (let axis = 0; axis < this.domain.intrinsicDimensions; axis++) {
            if (displacement.unit !== this.domain.axes[axis]!.unit) {
                return throwGeoDiagnostic({
                    code: 'GEO_COORDINATE_VECTOR_BASIS_MISMATCH',
                    phase: 'coordinate',
                    subject: { kind: 'position-codec', id: this.domain.id, axis },
                    message: 'A displacement unit must match the coordinate axis unit.',
                    expected: { unit: this.domain.axes[axis]!.unit },
                    actual: { unit: displacement.unit },
                })
            }
        }
        return this.normalize({
            cells: position.cells,
            local: position.local.map((value, axis) =>
                Math.fround(value + displacement.values[axis]!),
            ),
        })
    }

    difference(position: CellLocalPosition, origin: CellLocalPosition): number[] {

        this.#assertPosition(position)
        this.#assertPosition(origin)
        return position.cells.map((cell, axis) => Math.fround(
            (cell - origin.cells[axis]!) * this.#cellExtent[axis]! +
            (position.local[axis]! - origin.local[axis]!),
        ))
    }

    cameraRelative(position: CellLocalPosition, camera: CellLocalPosition): number[] {

        return this.difference(position, camera)
    }

    rebase(position: CellLocalPosition, origin: CellLocalPosition): CellLocalPosition {

        this.#assertPosition(position)
        this.#assertPosition(origin)
        return this.normalize({
            cells: position.cells.map((cell, axis) => cell - origin.cells[axis]!),
            local: position.local.map((value, axis) => value - origin.local[axis]!),
        })
    }

    assertPrecisionBudget(maximumUlp: number): void {

        if (!Number.isFinite(maximumUlp) || maximumUlp <= 0 ||
            this.facts.maxLocalUlp > maximumUlp) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_PRECISION_BUDGET_EXCEEDED',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: this.domain.id, encoding: 'cell-local-f32' },
                message: 'The cell-local f32 ULP exceeds the requested precision budget.',
                expected: { maxLocalUlp: maximumUlp },
                actual: { maxLocalUlp: this.facts.maxLocalUlp },
            })
        }
    }

    pack(positions: readonly CellLocalPosition[]): Uint8Array {

        const bytes = new Uint8Array(positions.length * this.facts.bytesPerPosition)
        const view = new DataView(bytes.buffer)
        positions.forEach((position, positionIndex) => {
            this.#assertPosition(position)
            for (let axis = 0; axis < this.domain.intrinsicDimensions; axis++) {
                const offset = positionIndex * this.facts.bytesPerPosition + axis * 8
                view.setInt32(offset, position.cells[axis]!, true)
                view.setFloat32(offset + 4, position.local[axis]!, true)
            }
        })
        return bytes
    }

    unpack(bytes: ArrayBuffer | ArrayBufferView): CellLocalPosition[] {

        const view = dataViewOf(bytes)
        assertPackedLength(this.domain, view.byteLength, this.facts.bytesPerPosition)
        const result: CellLocalPosition[] = []
        for (let positionOffset = 0; positionOffset < view.byteLength;
            positionOffset += this.facts.bytesPerPosition) {
            const cells: number[] = []
            const local: number[] = []
            for (let axis = 0; axis < this.domain.intrinsicDimensions; axis++) {
                const offset = positionOffset + axis * 8
                cells.push(view.getInt32(offset, true))
                local.push(view.getFloat32(offset + 4, true))
            }
            result.push(freezeCellPosition(this.domain.intrinsicDimensions, cells, local))
        }
        return result
    }

    wgslModule(options: PositionWgslOptions = {}): string {

        const namespace = normalizeNamespace(options.namespace, 'GeoCellLocal')
        const extents = this.#cellExtent.map(value => `${Math.fround(value)}f`).join(', ')
        const dimensions = this.domain.intrinsicDimensions
        return `struct ${namespace}Axis {\n    cell: i32,\n    local: f32,\n}\n\n` +
            `struct ${namespace}Position {\n    axes: array<${namespace}Axis, ${dimensions}>,\n}\n\n` +
            `const ${namespace}_cell_extent = array<f32, ${dimensions}>(${extents});\n\n` +
            `fn ${namespace}_normalize(value: ${namespace}Position) -> ${namespace}Position {\n` +
            `    var result = value;\n` +
            `    for (var axis = 0u; axis < ${dimensions}u; axis++) {\n` +
            `        let extent = ${namespace}_cell_extent[axis];\n` +
            `        let carry = floor(result.axes[axis].local / extent);\n` +
            `        result.axes[axis].cell += i32(carry);\n` +
            `        result.axes[axis].local -= carry * extent;\n` +
            `    }\n    return result;\n}\n\n` +
            `fn ${namespace}_advance(value: ${namespace}Position, delta: array<f32, ${dimensions}>) -> ${namespace}Position {\n` +
            `    var result = value;\n` +
            `    for (var axis = 0u; axis < ${dimensions}u; axis++) { result.axes[axis].local += delta[axis]; }\n` +
            `    return ${namespace}_normalize(result);\n}\n\n` +
            `fn ${namespace}_difference(value: ${namespace}Position, origin: ${namespace}Position) -> array<f32, ${dimensions}> {\n` +
            `    var result: array<f32, ${dimensions}>;\n` +
            `    for (var axis = 0u; axis < ${dimensions}u; axis++) {\n` +
            `        result[axis] = f32(value.axes[axis].cell - origin.axes[axis].cell) * ${namespace}_cell_extent[axis] + value.axes[axis].local - origin.axes[axis].local;\n` +
            `    }\n    return result;\n}\n`
    }

    #assertPosition(position: CellLocalPosition): void {

        if (position.encoding !== 'cell-local-f32' ||
            position.dimensions !== this.domain.intrinsicDimensions ||
            position.cells.length !== this.domain.intrinsicDimensions ||
            position.local.length !== this.domain.intrinsicDimensions) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: this.domain.id },
                message: 'Cell-local position does not match its codec domain.',
                expected: { dimensions: this.domain.intrinsicDimensions, encoding: 'cell-local-f32' },
                actual: position,
            })
        }
    }
}

/** Quantizes canonical positions into signed 64-bit axes represented by portable word pairs. */
export class WideFixedCodec {

    readonly domain: CoordinateDomain
    readonly facts: PositionPrecisionFacts

    constructor(options: WideFixedCodecOptions) {

        if (!Number.isFinite(options.quantum) || options.quantum <= 0) {
            throwGeoDiagnostic({
                code: 'GEO_COORDINATE_INVALID_DOMAIN',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: options.domain.id, encoding: 'wide-fixed' },
                message: 'A wide-fixed quantum must be finite and positive.',
                expected: { quantum: 'positive finite number' },
                actual: { quantum: options.quantum },
            })
        }
        this.domain = options.domain
        this.facts = Object.freeze({
            dimensions: options.domain.intrinsicDimensions,
            encoding: 'wide-fixed',
            bytesPerPosition: options.domain.intrinsicDimensions * 8,
            fixedQuantum: options.quantum,
            representableRange: Object.freeze({ minimum: String(I64_MIN), maximum: String(I64_MAX) }),
            maxLocalUlp: options.quantum,
            quantizationError: options.quantum / 2,
            overflowPolicy: 'error',
            wrapPolicy: 'none',
            supportedOperations: Object.freeze([
                'add',
                'subtract',
                'difference',
                'lod-address-decomposition',
                'pack',
                'unpack',
            ]),
        })
        Object.freeze(this)
    }

    fromQuanta(values: readonly bigint[]): WideFixedPosition {

        assertAxisCount(this.domain, values, 'quanta')
        return freezeWidePosition(
            this.domain.intrinsicDimensions,
            values.map((value, axis) => signedBigIntToAxis(this.domain, value, axis)),
        )
    }

    toQuanta(position: WideFixedPosition): bigint[] {

        this.#assertPosition(position)
        return position.limbs.map(axisToSignedBigInt)
    }

    add(position: WideFixedPosition, delta: readonly bigint[]): WideFixedPosition {

        const values = this.toQuanta(position)
        assertAxisCount(this.domain, delta, 'delta')
        return this.fromQuanta(values.map((value, axis) => value + delta[axis]!))
    }

    subtract(position: WideFixedPosition, delta: readonly bigint[]): WideFixedPosition {

        const values = this.toQuanta(position)
        assertAxisCount(this.domain, delta, 'delta')
        return this.fromQuanta(values.map((value, axis) => value - delta[axis]!))
    }

    difference(position: WideFixedPosition, origin: WideFixedPosition): bigint[] {

        const values = this.toQuanta(position)
        const originValues = this.toQuanta(origin)
        return values.map((value, axis) => value - originValues[axis]!)
    }

    decomposeLod(
        position: WideFixedPosition,
        options: Readonly<{ lod: number, pageSize: number }>
    ): readonly WideFixedLodAddress[] {

        if (!Number.isSafeInteger(options.lod) || options.lod < 0 || options.lod > 31 ||
            !Number.isSafeInteger(options.pageSize) || options.pageSize <= 0) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_INVALID_DOMAIN',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: this.domain.id, encoding: 'wide-fixed' },
                message: 'LoD decomposition requires a non-negative LoD and positive page size.',
                expected: { lod: 'integer in [0, 31]', pageSize: 'positive integer' },
                actual: options,
            })
        }
        const texelQuantum = 1n << BigInt(options.lod)
        const pageQuantum = texelQuantum * BigInt(options.pageSize)
        return Object.freeze(this.toQuanta(position).map(value => {
            const page = floorDivide(value, pageQuantum)
            const withinPage = value - page * pageQuantum
            const texel = Number(withinPage / texelQuantum)
            const subTexel = withinPage % texelQuantum
            return Object.freeze({ page, texel, subTexel })
        }))
    }

    pack(positions: readonly WideFixedPosition[]): Uint8Array {

        const bytes = new Uint8Array(positions.length * this.facts.bytesPerPosition)
        const view = new DataView(bytes.buffer)
        positions.forEach((position, positionIndex) => {
            this.#assertPosition(position)
            position.limbs.forEach((axis, axisIndex) => {
                const offset = positionIndex * this.facts.bytesPerPosition + axisIndex * 8
                view.setUint32(offset, axis.low, true)
                view.setUint32(offset + 4, axis.high, true)
            })
        })
        return bytes
    }

    unpack(bytes: ArrayBuffer | ArrayBufferView): WideFixedPosition[] {

        const view = dataViewOf(bytes)
        assertPackedLength(this.domain, view.byteLength, this.facts.bytesPerPosition)
        const result: WideFixedPosition[] = []
        for (let positionOffset = 0; positionOffset < view.byteLength;
            positionOffset += this.facts.bytesPerPosition) {
            const limbs: WideFixedAxis[] = []
            for (let axis = 0; axis < this.domain.intrinsicDimensions; axis++) {
                const offset = positionOffset + axis * 8
                limbs.push(Object.freeze({
                    low: view.getUint32(offset, true),
                    high: view.getUint32(offset + 4, true),
                }))
            }
            result.push(freezeWidePosition(this.domain.intrinsicDimensions, limbs))
        }
        return result
    }

    wgslModule(options: PositionWgslOptions = {}): string {

        const namespace = normalizeNamespace(options.namespace, 'GeoWideFixed')
        const dimensions = this.domain.intrinsicDimensions
        const quantum = `${Math.fround(this.facts.fixedQuantum!)}f`
        return `struct ${namespace}Axis {\n    low: u32,\n    high: u32,\n}\n\n` +
            `struct ${namespace}Position {\n    axes: array<${namespace}Axis, ${dimensions}>,\n}\n\n` +
            `const ${namespace}_quantum = ${quantum};\n\n` +
            `fn ${namespace}_add_axis(a: ${namespace}Axis, b: ${namespace}Axis) -> ${namespace}Axis {\n` +
            `    let low = a.low + b.low;\n` +
            `    let carry = select(0u, 1u, low < a.low);\n` +
            `    return ${namespace}Axis(low, a.high + b.high + carry);\n}\n\n` +
            `fn ${namespace}_subtract_axis(a: ${namespace}Axis, b: ${namespace}Axis) -> ${namespace}Axis {\n` +
            `    let borrow = select(0u, 1u, a.low < b.low);\n` +
            `    return ${namespace}Axis(a.low - b.low, a.high - b.high - borrow);\n}\n\n` +
            `fn ${namespace}_add(value: ${namespace}Position, delta: ${namespace}Position) -> ${namespace}Position {\n` +
            `    var result = value;\n` +
            `    for (var axis = 0u; axis < ${dimensions}u; axis++) { result.axes[axis] = ${namespace}_add_axis(value.axes[axis], delta.axes[axis]); }\n` +
            `    return result;\n}\n\n` +
            `fn ${namespace}_subtract(value: ${namespace}Position, delta: ${namespace}Position) -> ${namespace}Position {\n` +
            `    var result = value;\n` +
            `    for (var axis = 0u; axis < ${dimensions}u; axis++) { result.axes[axis] = ${namespace}_subtract_axis(value.axes[axis], delta.axes[axis]); }\n` +
            `    return result;\n}\n\n` +
            `fn ${namespace}_from_shifted_u32(value: u32, shift: u32) -> ${namespace}Axis {\n` +
            `    if (shift == 0u) { return ${namespace}Axis(value, 0u); }\n` +
            `    if (shift < 32u) { return ${namespace}Axis(value << shift, value >> (32u - shift)); }\n` +
            `    return ${namespace}Axis(0u, value << (shift - 32u));\n}\n\n` +
            `fn ${namespace}_axis_magnitude(value: ${namespace}Axis) -> ${namespace}Axis {\n` +
            `    if ((value.high & 0x80000000u) == 0u) { return value; }\n` +
            `    let low = ~value.low + 1u;\n` +
            `    let carry = select(0u, 1u, low == 0u);\n` +
            `    return ${namespace}Axis(low, ~value.high + carry);\n}\n\n` +
            `fn ${namespace}_signed_axis_f32(value: ${namespace}Axis, scale: f32) -> f32 {\n` +
            `    let negative = (value.high & 0x80000000u) != 0u;\n` +
            `    let magnitude = ${namespace}_axis_magnitude(value);\n` +
            `    let result = f32(magnitude.high) * ldexp(scale, 32) + f32(magnitude.low) * scale;\n` +
            `    return select(result, -result, negative);\n}\n\n` +
            `fn ${namespace}_signed_difference_f32(value: ${namespace}Axis, origin: ${namespace}Axis) -> f32 {\n` +
            `    return ${namespace}_signed_axis_f32(${namespace}_subtract_axis(value, origin), ${namespace}_quantum);\n}\n\n` +
            `fn ${namespace}_fraction_f32(value: ${namespace}Axis, fractional_bits: u32) -> f32 {\n` +
            `    return ${namespace}_signed_axis_f32(value, ldexp(1.0f, -i32(fractional_bits)));\n}\n\n` +
            `fn ${namespace}_subtract_expansions_f32(left: vec2f, right: vec2f) -> f32 {\n` +
            `    let low_difference = left.y - right.y;\n` +
            `    if (left.x == right.x) { return low_difference; }\n` +
            `    let difference = left.x - right.x;\n` +
            `    let bridge = difference - left.x;\n` +
            `    let roundoff = (left.x - (difference - bridge)) - (right.x + bridge);\n` +
            `    return difference + (roundoff + low_difference);\n}\n`
    }

    #assertPosition(position: WideFixedPosition): void {

        if (position.encoding !== 'wide-fixed' ||
            position.dimensions !== this.domain.intrinsicDimensions ||
            position.limbs.length !== this.domain.intrinsicDimensions) {
            return throwGeoDiagnostic({
                code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
                phase: 'coordinate',
                subject: { kind: 'position-codec', id: this.domain.id },
                message: 'Wide-fixed position does not match its codec domain.',
                expected: { dimensions: this.domain.intrinsicDimensions, encoding: 'wide-fixed' },
                actual: position,
            })
        }
    }
}

/** Creates a cell-local f32 codec for one coordinate domain. */
export function cellLocalF32Codec(options: CellLocalF32CodecOptions): CellLocalF32Codec {

    return new CellLocalF32Codec(options)
}

/** Creates a wide fixed-point codec for one coordinate domain and quantum. */
export function wideFixedCodec(options: WideFixedCodecOptions): WideFixedCodec {

    return new WideFixedCodec(options)
}

function normalizePositiveAxes(
    value: number | readonly number[],
    domain: CoordinateDomain,
    name: string
): readonly number[] {

    const values = typeof value === 'number'
        ? Array.from({ length: domain.intrinsicDimensions }, () => value)
        : [ ...value ]
    if (values.length !== domain.intrinsicDimensions ||
        values.some(axis => !Number.isFinite(axis) || axis <= 0)) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
            phase: 'coordinate',
            subject: { kind: 'position-codec', id: domain.id },
            message: `${name} must provide one finite positive value per axis.`,
            expected: { dimensions: domain.intrinsicDimensions },
            actual: { values },
        })
    }
    return Object.freeze(values)
}

function normalizePositiveIntegerAxes(
    value: number | readonly number[],
    domain: CoordinateDomain
): readonly number[] {

    const values = normalizePositiveAxes(value, domain, 'wrapPeriodCells')
    if (values.some(axis => !Number.isSafeInteger(axis))) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_INVALID_DOMAIN',
            phase: 'coordinate',
            subject: { kind: 'position-codec', id: domain.id },
            message: 'Cell wrapping periods must be positive safe integers.',
            expected: { wrapPeriodCells: 'positive safe integers' },
            actual: { wrapPeriodCells: values },
        })
    }
    return values
}

function assertAxisCount(
    domain: CoordinateDomain,
    values: readonly unknown[],
    role: string
): void {

    if (values.length !== domain.intrinsicDimensions) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
            phase: 'coordinate',
            subject: { kind: 'coordinate-domain', id: domain.id },
            message: `${role} must provide one value per intrinsic axis.`,
            expected: { dimensions: domain.intrinsicDimensions },
            actual: { dimensions: values.length },
        })
    }
}

function throwCellOverflow(
    domain: CoordinateDomain,
    axis: number,
    cell: number,
    local: number
): never {

    return throwGeoDiagnostic({
        code: 'GEO_COORDINATE_CELL_OVERFLOW',
        phase: 'coordinate',
        subject: { kind: 'position-codec', id: domain.id, axis, encoding: 'cell-local-f32' },
        message: 'Cell-local normalization exceeded the signed i32 cell range.',
        expected: { minimumCell: I32_MIN, maximumCell: I32_MAX },
        actual: { cell, local },
    })
}

function signedBigIntToAxis(
    domain: CoordinateDomain,
    value: bigint,
    axis: number
): WideFixedAxis {

    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_FIXED_OVERFLOW',
            phase: 'coordinate',
            subject: { kind: 'position-codec', id: domain.id, axis, encoding: 'wide-fixed' },
            message: 'Wide-fixed arithmetic exceeded the signed 64-bit logical range.',
            expected: { minimum: String(I64_MIN), maximum: String(I64_MAX) },
            actual: { value: String(value) },
        })
    }
    const unsigned = value < 0 ? U64_MODULUS + value : value
    return Object.freeze({
        low: Number(unsigned & U32_MASK),
        high: Number((unsigned >> 32n) & U32_MASK),
    })
}

function axisToSignedBigInt(axis: WideFixedAxis): bigint {

    const unsigned = (BigInt(axis.high) << 32n) | BigInt(axis.low)
    return (axis.high & 0x8000_0000) === 0 ? unsigned : unsigned - U64_MODULUS
}

function freezeCellPosition(
    dimensions: CoordinateDimension,
    cells: readonly number[],
    local: readonly number[]
): CellLocalPosition {

    return Object.freeze({
        encoding: 'cell-local-f32',
        dimensions,
        cells: Object.freeze([ ...cells ]),
        local: Object.freeze([ ...local ]),
    })
}

function freezeWidePosition(
    dimensions: CoordinateDimension,
    limbs: readonly WideFixedAxis[]
): WideFixedPosition {

    return Object.freeze({
        encoding: 'wide-fixed',
        dimensions,
        limbs: Object.freeze(limbs.map(axis => Object.freeze({ low: axis.low, high: axis.high }))),
    })
}

function dataViewOf(bytes: ArrayBuffer | ArrayBufferView): DataView {

    if (bytes instanceof ArrayBuffer) return new DataView(bytes)
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function assertPackedLength(
    domain: CoordinateDomain,
    byteLength: number,
    stride: number
): void {

    if (byteLength % stride !== 0) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_DIMENSION_MISMATCH',
            phase: 'coordinate',
            subject: { kind: 'position-codec', id: domain.id },
            message: 'Packed coordinate bytes must contain a whole number of positions.',
            expected: { byteLengthMultiple: stride },
            actual: { byteLength },
        })
    }
}

function normalizeNamespace(value: string | undefined, fallback: string): string {

    const namespace = value ?? fallback
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(namespace)) {
        return throwGeoDiagnostic({
            code: 'GEO_COORDINATE_INVALID_DOMAIN',
            phase: 'coordinate',
            subject: { kind: 'wgsl-module', id: namespace },
            message: 'WGSL namespaces must be identifiers.',
            expected: { namespace: 'WGSL identifier' },
            actual: { namespace },
        })
    }
    return namespace
}

function positiveModulo(value: number, modulus: number): number {

    return ((value % modulus) + modulus) % modulus
}

function floorDivide(value: bigint, divisor: bigint): bigint {

    const quotient = value / divisor
    const remainder = value % divisor
    return remainder < 0n ? quotient - 1n : quotient
}
