import { createScratchDiagnosticReport, throwScratchDiagnostic } from './diagnostics.js'
import {
    createLayoutArtifact,
    createLayoutBufferViewContract,
    describeLayoutCompatibilityDifference,
    isLayoutArtifact,
    isLayoutBufferViewContract,
    layoutArtifactAcceptsBindingByteLength,
    layoutArtifactAcceptsViewByteLength,
    layoutArtifactByteLength,
    layoutArtifactRuntimeElementCount,
    layoutArtifactSubject,
    layoutArtifactsAbiCompatible,
    layoutArtifactsSchemaCompatible,
} from './layout-artifact.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject, ScratchDiagnosticReport } from './diagnostics.js'
import type {
    LayoutArtifact,
    LayoutAtomicTypeArtifact,
    LayoutBufferViewContract,
    LayoutBufferViewDescriptor,
    LayoutCanonicalSpec,
    LayoutCodecOptions,
    LayoutFieldArtifact,
    LayoutRuntimeExtent,
    LayoutScalarType,
    LayoutSpec,
    LayoutStructTypeDescriptor,
    LayoutTypeArtifact,
} from './layout-artifact.js'

export type * from './layout-artifact.js'
export {
    describeLayoutCompatibilityDifference,
    isLayoutArtifact,
    isLayoutBufferViewContract,
    layoutArtifactAcceptsBindingByteLength,
    layoutArtifactAcceptsViewByteLength,
    layoutArtifactByteLength,
    layoutArtifactRuntimeElementCount,
    layoutArtifactSubject,
    layoutArtifactsAbiCompatible,
    layoutArtifactsSchemaCompatible,
}

export type LayoutValue = unknown
export type LayoutValues = Record<string, unknown>

export type LayoutUploadView = Readonly<{
    bytes: Uint8Array
    byteOffset: number
    byteLength: number
    artifact: LayoutArtifact
}>

export type LayoutReadbackView = Readonly<{
    artifact: LayoutArtifact
    bytes: Uint8Array
    dataView: DataView
    count: number
    byteLength: number
    runtimeElementCount?: number
    toValue(index?: number): unknown
    toObject(index?: number): Record<string, unknown>
    toArray(): Record<string, unknown>[]
}>

export type LayoutWriteOptions = Readonly<{
    byteOffset?: number
    runtimeElementCount?: number
}>

export type LayoutPackOptions = LayoutRuntimeExtent

export type LayoutWgslAccessorOptions = Readonly<{
    namespace?: string
}>

export type LayoutWgslBufferViewOptions = Readonly<{
    namespace?: string
}>

const layoutCodecs = new WeakSet<LayoutCodec>()
const float64BitScratch = new DataView(new ArrayBuffer(8))

export class LayoutCodec {

    readonly spec: LayoutCanonicalSpec
    readonly artifact: LayoutArtifact
    readonly report: ScratchDiagnosticReport

    constructor(spec: LayoutSpec, options: LayoutCodecOptions = {}) {

        const prepared = createLayoutArtifact(spec, options)
        this.spec = prepared.spec
        this.artifact = prepared.artifact
        this.report = createScratchDiagnosticReport()
        layoutCodecs.add(this)
    }

    get subject(): DiagnosticSubject {

        return layoutArtifactSubject(this.artifact)
    }

    byteLength(options?: LayoutRuntimeExtent): number {

        return layoutArtifactByteLength(this.artifact, options)
    }

    bufferView(descriptor: LayoutBufferViewDescriptor): LayoutBufferViewContract {

        return createLayoutBufferViewContract(this.artifact, descriptor)
    }

    pack(
        values: LayoutValue | readonly LayoutValues[],
        options?: LayoutPackOptions
    ): Uint8Array {

        if (this.artifact.type.kind === 'buffer') {
            return packOpaqueBuffer(this, values, options)
        }
        const records = normalizeRootValues(this, values)
        const byteLength = packedByteLength(this, records.length, options)
        const target = new ArrayBuffer(byteLength)

        return this.write(target, values, options)
    }

    write(
        target: ArrayBuffer | ArrayBufferView,
        values: LayoutValue | readonly LayoutValues[],
        options: LayoutWriteOptions = {}
    ): Uint8Array {

        if (this.artifact.type.kind === 'buffer') {
            return writeOpaqueBuffer(this, target, values, options)
        }
        const records = normalizeRootValues(this, values)
        const runtimeExtent = runtimeExtentFromWriteOptions(options)
        const byteLength = packedByteLength(this, records.length, runtimeExtent)
        const byteOffset = normalizeByteOffset(this.subject, options.byteOffset)
        const bytes = createByteView(this.subject, target, byteOffset, byteLength)
        const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

        bytes.fill(0)
        if (this.artifact.extent === 'runtime') {
            const count = requireRuntimeElementCount(this.artifact, runtimeExtent)
            writeLayoutValue(
                this.artifact,
                dataView,
                0,
                this.artifact.type,
                records[0],
                this.artifact.name,
                count
            )
            return bytes
        }

        const artifact = this.artifact
        records.forEach((record, recordIndex) => {
            writeLayoutValue(
                artifact,
                dataView,
                recordIndex * artifact.stride,
                artifact.type,
                record,
                artifact.name,
                undefined
            )
        })
        return bytes
    }

