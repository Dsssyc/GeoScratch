import { createScratchDiagnosticReport, throwScratchDiagnostic } from './diagnostics.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject, ScratchDiagnosticReport } from './diagnostics.js'

export type LayoutScalarType = 'f32' | 'i32' | 'u32'

export type LayoutVectorType =
    | 'vec2f'
    | 'vec3f'
    | 'vec4f'
    | 'vec2i'
    | 'vec3i'
    | 'vec4i'
    | 'vec2u'
    | 'vec3u'
    | 'vec4u'

export type LayoutMatrixType = 'mat4x4f'

export type LayoutPrimitiveType = LayoutScalarType | LayoutVectorType | LayoutMatrixType

export type LayoutArrayTypeDescriptor = {
    element: LayoutPrimitiveType
    count: number
}

export type LayoutFieldType = LayoutPrimitiveType | LayoutArrayTypeDescriptor

export type LayoutFieldDescriptor = {
    name: string
    type: LayoutFieldType
}

export type LayoutSpec = {
    label?: string
    name: string
    fields: LayoutFieldDescriptor[]
}

export type LayoutCodecUsage = 'uniform' | 'storage' | 'readback' | 'vertex'

export type LayoutUsageCompatibility = Record<LayoutCodecUsage, boolean>

export type LayoutCodecOptions = {
    usage?: LayoutCodecUsage[]
}

export type LayoutFieldArtifact = Readonly<{
    kind: 'LayoutField'
    name: string
    path: string
    type: string
    wgslType: string
    offset: number
    size: number
    alignment: number
    padding: number
    componentType?: LayoutScalarType
    componentCount?: number
    arrayLength?: number
    arrayStride?: number
    elementType?: string
    elementSize?: number
    elementAlignment?: number
}>

export type LayoutArtifact = Readonly<{
    kind: 'LayoutArtifact'
    name: string
    label?: string
    alignmentMode: 'host-shareable'
    alignment: number
    byteLength: number
    stride: number
    fields: readonly LayoutFieldArtifact[]
    abiHash: string
    schemaHash: string
    usages: readonly LayoutCodecUsage[]
    usageCompatibility: Readonly<LayoutUsageCompatibility>
}>

export type LayoutCompatibilityDifference = Readonly<{
    path: string
    expected: unknown
    actual: unknown
}>

export type LayoutUploadView = {
    bytes: Uint8Array
    byteOffset: number
    byteLength: number
    artifact: LayoutArtifact
}

export type LayoutReadbackView = {
    artifact: LayoutArtifact
    bytes: Uint8Array
    dataView: DataView
    count: number
    byteLength: number
    toObject(index?: number): Record<string, unknown>
    toArray(): Record<string, unknown>[]
}

export type LayoutWriteOptions = {
    byteOffset?: number
}

type PrimitiveDefinition = {
    type: LayoutPrimitiveType
    wgslType: string
    alignment: number
    size: number
    componentType: LayoutScalarType
    componentCount: number
}

type LoweredFieldType = {
    type: string
    wgslType: string
    alignment: number
    size: number
    componentType?: LayoutScalarType
    componentCount?: number
    arrayLength?: number
    arrayStride?: number
    element?: LoweredPrimitiveFieldType
}

type LoweredPrimitiveFieldType = LoweredFieldType & {
    primitive: PrimitiveDefinition
    componentType: LayoutScalarType
    componentCount: number
}

type LayoutValues = Record<string, unknown>

// Source: https://www.w3.org/TR/WGSL/#alignment-and-size
const PRIMITIVE_DEFINITIONS: Record<LayoutPrimitiveType, PrimitiveDefinition> = {
    f32: { type: 'f32', wgslType: 'f32', alignment: 4, size: 4, componentType: 'f32', componentCount: 1 },
    i32: { type: 'i32', wgslType: 'i32', alignment: 4, size: 4, componentType: 'i32', componentCount: 1 },
    u32: { type: 'u32', wgslType: 'u32', alignment: 4, size: 4, componentType: 'u32', componentCount: 1 },
    vec2f: { type: 'vec2f', wgslType: 'vec2f', alignment: 8, size: 8, componentType: 'f32', componentCount: 2 },
    vec3f: { type: 'vec3f', wgslType: 'vec3f', alignment: 16, size: 12, componentType: 'f32', componentCount: 3 },
    vec4f: { type: 'vec4f', wgslType: 'vec4f', alignment: 16, size: 16, componentType: 'f32', componentCount: 4 },
    vec2i: { type: 'vec2i', wgslType: 'vec2i', alignment: 8, size: 8, componentType: 'i32', componentCount: 2 },
    vec3i: { type: 'vec3i', wgslType: 'vec3i', alignment: 16, size: 12, componentType: 'i32', componentCount: 3 },
    vec4i: { type: 'vec4i', wgslType: 'vec4i', alignment: 16, size: 16, componentType: 'i32', componentCount: 4 },
    vec2u: { type: 'vec2u', wgslType: 'vec2u', alignment: 8, size: 8, componentType: 'u32', componentCount: 2 },
    vec3u: { type: 'vec3u', wgslType: 'vec3u', alignment: 16, size: 12, componentType: 'u32', componentCount: 3 },
    vec4u: { type: 'vec4u', wgslType: 'vec4u', alignment: 16, size: 16, componentType: 'u32', componentCount: 4 },
    mat4x4f: { type: 'mat4x4f', wgslType: 'mat4x4f', alignment: 16, size: 64, componentType: 'f32', componentCount: 16 },
}

const DEFAULT_USAGES: LayoutCodecUsage[] = [ 'storage', 'readback' ]
const layoutCanonicalSignatures = new WeakMap<LayoutArtifact, Readonly<{
    abi: string
    schema: string
}>>()

export interface LayoutCodec {
    spec: LayoutSpec
    artifact: LayoutArtifact
    report: ScratchDiagnosticReport
}

export class LayoutCodec {

    constructor(spec: LayoutSpec, options: LayoutCodecOptions = {}) {

        this.spec = normalizeSpec(spec)
        this.artifact = lowerLayoutArtifact(this.spec, options)
        this.report = createScratchDiagnosticReport()
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'LayoutArtifact',
            abiHash: this.artifact.abiHash,
            schemaHash: this.artifact.schemaHash,
        }
        subject.label = this.artifact.label ?? this.artifact.name

        return subject
    }

    pack(values: LayoutValues | LayoutValues[]): Uint8Array {

        const records = normalizeRecords(this, values)
        const target = new ArrayBuffer(records.length * this.artifact.stride)

        return this.write(target, records)
    }

    write(
        target: ArrayBuffer | ArrayBufferView,
        values: LayoutValues | LayoutValues[],
        options: LayoutWriteOptions = {}
    ): Uint8Array {

        const records = normalizeRecords(this, values)
        const byteLength = records.length * this.artifact.stride
        const byteOffset = normalizeByteOffset(this, options.byteOffset)
        const bytes = createByteView(this, target, byteOffset, byteLength)
        const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

        bytes.fill(0)

        records.forEach((record, recordIndex) => {
            const baseOffset = recordIndex * this.artifact.stride
            for (const field of this.artifact.fields) {
                writeFieldValue(this, dataView, baseOffset + field.offset, field, record[field.name])
            }
        })

        return bytes
    }

    uploadView(values: LayoutValues | LayoutValues[]): LayoutUploadView {

        const bytes = this.pack(values)

        return {
            bytes,
            byteOffset: bytes.byteOffset,
            byteLength: bytes.byteLength,
            artifact: this.artifact,
        }
    }

    createReadbackView(bytes: ArrayBuffer | ArrayBufferView): LayoutReadbackView {

        return createLayoutReadbackView(this.artifact, bytes)
    }

    wgslAccessors(options: { namespace?: string } = {}): string {

        const namespace = normalizeNamespace(this, options.namespace)
        const lines = [
            `struct ${this.artifact.name} {`,
            ...this.artifact.fields.map(field => `    ${field.name}: ${field.wgslType},`),
            `}`,
            ``,
            `const ${namespace}_BYTE_LENGTH: u32 = ${this.artifact.byteLength}u;`,
            `const ${namespace}_ALIGNMENT: u32 = ${this.artifact.alignment}u;`,
        ]

        for (const field of this.artifact.fields) {
            const constantName = `${namespace}_${constantSegment(field.name)}`
            lines.push(`const ${constantName}_OFFSET: u32 = ${field.offset}u;`)
            lines.push(`const ${constantName}_SIZE: u32 = ${field.size}u;`)
            lines.push(`fn ${namespace}_read${pascalName(field.name)}(value: ${this.artifact.name}) -> ${field.wgslType} {`)
            lines.push(`    return value.${field.name};`)
            lines.push(`}`)
        }

        return lines.join('\n')
    }
}