    uploadView(
        values: LayoutValue | readonly LayoutValues[],
        options?: LayoutPackOptions
    ): LayoutUploadView {

        const bytes = this.pack(values, options)

        return Object.freeze({
            bytes,
            byteOffset: bytes.byteOffset,
            byteLength: bytes.byteLength,
            artifact: this.artifact,
        })
    }

    createReadbackView(bytes: ArrayBuffer | ArrayBufferView): LayoutReadbackView {

        return createLayoutReadbackView(this.artifact, bytes)
    }

    wgslAccessors(options: LayoutWgslAccessorOptions = {}): string {

        const namespace = normalizeNamespace(this.subject, options.namespace, this.artifact.name)
        return generateWgslAccessors(this.artifact, namespace)
    }

    wgslBufferViewConstants(
        contract: LayoutBufferViewContract,
        options: LayoutWgslBufferViewOptions = {}
    ): string {

        if (
            !isLayoutBufferViewContract(contract) ||
            contract.source !== this.artifact
        ) {
            throwCodecDiagnostic(
                'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID',
                this.subject,
                'WGSL buffer-view constants require a contract created by this LayoutCodec.',
                { contract: 'LayoutBufferViewContract owned by this LayoutCodec' },
                {
                    contract: describeValue(contract),
                    sourceMatches: isLayoutBufferViewContract(contract)
                        ? contract.source === this.artifact
                        : false,
                }
            )
        }
        const namespace = normalizeNamespace(
            this.subject,
            options.namespace,
            `${this.artifact.name}View`
        )
        return generateBufferViewConstants(contract, namespace)
    }
}

export function isLayoutCodec(value: unknown): value is LayoutCodec {

    return typeof value === 'object' &&
        value !== null &&
        Object.getPrototypeOf(value) === LayoutCodec.prototype &&
        layoutCodecs.has(value as LayoutCodec)
}

export function layoutCodec(
    spec: LayoutSpec,
    options?: LayoutCodecOptions
): LayoutCodec {

    return new LayoutCodec(spec, options)
}

export function isLayoutUploadView(value: unknown): value is LayoutUploadView {

    return isRecord(value) &&
        value.bytes instanceof Uint8Array &&
        typeof value.byteOffset === 'number' &&
        Number.isSafeInteger(value.byteOffset) &&
        value.byteOffset >= 0 &&
        typeof value.byteLength === 'number' &&
        Number.isSafeInteger(value.byteLength) &&
        value.byteLength > 0 &&
        isLayoutArtifact(value.artifact)
}

export function createLayoutReadbackView(
    artifact: LayoutArtifact,
    bytes: ArrayBuffer | ArrayBufferView
): LayoutReadbackView {

    if (!isLayoutArtifact(artifact)) {
        throwCodecDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            unresolvedArtifactSubject(),
            'Layout readback view requires a Scratch LayoutArtifact.',
            { layout: 'LayoutArtifact' },
            { layout: describeValue(artifact) }
        )
    }
    const source = normalizeBytes(layoutArtifactSubject(artifact), bytes)
    validateReadbackByteLength(artifact, source.byteLength)

    return new LayoutReadbackViewImpl(artifact, source)
}

class LayoutReadbackViewImpl implements LayoutReadbackView {

    readonly artifact: LayoutArtifact
    readonly bytes: Uint8Array
    readonly dataView: DataView
    readonly count: number
    readonly byteLength: number
    readonly runtimeElementCount?: number

    constructor(artifact: LayoutArtifact, bytes: Uint8Array) {

        this.artifact = artifact
        this.bytes = bytes
        this.dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.byteLength = bytes.byteLength
        if (artifact.extent === 'runtime') {
            this.count = 1
            const runtimeElementCount = layoutArtifactRuntimeElementCount(
                artifact,
                bytes.byteLength
            )
            if (runtimeElementCount !== undefined) {
                this.runtimeElementCount = runtimeElementCount
            }
        } else if (bytes.byteLength === artifact.byteLength) {
            this.count = 1
        } else {
            this.count = bytes.byteLength / artifact.stride
        }
        Object.freeze(this)
    }

    toValue(index = 0): unknown {

        validateReadbackIndex(this.artifact, this.count, index)
        const baseOffset = this.artifact.extent === 'fixed'
            ? index * this.artifact.stride
            : 0
        if (this.artifact.type.kind === 'buffer') {
            const length = this.artifact.extent === 'fixed'
                ? this.artifact.byteLength
                : this.bytes.byteLength
            return this.bytes.slice(baseOffset, baseOffset + length)
        }
        return readLayoutValue(
            this.dataView,
            baseOffset,
            this.artifact.type,
            this.runtimeElementCount
        )
    }