export function layoutCodec(spec: LayoutSpec, options?: LayoutCodecOptions): LayoutCodec {

    return new LayoutCodec(spec, options)
}

export function createLayoutReadbackView(
    artifact: LayoutArtifact,
    bytes: ArrayBuffer | ArrayBufferView
): LayoutReadbackView {

    if (!isLayoutArtifact(artifact)) {
        throwUnsupportedFormat({
            kind: 'LayoutArtifact',
            hash: 'unresolved',
        }, {
            expected: { layout: 'LayoutArtifact' },
            actual: { layout: describeValue(artifact) },
            message: 'Layout readback view requires a LayoutArtifact.',
        })
    }

    const subject = layoutArtifactSubject(artifact)
    const source = normalizeBytes(subject, bytes)

    if (source.byteLength === 0 || source.byteLength % artifact.stride !== 0) {
        throwByteLengthDiagnostic(subject, {
            expected: { byteLength: `positive multiple of ${artifact.stride}` },
            actual: { byteLength: source.byteLength },
        })
    }

    return new LayoutReadbackViewImpl(artifact, source)
}

export function isLayoutArtifact(value: unknown): value is LayoutArtifact {

    return isRecord(value) &&
        layoutCanonicalSignatures.has(value as LayoutArtifact) &&
        value.kind === 'LayoutArtifact' &&
        typeof value.name === 'string' &&
        value.alignmentMode === 'host-shareable' &&
        isPositiveSafeInteger(value.alignment) &&
        isPositiveSafeInteger(value.byteLength) &&
        isPositiveSafeInteger(value.stride) &&
        Array.isArray(value.fields) &&
        typeof value.abiHash === 'string' &&
        typeof value.schemaHash === 'string' &&
        Array.isArray(value.usages) &&
        isRecord(value.usageCompatibility)
}

export function layoutArtifactsAbiCompatible(left: LayoutArtifact, right: LayoutArtifact): boolean {

    const leftSignatures = layoutCanonicalSignatures.get(left)
    const rightSignatures = layoutCanonicalSignatures.get(right)
    return leftSignatures !== undefined &&
        rightSignatures !== undefined &&
        left.abiHash === right.abiHash &&
        leftSignatures.abi === rightSignatures.abi
}

export function layoutArtifactsSchemaCompatible(left: LayoutArtifact, right: LayoutArtifact): boolean {

    const leftSignatures = layoutCanonicalSignatures.get(left)
    const rightSignatures = layoutCanonicalSignatures.get(right)
    return leftSignatures !== undefined &&
        rightSignatures !== undefined &&
        left.schemaHash === right.schemaHash &&
        leftSignatures.schema === rightSignatures.schema
}

export function describeLayoutCompatibilityDifference(
    expected: LayoutArtifact,
    actual: LayoutArtifact,
    kind: 'abi' | 'schema'
): LayoutCompatibilityDifference | undefined {

    const expectedSignature = layoutCanonicalSignatures.get(expected)?.[kind]
    const actualSignature = layoutCanonicalSignatures.get(actual)?.[kind]
    if (expectedSignature === undefined || actualSignature === undefined) {
        return Object.freeze({
            path: kind,
            expected: expectedSignature === undefined ? 'registered LayoutArtifact' : 'available',
            actual: actualSignature === undefined ? 'unregistered LayoutArtifact' : 'available',
        })
    }
    if (expectedSignature === actualSignature) return undefined

    return Object.freeze(firstCanonicalDifference(
        JSON.parse(expectedSignature) as unknown,
        JSON.parse(actualSignature) as unknown,
        kind
    ))
}

export function isLayoutUploadView(value: unknown): value is LayoutUploadView {

    return isRecord(value) &&
        value.bytes instanceof Uint8Array &&
        typeof value.byteOffset === 'number' &&
        typeof value.byteLength === 'number' &&
        isLayoutArtifact(value.artifact)
}

export function layoutArtifactSubject(artifact: LayoutArtifact): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'LayoutArtifact',
        abiHash: artifact.abiHash,
        schemaHash: artifact.schemaHash,
    }
    subject.label = artifact.label ?? artifact.name

    return subject
}

class LayoutReadbackViewImpl implements LayoutReadbackView {

    artifact: LayoutArtifact
    bytes: Uint8Array
    dataView: DataView
    count: number
    byteLength: number