    toObject(index = 0): Record<string, unknown> {

        if (this.artifact.type.kind !== 'struct') {
            throwCodecDiagnostic(
                'SCRATCH_CODEC_READBACK_VIEW_UNSAFE',
                layoutArtifactSubject(this.artifact),
                'Layout readback toObject() requires a structure root type.',
                { type: 'struct' },
                { type: this.artifact.type.kind }
            )
        }
        return this.toValue(index) as Record<string, unknown>
    }

    toArray(): Record<string, unknown>[] {

        if (this.artifact.type.kind !== 'struct') {
            throwCodecDiagnostic(
                'SCRATCH_CODEC_READBACK_VIEW_UNSAFE',
                layoutArtifactSubject(this.artifact),
                'Layout readback toArray() requires a structure root type.',
                { type: 'struct' },
                { type: this.artifact.type.kind }
            )
        }
        return Array.from(
            { length: this.count },
            (_, index) => this.toObject(index)
        )
    }
}

function packedByteLength(
    codec: LayoutCodec,
    recordCount: number,
    options: LayoutRuntimeExtent | undefined
): number {

    if (codec.artifact.extent === 'runtime') {
        if (recordCount !== 1) {
            throwCodecDiagnostic(
                'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID',
                layoutArtifactSubject(codec.artifact),
                'A runtime-sized layout describes exactly one root value.',
                { values: 'one root value' },
                { recordCount }
            )
        }
        return layoutArtifactByteLength(codec.artifact, options)
    }
    if (options !== undefined) {
        return layoutArtifactByteLength(codec.artifact, options)
    }
    return recordCount === 1
        ? codec.artifact.byteLength
        : checkedProduct(codec, codec.artifact.stride, recordCount)
}

function normalizeRootValues(
    codec: LayoutCodec,
    values: LayoutValue | readonly LayoutValues[]
): unknown[] {

    if (
        codec.artifact.extent === 'fixed' &&
        codec.artifact.type.kind === 'struct' &&
        Array.isArray(values) &&
        values.length > 0 &&
        values.every(isRecord)
    ) {
        return [ ...values ]
    }
    if (
        codec.artifact.extent === 'fixed' &&
        codec.artifact.type.kind === 'struct' &&
        !isRecord(values)
    ) {
        throwValueDiagnostic(
            codec.artifact.name,
            'object or non-empty object array',
            values
        )
    }
    return [ values ]
}

function runtimeExtentFromWriteOptions(
    options: LayoutWriteOptions
): LayoutRuntimeExtent | undefined {

    return options.runtimeElementCount === undefined
        ? undefined
        : { runtimeElementCount: options.runtimeElementCount }
}

function requireRuntimeElementCount(
    artifact: LayoutArtifact,
    options: LayoutRuntimeExtent | undefined
): number {

    layoutArtifactByteLength(artifact, options)
    return options!.runtimeElementCount
}

function packOpaqueBuffer(
    codec: LayoutCodec,
    value: unknown,
    options: LayoutPackOptions | undefined
): Uint8Array {

    if (options !== undefined) {
        layoutArtifactByteLength(codec.artifact, options)
    }
    const source = normalizeBytes(codec.subject, value)
    validateOpaqueBufferBytes(codec.artifact, source.byteLength)
    const bytes = new Uint8Array(source.byteLength)
    bytes.set(source)
    return bytes
}

function writeOpaqueBuffer(
    codec: LayoutCodec,
    target: ArrayBuffer | ArrayBufferView,
    value: unknown,
    options: LayoutWriteOptions
): Uint8Array {

    if (options.runtimeElementCount !== undefined) {
        layoutArtifactByteLength(codec.artifact, {
            runtimeElementCount: options.runtimeElementCount,
        })
    }
    const source = normalizeBytes(codec.subject, value)
    validateOpaqueBufferBytes(codec.artifact, source.byteLength)
    const byteOffset = normalizeByteOffset(codec.subject, options.byteOffset)
    const bytes = createByteView(
        codec.subject,
        target,
        byteOffset,
        source.byteLength
    )
    bytes.set(source)
    return bytes
}

function validateOpaqueBufferBytes(
    artifact: LayoutArtifact,
    byteLength: number
) {

    const valid = artifact.extent === 'fixed'
        ? byteLength === artifact.byteLength
        : byteLength >= artifact.minimumBindingSize &&
            artifact.type.kind === 'buffer' &&
            byteLength % artifact.type.byteGranularity === 0
    if (!valid) {
        throwByteLengthDiagnostic(
            layoutArtifactSubject(artifact),
            artifact.extent === 'fixed'
                ? { byteLength: artifact.byteLength }
                : {
                    byteLength: `>= ${artifact.minimumBindingSize} and divisible by ${
                        artifact.type.kind === 'buffer'
                            ? artifact.type.byteGranularity
                            : 'its byte granularity'
                    }`,
                },
            { byteLength }
        )
    }
}