    constructor(artifact: LayoutArtifact, bytes: Uint8Array) {

        this.artifact = artifact
        this.bytes = bytes
        this.dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.count = bytes.byteLength / artifact.stride
        this.byteLength = bytes.byteLength
    }

    toObject(index = 0): Record<string, unknown> {

        if (!Number.isInteger(index) || index < 0 || index >= this.count) {
            throwScratchDiagnostic({
                code: 'SCRATCH_CODEC_READBACK_VIEW_UNSAFE',
                severity: 'error',
                phase: 'layout-codec',
                subject: layoutArtifactSubject(this.artifact),
                message: 'LayoutCodec readback index is outside the view.',
                expected: { index: `integer in [0, ${this.count})` },
                actual: { index },
            })
        }

        const record: Record<string, unknown> = {}
        const baseOffset = index * this.artifact.stride

        for (const field of this.artifact.fields) {
            record[field.name] = readFieldValue(this.artifact, this.dataView, baseOffset + field.offset, field)
        }

        return record
    }

    toArray(): Record<string, unknown>[] {

        return Array.from({ length: this.count }, (_, index) => this.toObject(index))
    }
}

function normalizeSpec(spec: unknown): LayoutSpec {

    if (!isRecord(spec)) {
        throwUnsupportedFormat({
            kind: 'LayoutArtifact',
            hash: 'unresolved',
        }, {
            expected: { spec: 'LayoutSpec' },
            actual: { spec: describeValue(spec) },
            message: 'LayoutCodec requires a LayoutSpec object.',
        })
    }

    const name = spec.name
    if (typeof name !== 'string' || !isIdentifier(name)) {
        throwUnsupportedFormat({
            kind: 'LayoutArtifact',
            hash: 'unresolved',
        }, {
            expected: { name: 'WGSL identifier string' },
            actual: { name },
            message: 'LayoutSpec name must be a WGSL identifier.',
        })
    }

    const label = spec.label
    if (label !== undefined && typeof label !== 'string') {
        throwUnsupportedFormat({
            kind: 'LayoutArtifact',
            hash: 'unresolved',
        }, {
            expected: { label: 'string' },
            actual: { label: describeValue(label) },
            message: 'LayoutSpec label must be a string.',
        })
    }

    const fields = spec.fields
    if (!Array.isArray(fields) || fields.length === 0) {
        throwUnsupportedFormat(unresolvedArtifactSubject(label), {
            expected: { fields: 'non-empty LayoutFieldDescriptor[]' },
            actual: { fields: Array.isArray(fields) ? fields.length : describeValue(fields) },
            message: 'LayoutSpec requires at least one field.',
        })
    }

    const names = new Set<string>()
    const normalizedFields = fields.map((field, index) => normalizeFieldDescriptor(field, index, names))
    const normalized: LayoutSpec = { name, fields: normalizedFields }
    if (label !== undefined) normalized.label = label

    return normalized
}

function normalizeFieldDescriptor(field: unknown, index: number, names: Set<string>): LayoutFieldDescriptor {

    if (!isRecord(field)) {
        throwUnsupportedFormat({
            kind: 'LayoutField',
            path: String(index),
        }, {
            expected: { field: 'LayoutFieldDescriptor' },
            actual: { field: describeValue(field) },
            message: 'Layout field descriptor must be an object.',
        })
    }

    const name = field.name
    if (typeof name !== 'string' || !isIdentifier(name)) {
        throwUnsupportedFormat({
            kind: 'LayoutField',
            path: String(index),
        }, {
            expected: { name: 'WGSL identifier string' },
            actual: { name },
            message: 'Layout field name must be a WGSL identifier.',
        })
    }

    if (names.has(name)) {
        throwUnsupportedFormat({
            kind: 'LayoutField',
            path: name,
            label: name,
        }, {
            expected: { name: 'unique field name' },
            actual: { name },
            message: 'Layout field names must be unique.',
        })
    }
    names.add(name)

    return {
        name,
        type: normalizeFieldTypeDescriptor(name, field.type),
    }
}

function normalizeFieldTypeDescriptor(path: string, type: unknown): LayoutFieldType {

    if (typeof type === 'string') {
        if (isPrimitiveType(type)) return type
        throwUnsupportedFormat(fieldSubject(path), {
            expected: { type: Object.keys(PRIMITIVE_DEFINITIONS) },
            actual: { type },
            message: 'Layout field type is not supported.',
        })
    }

    if (isRecord(type)) {
        const element = type.element
        const count = type.count

        if (typeof element !== 'string' || !isPrimitiveType(element)) {
            throwUnsupportedFormat(fieldSubject(path), {
                expected: { element: Object.keys(PRIMITIVE_DEFINITIONS) },
                actual: { element },
                message: 'Layout array element type is not supported.',
            })
        }

        if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
            throwUnsupportedFormat(fieldSubject(path), {
                expected: { count: 'positive integer' },
                actual: { count },
                message: 'Layout array count must be a positive integer.',
            })
        }

        return { element, count }
    }

    throwUnsupportedFormat(fieldSubject(path), {
        expected: { type: 'LayoutPrimitiveType or LayoutArrayTypeDescriptor' },
        actual: { type: describeValue(type) },
        message: 'Layout field type is not supported.',
    })
}

function lowerLayoutArtifact(spec: LayoutSpec, options: LayoutCodecOptions): LayoutArtifact {

    const usages = normalizeUsages(spec, options.usage)
    const lowered = spec.fields.map((field) => {
        const type = lowerFieldType(field.name, field.type)
        return {
            descriptor: field,
            type,
            offset: 0,
        }
    })

    let cursor = 0
    let alignment = 1

    for (const field of lowered) {
        alignment = Math.max(alignment, field.type.alignment)
        field.offset = roundUp(field.type.alignment, cursor)
        cursor = field.offset + field.type.size
    }

    const byteLength = roundUp(alignment, cursor)
    const fields: LayoutFieldArtifact[] = lowered.map((field, index) => {
        const nextOffset = lowered[index + 1]?.offset ?? byteLength
        return {
            kind: 'LayoutField',
            name: field.descriptor.name,
            path: field.descriptor.name,
            type: field.type.type,
            wgslType: field.type.wgslType,
            offset: field.offset,
            size: field.type.size,
            alignment: field.type.alignment,
            padding: nextOffset - (field.offset + field.type.size),
            ...(field.type.element === undefined && field.type.componentType !== undefined
                ? { componentType: field.type.componentType }
                : {}),
            ...(field.type.element === undefined && field.type.componentCount !== undefined
                ? { componentCount: field.type.componentCount }
                : {}),
            ...(field.type.arrayLength !== undefined ? { arrayLength: field.type.arrayLength } : {}),
            ...(field.type.arrayStride !== undefined ? { arrayStride: field.type.arrayStride } : {}),
            ...(field.type.element !== undefined ? {
                elementType: field.type.element.type,
                elementSize: field.type.element.size,
                elementAlignment: field.type.element.alignment,
                ...(field.type.element.componentType !== undefined
                    ? { componentType: field.type.element.componentType }
                    : {}),
                ...(field.type.element.componentCount !== undefined
                    ? { componentCount: field.type.element.componentCount }
                    : {}),
            } : {}),
        }
    })
    const usageCompatibility = computeUsageCompatibility(fields)

    const abiCanonical = {
        alignmentMode: 'host-shareable',
        alignment,
        byteLength,
        stride: byteLength,
        fields: fields.map(field => ({
            type: field.type,
            offset: field.offset,
            size: field.size,
            alignment: field.alignment,
            padding: field.padding,
            componentType: field.componentType,
            componentCount: field.componentCount,
            arrayLength: field.arrayLength,
            arrayStride: field.arrayStride,
            elementType: field.elementType,
            elementSize: field.elementSize,
            elementAlignment: field.elementAlignment,
        })),
    }
    const schemaCanonical = {
        name: spec.name,
        fields: fields.map(field => ({
            name: field.name,
            type: field.type,
            componentType: field.componentType,
            componentCount: field.componentCount,
            arrayLength: field.arrayLength,
            arrayStride: field.arrayStride,
            elementType: field.elementType,
        })),
    }
    const abiSignature = JSON.stringify(abiCanonical)
    const schemaSignature = JSON.stringify(schemaCanonical)
    const artifact: LayoutArtifact = {
        kind: 'LayoutArtifact',
        name: spec.name,
        ...(spec.label !== undefined ? { label: spec.label } : {}),
        alignmentMode: 'host-shareable',
        alignment,
        byteLength,
        stride: byteLength,
        fields,
        abiHash: `layout-abi-${fnv1a64(abiSignature)}`,
        schemaHash: `layout-schema-${fnv1a64(schemaSignature)}`,
        usages,
        usageCompatibility,
    }

    layoutCanonicalSignatures.set(artifact, Object.freeze({
        abi: abiSignature,
        schema: schemaSignature,
    }))
    return freezeLayoutArtifact(artifact)
}