function writeLayoutValue(
    artifact: LayoutArtifact,
    view: DataView,
    offset: number,
    type: LayoutTypeArtifact,
    value: unknown,
    path: string,
    runtimeElementCount: number | undefined
) {

    if (type.kind === 'scalar') {
        writeScalar(view, offset, type.component, normalizeScalarValue(path, type.component, value))
        return
    }
    if (type.kind === 'atomic') {
        writeScalar(view, offset, type.component, normalizeScalarValue(path, type.component, value))
        return
    }
    if (type.kind === 'vector') {
        const values = normalizeNumberArray(path, value, type.length)
            .map((component, index) => normalizeScalarValue(
                `${path}[${index}]`,
                type.component,
                component
            ))
        const componentSize = type.component === 'f16' ? 2 : 4
        values.forEach((component, index) => {
            writeScalar(view, offset + index * componentSize, type.component, component)
        })
        return
    }
    if (type.kind === 'matrix') {
        const columns = normalizeMatrixValue(
            path,
            value,
            type.columns,
            type.rows
        ).map((column, columnIndex) => column.map(
            (component, rowIndex) => normalizeScalarValue(
                `${path}[${columnIndex}][${rowIndex}]`,
                type.component,
                component
            )
        ))
        const componentSize = type.component === 'f16' ? 2 : 4
        columns.forEach((column, columnIndex) => {
            column.forEach((component, rowIndex) => {
                writeScalar(
                    view,
                    offset + columnIndex * type.columnStride + rowIndex * componentSize,
                    type.component,
                    component
                )
            })
        })
        return
    }
    if (type.kind === 'array' || type.kind === 'runtime-array') {
        const count = type.kind === 'array'
            ? type.count
            : requireRuntimeValueCount(artifact, path, value, runtimeElementCount)
        if (!Array.isArray(value) || value.length !== count) {
            throwValueDiagnostic(path, `array length ${count}`, value)
        }
        for (let index = 0; index < count; index++) {
            writeLayoutValue(
                artifact,
                view,
                offset + index * type.elementStride,
                type.element,
                value[index],
                `${path}[${index}]`,
                undefined
            )
        }
        return
    }
    if (type.kind === 'struct') {
        if (!isRecord(value)) {
            throwValueDiagnostic(path, `object matching ${type.name}`, value)
        }
        for (const member of type.members) {
            writeLayoutValue(
                artifact,
                view,
                offset + member.offset,
                member.type,
                value[member.name],
                member.path,
                member.extent === 'runtime'
                    ? runtimeElementCount
                    : undefined
            )
        }
        return
    }
    throwValueDiagnostic(path, 'opaque buffer bytes through the root codec', value)
}

function readLayoutValue(
    view: DataView,
    offset: number,
    type: LayoutTypeArtifact,
    runtimeElementCount: number | undefined
): unknown {

    if (type.kind === 'scalar' || type.kind === 'atomic') {
        return readScalar(view, offset, type.component)
    }
    if (type.kind === 'vector') {
        const componentSize = type.component === 'f16' ? 2 : 4
        return Array.from(
            { length: type.length },
            (_, index) => readScalar(
                view,
                offset + index * componentSize,
                type.component
            )
        )
    }
    if (type.kind === 'matrix') {
        const componentSize = type.component === 'f16' ? 2 : 4
        return Array.from(
            { length: type.columns },
            (_, columnIndex) => Array.from(
                { length: type.rows },
                (_, rowIndex) => readScalar(
                    view,
                    offset + columnIndex * type.columnStride + rowIndex * componentSize,
                    type.component
                )
            )
        )
    }
    if (type.kind === 'array' || type.kind === 'runtime-array') {
        const count = type.kind === 'array'
            ? type.count
            : runtimeElementCount ?? 0
        return Array.from(
            { length: count },
            (_, index) => readLayoutValue(
                view,
                offset + index * type.elementStride,
                type.element,
                undefined
            )
        )
    }
    if (type.kind === 'struct') {
        const record: Record<string, unknown> = {}
        for (const member of type.members) {
            record[member.name] = readLayoutValue(
                view,
                offset + member.offset,
                member.type,
                member.extent === 'runtime'
                    ? runtimeElementCount
                    : undefined
            )
        }
        return record
    }
    return new Uint8Array(
        view.buffer,
        view.byteOffset + offset,
        view.byteLength - offset
    ).slice()
}

function requireRuntimeValueCount(
    artifact: LayoutArtifact,
    path: string,
    value: unknown,
    runtimeElementCount: number | undefined
): number {

    if (
        runtimeElementCount === undefined ||
        !Number.isSafeInteger(runtimeElementCount) ||
        runtimeElementCount <= 0
    ) {
        throwCodecDiagnostic(
            'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID',
            fieldSubject(path),
            'Runtime-sized layout values require one explicit positive element count.',
            { runtimeElementCount: 'positive safe integer' },
            { runtimeElementCount }
        )
    }
    if (!Array.isArray(value) || value.length !== runtimeElementCount) {
        throwCodecDiagnostic(
            'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID',
            fieldSubject(path),
            'Runtime array value length must match its explicit layout extent.',
            {
                runtimeElementCount,
                valueLength: runtimeElementCount,
            },
            {
                runtimeElementCount,
                valueLength: Array.isArray(value)
                    ? value.length
                    : describeValue(value),
                artifact: artifact.abiHash,
            }
        )
    }
    return runtimeElementCount
}

function normalizeScalarValue(
    path: string,
    type: LayoutScalarType,
    value: unknown
): number {

    if (typeof value !== 'number') {
        throwValueDiagnostic(path, type, value)
    }
    if (type === 'f32' || type === 'f16') return value
    if (!Number.isInteger(value)) {
        throwValueDiagnostic(path, `${type} integer`, value)
    }
    if (type === 'i32' && (value < -0x8000_0000 || value > 0x7fff_ffff)) {
        throwValueDiagnostic(path, 'i32 integer', value)
    }
    if (type === 'u32' && (value < 0 || value > 0xffff_ffff)) {
        throwValueDiagnostic(path, 'u32 integer', value)
    }
    return value
}

function normalizeNumberArray(
    path: string,
    value: unknown,
    length: number
): number[] {

    if (
        !Array.isArray(value) ||
        value.length !== length ||
        !value.every(component => typeof component === 'number')
    ) {
        throwValueDiagnostic(path, `number[${length}]`, value)
    }
    return value
}

function normalizeMatrixValue(
    path: string,
    value: unknown,
    columns: number,
    rows: number
): number[][] {

    if (
        Array.isArray(value) &&
        value.length === columns &&
        value.every(column =>
            Array.isArray(column) &&
            column.length === rows &&
            column.every(component => typeof component === 'number')
        )
    ) {
        return value as number[][]
    }
    if (
        Array.isArray(value) &&
        value.length === columns * rows &&
        value.every(component => typeof component === 'number')
    ) {
        return Array.from(
            { length: columns },
            (_, column) => (value as number[]).slice(
                column * rows,
                (column + 1) * rows
            )
        )
    }
    throwValueDiagnostic(
        path,
        `column-major number[${columns}][${rows}] or number[${columns * rows}]`,
        value
    )
}

function writeScalar(
    view: DataView,
    offset: number,
    type: LayoutScalarType,
    value: number
) {

    if (type === 'f16') {
        view.setUint16(offset, numberToFloat16Bits(value), true)
        return
    }
    if (type === 'f32') {
        view.setFloat32(offset, value, true)
        return
    }
    if (type === 'i32') {
        view.setInt32(offset, value, true)
        return
    }
    view.setUint32(offset, value, true)
}

function readScalar(
    view: DataView,
    offset: number,
    type: LayoutScalarType
): number {

    if (type === 'f16') {
        return float16BitsToNumber(view.getUint16(offset, true))
    }
    if (type === 'f32') return view.getFloat32(offset, true)
    if (type === 'i32') return view.getInt32(offset, true)
    return view.getUint32(offset, true)
}

function numberToFloat16Bits(value: number): number {

    const bits = float64Bits(value)
    const sign = Number((bits >> 48n) & 0x8000n)
    const exponentBits = Number((bits >> 52n) & 0x7ffn)
    const fraction = bits & 0x000f_ffff_ffff_ffffn

    if (exponentBits === 0x7ff) {
        return sign | (fraction === 0n ? 0x7c00 : 0x7e00)
    }
    if (exponentBits === 0 && fraction === 0n) return sign

    const exponent = exponentBits === 0
        ? -1022
        : exponentBits - 1023
    const significand = exponentBits === 0
        ? fraction
        : (1n << 52n) | fraction

    if (exponent >= -14) {
        let halfExponent = exponent + 15
        let rounded = roundEvenRightShift(significand, 42)
        if (rounded === 0x800n) {
            rounded = 0x400n
            halfExponent++
        }
        if (halfExponent >= 31) return sign | 0x7c00
        return sign |
            (halfExponent << 10) |
            Number(rounded & 0x3ffn)
    }

    const shift = 28 - exponent
    if (shift > 1075) return sign
    const rounded = roundEvenRightShift(significand, shift)
    if (rounded >= 0x400n) return sign | 0x0400
    return sign | Number(rounded)
}