function lowerFieldType(path: string, type: LayoutFieldType): LoweredFieldType {

    if (typeof type === 'string') {
        return lowerPrimitiveFieldType(path, type)
    }

    const element = lowerPrimitiveFieldType(path, type.element)
    const arrayStride = roundUp(element.alignment, element.size)

    return {
        type: `array<${element.type}, ${type.count}>`,
        wgslType: `array<${element.wgslType}, ${type.count}>`,
        alignment: element.alignment,
        size: arrayStride * type.count,
        arrayLength: type.count,
        arrayStride,
        element,
    }
}

function lowerPrimitiveFieldType(path: string, type: LayoutPrimitiveType): LoweredPrimitiveFieldType {

    const primitive = PRIMITIVE_DEFINITIONS[type]
    if (primitive === undefined) {
        throwUnsupportedFormat(fieldSubject(path), {
            expected: { type: Object.keys(PRIMITIVE_DEFINITIONS) },
            actual: { type },
            message: 'Layout field type is not supported.',
        })
    }

    return {
        type: primitive.type,
        wgslType: primitive.wgslType,
        alignment: primitive.alignment,
        size: primitive.size,
        componentType: primitive.componentType,
        componentCount: primitive.componentCount,
        primitive,
    }
}

function normalizeUsages(spec: LayoutSpec, usage: unknown): LayoutCodecUsage[] {

    if (usage === undefined) return [ ...DEFAULT_USAGES ]
    if (!Array.isArray(usage) || usage.length === 0) {
        throwUnsupportedFormat(artifactSubject(spec), {
            expected: { usage: 'non-empty LayoutCodecUsage[]' },
            actual: { usage: describeValue(usage) },
            message: 'LayoutCodec usage must be a non-empty array.',
        })
    }

    const seen = new Set<LayoutCodecUsage>()
    const normalized: LayoutCodecUsage[] = []

    for (const value of usage) {
        if (!isUsage(value)) {
            throwUnsupportedFormat(artifactSubject(spec), {
                expected: { usage: [ 'uniform', 'storage', 'readback', 'vertex' ] },
                actual: { usage: value },
                message: 'LayoutCodec usage includes an unsupported value.',
            })
        }

        if (!seen.has(value)) {
            seen.add(value)
            normalized.push(value)
        }
    }

    return normalized
}

function computeUsageCompatibility(fields: LayoutFieldArtifact[]): LayoutUsageCompatibility {

    return {
        uniform: true,
        storage: true,
        readback: true,
        vertex: fields.every(field => field.arrayLength === undefined && field.type !== 'mat4x4f'),
    }
}

function normalizeRecords(codec: LayoutCodec, values: LayoutValues | LayoutValues[]): LayoutValues[] {

    const records = Array.isArray(values) ? values : [ values ]
    if (records.length === 0 || !records.every(isRecord)) {
        throwUnsupportedFormat(codec.subject, {
            expected: { values: 'LayoutValues or non-empty LayoutValues[]' },
            actual: { values: Array.isArray(values) ? values.map(describeValue) : describeValue(values) },
            message: 'LayoutCodec values must be objects keyed by field name.',
        })
    }

    return records
}

function normalizeByteOffset(codec: LayoutCodec, byteOffset: unknown): number {

    const normalized = byteOffset ?? 0
    if (typeof normalized !== 'number' || !Number.isInteger(normalized) || normalized < 0) {
        throwByteLengthDiagnostic(codec, {
            expected: { byteOffset: 'non-negative integer' },
            actual: { byteOffset },
        })
    }

    return normalized
}

function createByteView(
    codec: LayoutCodec,
    target: ArrayBuffer | ArrayBufferView,
    byteOffset: number,
    byteLength: number
): Uint8Array {

    if (target instanceof ArrayBuffer) {
        if (byteOffset + byteLength > target.byteLength) {
            throwByteLengthDiagnostic(codec, {
                expected: { byteLength, byteOffset },
                actual: { targetByteLength: target.byteLength },
            })
        }
        return new Uint8Array(target, byteOffset, byteLength)
    }

    if (ArrayBuffer.isView(target)) {
        if (byteOffset + byteLength > target.byteLength) {
            throwByteLengthDiagnostic(codec, {
                expected: { byteLength, byteOffset },
                actual: { targetByteLength: target.byteLength },
            })
        }
        return new Uint8Array(target.buffer, target.byteOffset + byteOffset, byteLength)
    }

    throwByteLengthDiagnostic(codec, {
        expected: { target: 'ArrayBuffer or ArrayBufferView' },
        actual: { target: describeValue(target) },
    })
}