function float16BitsToNumber(bits: number): number {

    const sign = (bits & 0x8000) === 0 ? 1 : -1
    const exponent = (bits >>> 10) & 0x1f
    const fraction = bits & 0x03ff
    if (exponent === 0) {
        return fraction === 0
            ? sign < 0 ? -0 : 0
            : sign * fraction * 2 ** -24
    }
    if (exponent === 0x1f) {
        return fraction === 0 ? sign * Infinity : NaN
    }
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

function float64Bits(value: number): bigint {

    float64BitScratch.setFloat64(0, value, false)
    return float64BitScratch.getBigUint64(0, false)
}

function roundEvenRightShift(value: bigint, shift: number): bigint {

    if (shift <= 0) return value << BigInt(-shift)
    const shiftBits = BigInt(shift)
    const quotient = value >> shiftBits
    const remainderMask = (1n << shiftBits) - 1n
    const remainder = value & remainderMask
    const halfway = 1n << (shiftBits - 1n)
    return remainder > halfway ||
        (remainder === halfway && (quotient & 1n) === 1n)
        ? quotient + 1n
        : quotient
}

function generateWgslAccessors(
    artifact: LayoutArtifact,
    namespace: string
): string {

    const lines: string[] = []
    const structs = collectStructArtifacts(artifact.type)
    structs.forEach((type, index) => {
        lines.push(renderStruct(type))
        if (index < structs.length - 1) lines.push('')
    })
    if (structs.length > 0) lines.push('')

    if (artifact.extent === 'fixed') {
        lines.push(`const ${namespace}_BYTE_LENGTH: u32 = ${artifact.byteLength}u;`)
        lines.push(`const ${namespace}_STRIDE: u32 = ${artifact.stride}u;`)
    } else {
        lines.push(
            `const ${namespace}_FIXED_PREFIX_BYTE_LENGTH: u32 = ${
                artifact.fixedPrefixByteLength
            }u;`
        )
        lines.push(
            `const ${namespace}_MINIMUM_BINDING_SIZE: u32 = ${
                artifact.minimumBindingSize
            }u;`
        )
    }
    if (artifact.alignment !== null) {
        lines.push(`const ${namespace}_ALIGNMENT: u32 = ${artifact.alignment}u;`)
    }

    for (const field of artifact.fields) {
        const constantName = `${namespace}_${constantSegment(field.name)}`
        lines.push(`const ${constantName}_OFFSET: u32 = ${field.offset}u;`)
        if (field.byteLength !== undefined) {
            lines.push(`const ${constantName}_SIZE: u32 = ${field.byteLength}u;`)
        }
        if (
            field.type.kind === 'array' ||
            field.type.kind === 'runtime-array'
        ) {
            lines.push(
                `const ${constantName}_STRIDE: u32 = ${field.type.elementStride}u;`
            )
        }
    }

    const accessorLines = generateRootAccessors(artifact, namespace)
    if (accessorLines.length > 0) {
        lines.push('')
        lines.push(...accessorLines)
    }
    return lines.join('\n')
}

function collectStructArtifacts(
    root: LayoutTypeArtifact
): Array<Extract<LayoutTypeArtifact, { kind: 'struct' }>> {

    const result: Array<Extract<LayoutTypeArtifact, { kind: 'struct' }>> = []
    const seen = new Set<string>()

    const visit = (type: LayoutTypeArtifact) => {
        if (type.kind === 'array' || type.kind === 'runtime-array') {
            visit(type.element)
            return
        }
        if (type.kind !== 'struct') return
        for (const member of type.members) visit(member.type)
        if (!seen.has(type.name)) {
            seen.add(type.name)
            result.push(type)
        }
    }
    visit(root)
    return result
}

function renderStruct(
    type: Extract<LayoutTypeArtifact, { kind: 'struct' }>
): string {

    const lines = [ `struct ${type.name} {` ]
    for (const member of type.members) {
        const attributes = [
            member.explicitAlign === undefined
                ? undefined
                : `@align(${member.explicitAlign})`,
            member.explicitSize === undefined
                ? undefined
                : `@size(${member.explicitSize})`,
        ].filter((attribute): attribute is string => attribute !== undefined)
        const prefix = attributes.length === 0
            ? ''
            : `${attributes.join(' ')} `
        lines.push(`    ${prefix}${member.name}: ${member.wgslType},`)
    }
    lines.push('}')
    return lines.join('\n')
}

function generateRootAccessors(
    artifact: LayoutArtifact,
    namespace: string
): string[] {

    if (artifact.type.kind !== 'struct') return []
    const lines: string[] = []
    const root = artifact.type
    for (const member of root.members) {
        if (member.type.kind === 'runtime-array') {
            const suffix = pascalName(member.name)
            const access = member.type.containsAtomic ? 'read_write' : 'read'
            lines.push(
                `fn ${namespace}_length${suffix}(value: ptr<storage, ${root.name}, ${access}>) -> u32 {`
            )
            lines.push(`    return arrayLength(&(*value).${member.name});`)
            lines.push('}')
        }
        if (member.type.containsAtomic) {
            generateAtomicAccessors(
                lines,
                namespace,
                root.name,
                member.type,
                `(*value).${member.name}`,
                [ member.name ],
                []
            )
            continue
        }
        if (member.type.kind === 'runtime-array') {
            const suffix = pascalName(member.name)
            const elementType = member.type.element.wgslType
            if (member.type.element.constructible) {
                lines.push(
                    `fn ${namespace}_read${suffix}(value: ptr<storage, ${
                        root.name
                    }, read>, index: u32) -> ${elementType} {`
                )
                lines.push(`    return (*value).${member.name}[index];`)
                lines.push('}')
            }
            continue
        }
        if (artifact.extent === 'fixed' && root.constructible) {
            lines.push(
                `fn ${namespace}_read${pascalName(member.name)}(value: ${
                    root.name
                }) -> ${member.wgslType} {`
            )
            lines.push(`    return value.${member.name};`)
            lines.push('}')
        } else if (member.type.constructible) {
            const access = root.containsAtomic ? 'read_write' : 'read'
            lines.push(
                `fn ${namespace}_read${pascalName(member.name)}(value: ptr<storage, ${
                    root.name
                }, ${access}>) -> ${member.wgslType} {`
            )
            lines.push(`    return (*value).${member.name};`)
            lines.push('}')
        }
    }
    return lines
}

function generateAtomicAccessors(
    lines: string[],
    namespace: string,
    rootName: string,
    type: LayoutTypeArtifact,
    expression: string,
    memberPath: string[],
    indexes: string[]
) {

    if (type.kind === 'atomic') {
        const suffix = pascalName(memberPath.join('_'))
        const parameters = indexes.map(index => `${index}: u32`)
        const parameterSuffix = parameters.length === 0
            ? ''
            : `, ${parameters.join(', ')}`
        lines.push(
            `fn ${namespace}_load${suffix}(value: ptr<storage, ${
                rootName
            }, read_write>${parameterSuffix}) -> ${type.component} {`
        )
        lines.push(`    return atomicLoad(&${expression});`)
        lines.push('}')
        lines.push(
            `fn ${namespace}_store${suffix}(value: ptr<storage, ${
                rootName
            }, read_write>${parameterSuffix}, next: ${type.component}) {`
        )
        lines.push(`    atomicStore(&${expression}, next);`)
        lines.push('}')
        return
    }
    if (type.kind === 'array' || type.kind === 'runtime-array') {
        const indexName = `index${indexes.length}`
        generateAtomicAccessors(
            lines,
            namespace,
            rootName,
            type.element,
            `${expression}[${indexName}]`,
            memberPath,
            [ ...indexes, indexName ]
        )
        return
    }
    if (type.kind === 'struct') {
        for (const member of type.members) {
            if (!member.type.containsAtomic) continue
            generateAtomicAccessors(
                lines,
                namespace,
                rootName,
                member.type,
                `${expression}.${member.name}`,
                [ ...memberPath, member.name ],
                indexes
            )
        }
    }
}

function generateBufferViewConstants(
    contract: LayoutBufferViewContract,
    namespace: string
): string {

    const lines = [
        `const ${namespace}_REQUIRED_ALIGNMENT: u32 = ${contract.requiredAlignment}u;`,
        `const ${namespace}_MINIMUM_TYPE_SIZE: u32 = ${contract.minimumTypeSize}u;`,
    ]
    if (contract.byteOffset !== undefined) {
        lines.push(`const ${namespace}_BYTE_OFFSET: u32 = ${contract.byteOffset}u;`)
    }
    if (contract.byteLength !== undefined) {
        lines.push(`const ${namespace}_BYTE_LENGTH: u32 = ${contract.byteLength}u;`)
    }
    if (contract.arrayOffset !== undefined) {
        lines.push(`const ${namespace}_ARRAY_OFFSET: u32 = ${contract.arrayOffset}u;`)
    }
    if (contract.arrayStride !== undefined) {
        lines.push(`const ${namespace}_ARRAY_STRIDE: u32 = ${contract.arrayStride}u;`)
    }
    if (contract.staticBufferByteLength !== undefined) {
        lines.push(
            `const ${namespace}_STATIC_BUFFER_LENGTH: u32 = ${
                contract.staticBufferByteLength
            }u;`
        )
    }
    return lines.join('\n')
}

function validateReadbackByteLength(
    artifact: LayoutArtifact,
    byteLength: number
) {

    let valid = false
    let expected: unknown
    if (artifact.extent === 'runtime') {
        valid = layoutArtifactAcceptsViewByteLength(artifact, byteLength)
        expected = artifact.type.kind === 'buffer'
            ? `>= ${artifact.minimumBindingSize} with valid buffer granularity`
            : `>= ${artifact.minimumBindingSize}`
    } else {
        valid = byteLength === artifact.byteLength ||
            (
                byteLength >= artifact.stride &&
                byteLength % artifact.stride === 0
            )
        expected = artifact.byteLength === artifact.stride
            ? `positive multiple of ${artifact.stride}`
            : `${artifact.byteLength} or a positive multiple of ${artifact.stride}`
    }
    if (!valid) {
        throwByteLengthDiagnostic(
            layoutArtifactSubject(artifact),
            { byteLength: expected },
            { byteLength }
        )
    }
}

function validateReadbackIndex(
    artifact: LayoutArtifact,
    count: number,
    index: unknown
) {

    if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= count
    ) {
        throwCodecDiagnostic(
            'SCRATCH_CODEC_READBACK_VIEW_UNSAFE',
            layoutArtifactSubject(artifact),
            'LayoutCodec readback index is outside the view.',
            { index: `integer in [0, ${count})` },
            { index }
        )
    }
}

function normalizeByteOffset(
    subject: DiagnosticSubject,
    byteOffset: unknown
): number {

    const normalized = byteOffset ?? 0
    if (
        typeof normalized !== 'number' ||
        !Number.isSafeInteger(normalized) ||
        normalized < 0
    ) {
        throwByteLengthDiagnostic(
            subject,
            { byteOffset: 'non-negative safe integer' },
            { byteOffset }
        )
    }
    return normalized
}

function createByteView(
    subject: DiagnosticSubject,
    target: ArrayBuffer | ArrayBufferView,
    byteOffset: number,
    byteLength: number
): Uint8Array {

    if (target instanceof ArrayBuffer) {
        if (byteOffset + byteLength <= target.byteLength) {
            return new Uint8Array(target, byteOffset, byteLength)
        }
    } else if (ArrayBuffer.isView(target)) {
        if (byteOffset + byteLength <= target.byteLength) {
            return new Uint8Array(
                target.buffer,
                target.byteOffset + byteOffset,
                byteLength
            )
        }
    } else {
        throwByteLengthDiagnostic(
            subject,
            { target: 'ArrayBuffer or ArrayBufferView' },
            { target: describeValue(target) }
        )
    }
    throwByteLengthDiagnostic(
        subject,
        { byteOffset, byteLength, range: 'within target storage' },
        {
            byteOffset,
            byteLength,
            targetByteLength: ArrayBuffer.isView(target)
                ? target.byteLength
                : target.byteLength,
        }
    )
}