function normalizeBytes(subject: LayoutCodec | DiagnosticSubject, bytes: ArrayBuffer | ArrayBufferView): Uint8Array {

    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    throwByteLengthDiagnostic(subject, {
        expected: { bytes: 'ArrayBuffer or ArrayBufferView' },
        actual: { bytes: describeValue(bytes) },
    })
}

function writeFieldValue(
    codec: LayoutCodec,
    dataView: DataView,
    offset: number,
    field: LayoutFieldArtifact,
    value: unknown
) {

    if (field.arrayLength !== undefined) {
        if (!Array.isArray(value) || value.length !== field.arrayLength) {
            throwUnsupportedFormat(fieldSubject(field.path), {
                expected: { value: `array length ${field.arrayLength}` },
                actual: { value: Array.isArray(value) ? value.length : describeValue(value) },
                message: 'LayoutCodec array field value has the wrong shape.',
            })
        }

        for (let index = 0; index < field.arrayLength; index++) {
            writePrimitiveValue(codec, dataView, offset + index * requireArrayStride(codec, field), field, value[index])
        }
        return
    }

    writePrimitiveValue(codec, dataView, offset, field, value)
}

function writePrimitiveValue(
    codec: LayoutCodec,
    dataView: DataView,
    offset: number,
    field: LayoutFieldArtifact,
    value: unknown
) {

    if (field.componentType === undefined || field.componentCount === undefined) {
        throwUnsupportedFormat(fieldSubject(field.path), {
            expected: { field: 'primitive field metadata' },
            actual: { field },
            message: 'LayoutCodec field metadata is missing primitive component facts.',
        })
    }

    const values = field.componentCount === 1 ? [ value ] : value
    if (!Array.isArray(values) || values.length !== field.componentCount || !values.every(component => typeof component === 'number')) {
        throwUnsupportedFormat(fieldSubject(field.path), {
            expected: { value: field.componentCount === 1 ? 'number' : `number[${field.componentCount}]` },
            actual: { value: Array.isArray(value) ? value.map(describeValue) : describeValue(value) },
            message: 'LayoutCodec field value has the wrong shape.',
        })
    }

    values.forEach((component, index) => {
        writeScalar(dataView, offset + index * 4, field.componentType!, component)
    })
}

function readFieldValue(artifact: LayoutArtifact, dataView: DataView, offset: number, field: LayoutFieldArtifact): unknown {

    if (field.arrayLength !== undefined) {
        return Array.from({ length: field.arrayLength }, (_, index) => {
            return readPrimitiveValue(dataView, offset + index * requireArrayStride(artifact, field), field)
        })
    }

    return readPrimitiveValue(dataView, offset, field)
}

function readPrimitiveValue(dataView: DataView, offset: number, field: LayoutFieldArtifact): unknown {

    if (field.componentType === undefined || field.componentCount === undefined) {
        return undefined
    }

    const values = Array.from({ length: field.componentCount }, (_, index) => {
        return readScalar(dataView, offset + index * 4, field.componentType!)
    })

    return field.componentCount === 1 ? values[0] : values
}

function writeScalar(dataView: DataView, offset: number, type: LayoutScalarType, value: number) {

    if (type === 'f32') dataView.setFloat32(offset, value, true)
    if (type === 'i32') dataView.setInt32(offset, value, true)
    if (type === 'u32') dataView.setUint32(offset, value, true)
}

function readScalar(dataView: DataView, offset: number, type: LayoutScalarType): number {

    if (type === 'f32') return dataView.getFloat32(offset, true)
    if (type === 'i32') return dataView.getInt32(offset, true)
    return dataView.getUint32(offset, true)
}

function requireArrayStride(context: LayoutCodec | LayoutArtifact, field: LayoutFieldArtifact): number {

    if (field.arrayStride !== undefined) return field.arrayStride
    throwUnsupportedFormat(layoutDiagnosticSubject(context), {
        expected: { field: 'array field stride metadata' },
        actual: { field },
        message: 'LayoutCodec array field is missing stride metadata.',
    })
}

function normalizeNamespace(codec: LayoutCodec, namespace: unknown): string {

    if (namespace === undefined) return codec.artifact.name
    if (typeof namespace === 'string' && isIdentifier(namespace)) return namespace

    throwUnsupportedFormat(codec.subject, {
        expected: { namespace: 'WGSL identifier string' },
        actual: { namespace },
        message: 'LayoutCodec WGSL accessor namespace must be a WGSL identifier.',
    })
}

function throwUnsupportedFormat(
    subject: DiagnosticSubject,
    details: { expected: unknown, actual: unknown, message: string }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
        severity: 'error',
        phase: 'layout-codec',
        subject,
        message: details.message,
        expected: details.expected,
        actual: details.actual,
    })
}

function throwByteLengthDiagnostic(
    subject: LayoutCodec | DiagnosticSubject,
    details: { expected: unknown, actual: unknown }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
        severity: 'error',
        phase: 'layout-codec',
        subject: layoutDiagnosticSubject(subject),
        message: 'LayoutCodec byte length does not match its LayoutArtifact.',
        expected: details.expected,
        actual: details.actual,
    })
}

function layoutDiagnosticSubject(context: LayoutCodec | LayoutArtifact | DiagnosticSubject): DiagnosticSubject {

    if (context instanceof LayoutCodec) return context.subject
    if (isLayoutArtifact(context)) return layoutArtifactSubject(context)

    return context
}

function isPrimitiveType(type: string): type is LayoutPrimitiveType {

    return Object.prototype.hasOwnProperty.call(PRIMITIVE_DEFINITIONS, type)
}

function isUsage(value: unknown): value is LayoutCodecUsage {

    return value === 'uniform' || value === 'storage' || value === 'readback' || value === 'vertex'
}

function isPositiveSafeInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isIdentifier(value: string): boolean {

    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function artifactSubject(spec: LayoutSpec): DiagnosticSubject {

    return unresolvedArtifactSubject(spec.label)
}

function unresolvedArtifactSubject(label: string | undefined): DiagnosticSubject {

    const subject: DiagnosticSubject = {
        kind: 'LayoutArtifact',
        abiHash: 'unresolved',
        schemaHash: 'unresolved',
    }
    if (label !== undefined) subject.label = label

    return subject
}

function fieldSubject(path: string): DiagnosticSubject {

    return {
        kind: 'LayoutField',
        path,
        label: path,
    }
}

function roundUp(alignment: number, value: number): number {

    return Math.ceil(value / alignment) * alignment
}

function constantSegment(name: string): string {

    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .toUpperCase()
}

function pascalName(name: string): string {

    return name
        .split(/_+/g)
        .map(segment => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
        .join('')
}

function fnv1a64(value: string): string {

    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < value.length; index++) {
        hash ^= BigInt(value.charCodeAt(index))
        hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }

    return hash.toString(16).padStart(16, '0')
}

function freezeLayoutArtifact(artifact: LayoutArtifact): LayoutArtifact {

    for (const field of artifact.fields) Object.freeze(field)
    Object.freeze(artifact.fields)
    Object.freeze(artifact.usages)
    Object.freeze(artifact.usageCompatibility)
    return Object.freeze(artifact)
}

function firstCanonicalDifference(
    expected: unknown,
    actual: unknown,
    path: string
): LayoutCompatibilityDifference {

    if (Object.is(expected, actual)) return { path, expected, actual }
    if (Array.isArray(expected) && Array.isArray(actual)) {
        const length = Math.max(expected.length, actual.length)
        for (let index = 0; index < length; index++) {
            if (!Object.is(expected[index], actual[index])) {
                return firstCanonicalDifference(expected[index], actual[index], `${path}[${index}]`)
            }
        }
    }
    if (isRecord(expected) && isRecord(actual)) {
        const keys = [ ...new Set([ ...Object.keys(expected), ...Object.keys(actual) ]) ].sort()
        for (const key of keys) {
            if (!Object.is(expected[key], actual[key])) {
                return firstCanonicalDifference(expected[key], actual[key], `${path}.${key}`)
            }
        }
    }

    return {
        path,
        expected: boundedDifferenceValue(expected),
        actual: boundedDifferenceValue(actual),
    }
}

function boundedDifferenceValue(value: unknown): unknown {

    if (typeof value !== 'string') return value
    return value.length <= 128 ? value : `${value.slice(0, 128)}...`
}