function normalizeBytes(
    subject: DiagnosticSubject,
    bytes: unknown
): Uint8Array {

    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
    if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    throwByteLengthDiagnostic(
        subject,
        { bytes: 'ArrayBuffer or ArrayBufferView' },
        { bytes: describeValue(bytes) }
    )
}

function normalizeNamespace(
    subject: DiagnosticSubject,
    namespace: unknown,
    fallback: string
): string {

    if (namespace === undefined) return fallback
    if (typeof namespace === 'string' && isIdentifier(namespace)) return namespace
    throwCodecDiagnostic(
        'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
        subject,
        'LayoutCodec WGSL namespace must be a WGSL identifier.',
        { namespace: 'WGSL identifier string' },
        { namespace }
    )
}

function checkedProduct(
    codec: LayoutCodec,
    left: number,
    right: number
): number {

    const result = left * right
    if (
        !Number.isSafeInteger(result) ||
        result <= 0 ||
        result > 0xffff_ffff
    ) {
        throwByteLengthDiagnostic(
            codec.subject,
            { byteLength: 'positive safe integer <= WGSL u32 max' },
            { left, right, byteLength: result }
        )
    }
    return result
}

function throwValueDiagnostic(
    path: string,
    expected: unknown,
    value: unknown
): never {

    throwCodecDiagnostic(
        'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
        fieldSubject(path),
        'LayoutCodec value does not match its recursive layout type.',
        { value: expected },
        {
            value: Array.isArray(value)
                ? value.map(describeValue)
                : describeValue(value),
        }
    )
}

function throwByteLengthDiagnostic(
    subject: DiagnosticSubject,
    expected: unknown,
    actual: unknown
): never {

    throwCodecDiagnostic(
        'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
        subject,
        'LayoutCodec byte range does not match its LayoutArtifact.',
        expected,
        actual
    )
}

function throwCodecDiagnostic(
    code: string,
    subject: DiagnosticSubject,
    message: string,
    expected: unknown,
    actual: unknown
): never {

    throwScratchDiagnostic({
        code,
        severity: 'error',
        phase: 'layout-codec',
        subject,
        message,
        expected,
        actual,
    })
}

function fieldSubject(path: string): DiagnosticSubject {

    return {
        kind: 'LayoutField',
        path,
        label: path,
    }
}

function unresolvedArtifactSubject(): DiagnosticSubject {

    return {
        kind: 'LayoutArtifact',
        hash: 'unresolved',
    }
}

function isIdentifier(value: string): boolean {

    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function pascalName(value: string): string {

    return value
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map(segment => segment[0].toUpperCase() + segment.slice(1))
        .join('')
}

function constantSegment(value: string): string {

    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toUpperCase()
}
