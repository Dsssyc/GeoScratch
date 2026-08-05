import { throwScratchDiagnostic } from './diagnostics.js'
import { describeValue, isRecord } from './type-utils.js'
import type { DiagnosticSubject } from './diagnostics.js'

export type LayoutScalarType = 'i32' | 'u32' | 'f32' | 'f16'
export type LayoutVectorLength = 2 | 3 | 4
export type LayoutMatrixDimension = 2 | 3 | 4
export type LayoutVectorType =
    | `vec${LayoutVectorLength}i`
    | `vec${LayoutVectorLength}u`
    | `vec${LayoutVectorLength}f`
    | `vec${LayoutVectorLength}h`
export type LayoutMatrixType =
    `mat${LayoutMatrixDimension}x${LayoutMatrixDimension}${'f' | 'h'}`
export type LayoutTypeShorthand = LayoutScalarType | LayoutVectorType | LayoutMatrixType

export type LayoutVectorTypeDescriptor = Readonly<{
    kind: 'vector'
    component: LayoutScalarType
    length: LayoutVectorLength
}>

export type LayoutMatrixTypeDescriptor = Readonly<{
    kind: 'matrix'
    component: 'f32' | 'f16'
    columns: LayoutMatrixDimension
    rows: LayoutMatrixDimension
}>

export type LayoutAtomicTypeDescriptor = Readonly<{
    kind: 'atomic'
    component: 'i32' | 'u32'
}>

export type LayoutArrayTypeDescriptor = Readonly<{
    kind?: 'array'
    element: LayoutFixedFieldType
    count: number
}>

export type LayoutRuntimeArrayTypeDescriptor = Readonly<{
    kind: 'runtime-array'
    element: LayoutFixedFieldType
}>

export type LayoutFixedStructTypeDescriptor = Readonly<{
    kind: 'struct'
    name: string
    fields: readonly LayoutFixedFieldDescriptor[]
}>

export type LayoutRuntimeStructTypeDescriptor = Readonly<{
    kind: 'struct'
    name: string
    fields: readonly [
        ...LayoutFixedFieldDescriptor[],
        LayoutRuntimeArrayFieldDescriptor,
    ]
}>

export type LayoutBufferTypeDescriptor = Readonly<{
    kind: 'buffer'
    byteLength?: number
    f16Enabled?: boolean
}>

export type LayoutFixedFieldType =
    | LayoutTypeShorthand
    | LayoutVectorTypeDescriptor
    | LayoutMatrixTypeDescriptor
    | LayoutAtomicTypeDescriptor
    | LayoutArrayTypeDescriptor
    | LayoutFixedStructTypeDescriptor

export type LayoutFieldType =
    | LayoutFixedFieldType
    | LayoutRuntimeArrayTypeDescriptor

export type LayoutFixedFieldDescriptor = Readonly<{
    name: string
    type: LayoutFixedFieldType
    align?: number
    size?: number
}>

export type LayoutRuntimeArrayFieldDescriptor = Readonly<{
    name: string
    type: LayoutRuntimeArrayTypeDescriptor
    align?: number
    size?: never
}>

export type LayoutFieldDescriptor =
    | LayoutFixedFieldDescriptor
    | LayoutRuntimeArrayFieldDescriptor

export type LayoutStructTypeDescriptor =
    | LayoutFixedStructTypeDescriptor
    | LayoutRuntimeStructTypeDescriptor

export type LayoutStructFields =
    | readonly LayoutFixedFieldDescriptor[]
    | readonly [
        ...LayoutFixedFieldDescriptor[],
        LayoutRuntimeArrayFieldDescriptor,
    ]

export type LayoutRootType =
    | LayoutFieldType
    | LayoutStructTypeDescriptor
    | LayoutBufferTypeDescriptor

export type LayoutStructSpec = Readonly<{
    label?: string
    name: string
    fields: LayoutStructFields
    type?: never
}>

export type LayoutTypedSpec = Readonly<{
    label?: string
    name: string
    type: LayoutRootType
    fields?: never
}>

export type LayoutSpec = LayoutStructSpec | LayoutTypedSpec

export type LayoutCanonicalScalarTypeDescriptor = Readonly<{
    kind: 'scalar'
    component: LayoutScalarType
}>

export type LayoutCanonicalVectorTypeDescriptor = Readonly<{
    kind: 'vector'
    component: LayoutScalarType
    length: LayoutVectorLength
}>

export type LayoutCanonicalMatrixTypeDescriptor = Readonly<{
    kind: 'matrix'
    component: 'f32' | 'f16'
    columns: LayoutMatrixDimension
    rows: LayoutMatrixDimension
}>

export type LayoutCanonicalAtomicTypeDescriptor = Readonly<{
    kind: 'atomic'
    component: 'i32' | 'u32'
}>

export type LayoutCanonicalArrayTypeDescriptor = Readonly<{
    kind: 'array'
    element: LayoutCanonicalTypeDescriptor
    count: number
}>

export type LayoutCanonicalRuntimeArrayTypeDescriptor = Readonly<{
    kind: 'runtime-array'
    element: LayoutCanonicalTypeDescriptor
}>

export type LayoutCanonicalFieldDescriptor = Readonly<{
    name: string
    type: LayoutCanonicalTypeDescriptor
    align?: number
    size?: number
}>

export type LayoutCanonicalStructTypeDescriptor = Readonly<{
    kind: 'struct'
    name: string
    fields: readonly LayoutCanonicalFieldDescriptor[]
}>

export type LayoutCanonicalBufferTypeDescriptor = Readonly<{
    kind: 'buffer'
    byteLength?: number
    f16Enabled: boolean
}>

export type LayoutCanonicalTypeDescriptor =
    | LayoutCanonicalScalarTypeDescriptor
    | LayoutCanonicalVectorTypeDescriptor
    | LayoutCanonicalMatrixTypeDescriptor
    | LayoutCanonicalAtomicTypeDescriptor
    | LayoutCanonicalArrayTypeDescriptor
    | LayoutCanonicalRuntimeArrayTypeDescriptor
    | LayoutCanonicalStructTypeDescriptor
    | LayoutCanonicalBufferTypeDescriptor

export type LayoutCanonicalSpec = Readonly<{
    label?: string
    name: string
    type: LayoutCanonicalTypeDescriptor
}>

export type LayoutCodecUsage = 'uniform' | 'storage' | 'readback' | 'vertex' | 'immediate'
export type LayoutUniformContract = 'portable' | 'uniform_buffer_standard_layout'

export type LayoutCodecOptions = Readonly<{
    usage?: readonly LayoutCodecUsage[]
    uniformLayout?: LayoutUniformContract
}>

export type LayoutCapabilityContract = Readonly<{
    uniformLayout: LayoutUniformContract
}>

export type LayoutUsageCompatibilityFact = Readonly<{
    compatible: boolean
    requiredDeviceFeatures: readonly GPUFeatureName[]
    requiredLanguageFeatures: readonly string[]
    reasons: readonly string[]
    requiresMutableStorage: boolean
}>

export type LayoutUsageCompatibility = Readonly<
    Record<LayoutCodecUsage, LayoutUsageCompatibilityFact>
>

type LayoutTypeArtifactBase = Readonly<{
    wgslType: string
    constructible: boolean
    hostShareable: true
    containsAtomic: boolean
    containsArray: boolean
    containsBuffer: boolean
    requiredDeviceFeatures: readonly GPUFeatureName[]
    requiredLanguageFeatures: readonly string[]
}>

export type LayoutScalarTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'scalar'
    extent: 'fixed'
    component: LayoutScalarType
    alignment: number
    byteLength: number
}>

export type LayoutVectorTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'vector'
    extent: 'fixed'
    component: LayoutScalarType
    length: LayoutVectorLength
    alignment: number
    byteLength: number
}>

export type LayoutMatrixTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'matrix'
    extent: 'fixed'
    component: 'f32' | 'f16'
    columns: LayoutMatrixDimension
    rows: LayoutMatrixDimension
    columnStride: number
    alignment: number
    byteLength: number
}>

export type LayoutAtomicTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'atomic'
    extent: 'fixed'
    component: 'i32' | 'u32'
    alignment: 4
    byteLength: 4
}>

export type LayoutArrayTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'array'
    extent: 'fixed'
    element: LayoutTypeArtifact
    count: number
    elementStride: number
    alignment: number
    byteLength: number
}>

export type LayoutRuntimeArrayTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'runtime-array'
    extent: 'runtime'
    element: LayoutTypeArtifact
    elementStride: number
    alignment: number
    fixedPrefixByteLength: 0
    minimumBindingSize: number
}>

export type LayoutFieldArtifact = Readonly<{
    kind: 'LayoutField'
    name: string
    path: string
    type: LayoutTypeArtifact
    wgslType: string
    extent: 'fixed' | 'runtime'
    offset: number
    alignment: number
    naturalAlignment: number
    byteLength?: number
    naturalByteLength?: number
    padding: number
    explicitAlign?: number
    explicitSize?: number
}>

export type LayoutFixedStructTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'struct'
    extent: 'fixed'
    name: string
    members: readonly LayoutFieldArtifact[]
    alignment: number
    byteLength: number
}>

export type LayoutRuntimeStructTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'struct'
    extent: 'runtime'
    name: string
    members: readonly LayoutFieldArtifact[]
    alignment: number
    fixedPrefixByteLength: number
    minimumBindingSize: number
    runtimeTail: LayoutRuntimeTail
}>

export type LayoutFixedBufferTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'buffer'
    extent: 'fixed'
    alignment: null
    byteLength: number
    byteGranularity: 2 | 4
    f16Enabled: boolean
}>

export type LayoutRuntimeBufferTypeArtifact = LayoutTypeArtifactBase & Readonly<{
    kind: 'buffer'
    extent: 'runtime'
    alignment: null
    fixedPrefixByteLength: 0
    minimumBindingSize: number
    byteGranularity: 2 | 4
    f16Enabled: boolean
}>

export type LayoutTypeArtifact =
    | LayoutScalarTypeArtifact
    | LayoutVectorTypeArtifact
    | LayoutMatrixTypeArtifact
    | LayoutAtomicTypeArtifact
    | LayoutArrayTypeArtifact
    | LayoutRuntimeArrayTypeArtifact
    | LayoutFixedStructTypeArtifact
    | LayoutRuntimeStructTypeArtifact
    | LayoutFixedBufferTypeArtifact
    | LayoutRuntimeBufferTypeArtifact

export type LayoutRuntimeTail = Readonly<{
    path: string
    offset: number
    elementStride: number
    elementAlignment: number
    elementByteLength: number
}>

type LayoutArtifactBase = Readonly<{
    kind: 'LayoutArtifact'
    name: string
    label?: string
    alignmentMode: 'host-shareable'
    type: LayoutTypeArtifact
    fields: readonly LayoutFieldArtifact[]
    minimumBindingSize: number
    abiHash: string
    schemaHash: string
    usages: readonly LayoutCodecUsage[]
    usageCompatibility: LayoutUsageCompatibility
    capabilityContract: LayoutCapabilityContract
    requiredDeviceFeatures: readonly GPUFeatureName[]
    requiredLanguageFeatures: readonly string[]
}>

export type FixedLayoutArtifact = LayoutArtifactBase & Readonly<{
    extent: 'fixed'
    alignment: number | null
    byteLength: number
    stride: number
}>

export type RuntimeLayoutArtifact = LayoutArtifactBase & Readonly<{
    extent: 'runtime'
    alignment: number | null
    fixedPrefixByteLength: number
    runtimeTail?: LayoutRuntimeTail
    byteGranularity?: 2 | 4
}>

export type LayoutArtifact = FixedLayoutArtifact | RuntimeLayoutArtifact

export type LayoutCompatibilityDifference = Readonly<{
    path: string
    expected: unknown
    actual: unknown
}>

export type LayoutBufferViewBuiltin = 'bufferView' | 'bufferArrayView' | 'bufferLength'
export type LayoutBufferViewAddressSpace = 'storage' | 'uniform' | 'workgroup'
export type LayoutBufferViewAccessMode = 'read' | 'read_write'
export type LayoutBufferViewPointerPath = 'originating-variable' | 'function-parameter'

export type LayoutBufferViewAddressDescriptor =
    | Readonly<{
        addressSpace: 'storage'
        accessMode: 'read' | 'read_write'
    }>
    | Readonly<{
        addressSpace: 'uniform'
        accessMode: 'read'
    }>
    | Readonly<{
        addressSpace: 'workgroup'
        accessMode: 'read_write'
    }>

export type LayoutBufferViewPointerDescriptor =
    | Readonly<{
        pointerPath?: 'originating-variable'
        parameterBuffers?: never
    }>
    | Readonly<{
        pointerPath: 'function-parameter'
        parameterBuffers: readonly LayoutArtifact[]
    }>

export type LayoutBufferViewDescriptor =
    (
    | Readonly<{
        kind: 'bufferView'
        target: LayoutArtifact
        byteOffset?: number
    }>
    | Readonly<{
        kind: 'bufferArrayView'
        target: LayoutArtifact
        byteOffset?: number
        byteLength?: number
    }>
    | Readonly<{
        kind: 'bufferLength'
    }>
    ) & LayoutBufferViewAddressDescriptor & LayoutBufferViewPointerDescriptor

export type LayoutBufferViewContract = Readonly<{
    kind: 'LayoutBufferViewContract'
    nativeBuiltin: LayoutBufferViewBuiltin
    source: LayoutArtifact
    target?: LayoutArtifact
    addressSpace: LayoutBufferViewAddressSpace
    accessMode: LayoutBufferViewAccessMode
    pointerPath: LayoutBufferViewPointerPath
    parameterBuffers: readonly LayoutArtifact[]
    staticBufferByteLength?: number
    byteOffset?: number
    byteLength?: number
    requiredAlignment: number
    minimumTypeSize: number
    arrayOffset?: number
    arrayStride?: number
    requiredDeviceFeatures: readonly GPUFeatureName[]
    requiredLanguageFeatures: readonly string[]
    contractHash: string
}>

export type LayoutRuntimeExtent = Readonly<{
    runtimeElementCount: number
}>

type CanonicalSignatures = Readonly<{
    abi: string
    schema: string
}>

const DEFAULT_USAGES: readonly LayoutCodecUsage[] = [ 'storage', 'readback' ]
const WGSL_U32_MAX = 0xffff_ffff
const layoutCanonicalSignatures = new WeakMap<LayoutArtifact, CanonicalSignatures>()
const layoutArtifacts = new WeakSet<LayoutArtifact>()
const layoutBufferViewContracts = new WeakSet<LayoutBufferViewContract>()

export function createLayoutArtifact(
    spec: unknown,
    options: LayoutCodecOptions = {}
): Readonly<{ spec: LayoutCanonicalSpec, artifact: LayoutArtifact }> {

    const normalizedSpec = normalizeLayoutSpec(spec)
    const normalizedOptions = normalizeLayoutOptions(normalizedSpec, options)
    registerStructNames(normalizedSpec.type, new Map(), normalizedSpec.name)
    const type = lowerLayoutType(normalizedSpec.type, normalizedSpec.name)
    const capabilityContract = Object.freeze({
        uniformLayout: normalizedOptions.uniformLayout,
    })
    const usageCompatibility = computeUsageCompatibility(type, capabilityContract)
    if (
        normalizedOptions.usages.includes('immediate') &&
        !usageCompatibility.immediate.compatible
    ) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_USAGE_INCOMPATIBLE',
            artifactSubject(normalizedSpec),
            'LayoutSpec is not compatible with WGSL immediate address space.',
            {
                usage: 'immediate',
                compatible: true,
            },
            {
                usage: 'immediate',
                reasons: usageCompatibility.immediate.reasons,
            }
        )
    }

    const fields = type.kind === 'struct' ? type.members : Object.freeze([])
    const requiredDeviceFeatures = type.requiredDeviceFeatures
    const requiredLanguageFeatures = type.requiredLanguageFeatures
    const abiCanonical = {
        alignmentMode: 'host-shareable',
        capabilityContract,
        type: canonicalTypeArtifact(type, false),
        requiredDeviceFeatures,
        requiredLanguageFeatures,
    }
    const schemaCanonical = {
        name: normalizedSpec.name,
        capabilityContract,
        type: canonicalTypeArtifact(type, true),
        requiredDeviceFeatures,
        requiredLanguageFeatures,
    }
    const abiSignature = JSON.stringify(abiCanonical)
    const schemaSignature = JSON.stringify(schemaCanonical)
    const common = {
        kind: 'LayoutArtifact' as const,
        name: normalizedSpec.name,
        ...(normalizedSpec.label !== undefined ? { label: normalizedSpec.label } : {}),
        alignmentMode: 'host-shareable' as const,
        type,
        fields,
        minimumBindingSize: minimumBindingSizeOf(type),
        abiHash: `layout-abi-${fnv1a64(abiSignature)}`,
        schemaHash: `layout-schema-${fnv1a64(schemaSignature)}`,
        usages: normalizedOptions.usages,
        usageCompatibility,
        capabilityContract,
        requiredDeviceFeatures,
        requiredLanguageFeatures,
    }
    const artifact: LayoutArtifact = type.extent === 'fixed'
        ? Object.freeze({
            ...common,
            extent: 'fixed',
            alignment: type.alignment,
            byteLength: type.byteLength,
            stride: type.alignment === null
                ? type.byteLength
                : checkedRoundUp(
                    artifactSubject(normalizedSpec),
                    type.alignment,
                    type.byteLength,
                    'root-stride'
                ),
        })
        : Object.freeze({
            ...common,
            extent: 'runtime',
            alignment: type.alignment,
            fixedPrefixByteLength: type.fixedPrefixByteLength,
            ...(type.kind === 'struct' ? { runtimeTail: type.runtimeTail } : {}),
            ...(type.kind === 'runtime-array' ? {
                runtimeTail: Object.freeze({
                    path: normalizedSpec.name,
                    offset: 0,
                    elementStride: type.elementStride,
                    elementAlignment: requireTypeAlignment(type.element),
                    elementByteLength: requireTypeByteLength(type.element),
                }),
            } : {}),
            ...(type.kind === 'buffer' ? { byteGranularity: type.byteGranularity } : {}),
        })

    layoutCanonicalSignatures.set(artifact, Object.freeze({
        abi: abiSignature,
        schema: schemaSignature,
    }))
    layoutArtifacts.add(artifact)

    return Object.freeze({ spec: normalizedSpec, artifact })
}

export function isLayoutArtifact(value: unknown): value is LayoutArtifact {

    return typeof value === 'object' && value !== null &&
        layoutArtifacts.has(value as LayoutArtifact)
}

export function isLayoutBufferViewContract(
    value: unknown
): value is LayoutBufferViewContract {

    return typeof value === 'object' && value !== null &&
        layoutBufferViewContracts.has(value as LayoutBufferViewContract)
}

export function layoutArtifactsAbiCompatible(
    left: LayoutArtifact,
    right: LayoutArtifact
): boolean {

    const leftSignatures = layoutCanonicalSignatures.get(left)
    const rightSignatures = layoutCanonicalSignatures.get(right)
    return leftSignatures !== undefined &&
        rightSignatures !== undefined &&
        left.abiHash === right.abiHash &&
        leftSignatures.abi === rightSignatures.abi
}

export function layoutArtifactsSchemaCompatible(
    left: LayoutArtifact,
    right: LayoutArtifact
): boolean {

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
            expected: expectedSignature === undefined
                ? 'registered LayoutArtifact'
                : 'available',
            actual: actualSignature === undefined
                ? 'unregistered LayoutArtifact'
                : 'available',
        })
    }
    if (expectedSignature === actualSignature) return undefined

    return Object.freeze(firstCanonicalDifference(
        JSON.parse(expectedSignature) as unknown,
        JSON.parse(actualSignature) as unknown,
        kind
    ))
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

export function layoutArtifactByteLength(
    artifact: LayoutArtifact,
    options?: LayoutRuntimeExtent
): number {

    requireLayoutArtifact(artifact)
    if (artifact.extent === 'fixed') {
        if (options !== undefined) {
            throwRuntimeExtentDiagnostic(artifact, options, {
                runtimeElementCount: 'omitted for a fixed layout',
            })
        }
        return artifact.byteLength
    }
    if (artifact.runtimeTail === undefined) {
        throwRuntimeExtentDiagnostic(artifact, options, {
            runtimeElementCount: 'not applicable to an opaque runtime buffer',
        })
    }
    const count = normalizeRuntimeElementCount(artifact, options?.runtimeElementCount)
    return checkedAddLayoutSize(
        layoutArtifactSubject(artifact),
        artifact.runtimeTail.offset,
        checkedMultiplyLayoutSize(
            layoutArtifactSubject(artifact),
            artifact.runtimeTail.elementStride,
            count,
            'runtime-tail-size'
        ),
        'runtime-layout-size'
    )
}

export function layoutArtifactRuntimeElementCount(
    artifact: LayoutArtifact,
    byteLength: number
): number | undefined {

    requireLayoutArtifact(artifact)
    if (!isNonNegativeSafeInteger(byteLength)) return undefined
    if (artifact.extent === 'fixed') {
        if (byteLength === artifact.byteLength) return 1
        return byteLength >= artifact.stride &&
            byteLength % artifact.stride === 0
            ? byteLength / artifact.stride
            : undefined
    }
    if (artifact.runtimeTail === undefined) return undefined
    if (byteLength < artifact.minimumBindingSize) return undefined
    return Math.trunc(
        (byteLength - artifact.runtimeTail.offset) /
        artifact.runtimeTail.elementStride
    )
}

export function layoutArtifactAcceptsBindingByteLength(
    artifact: LayoutArtifact,
    byteLength: number
): boolean {

    if (!isLayoutArtifact(artifact) || !isPositiveSafeInteger(byteLength)) return false
    if (artifact.type.kind === 'buffer') {
        return byteLength >= artifact.minimumBindingSize &&
            byteLength % artifact.type.byteGranularity === 0
    }
    if (artifact.extent === 'fixed') {
        return byteLength === artifact.byteLength ||
            (
                byteLength >= artifact.stride &&
                byteLength % artifact.stride === 0
            )
    }
    return byteLength >= artifact.minimumBindingSize
}

export function layoutArtifactAcceptsViewByteLength(
    artifact: LayoutArtifact,
    byteLength: number
): boolean {

    if (!isLayoutArtifact(artifact) || !isPositiveSafeInteger(byteLength)) return false
    if (artifact.extent === 'fixed') {
        return byteLength === artifact.byteLength ||
            (
                byteLength >= artifact.stride &&
                byteLength % artifact.stride === 0
            )
    }
    if (artifact.type.kind === 'buffer') {
        return byteLength >= artifact.minimumBindingSize &&
            byteLength % artifact.type.byteGranularity === 0
    }
    return byteLength >= artifact.minimumBindingSize
}

export function createLayoutBufferViewContract(
    source: LayoutArtifact,
    descriptor: unknown
): LayoutBufferViewContract {

    requireLayoutArtifact(source)
    if (source.type.kind !== 'buffer') {
        throwBufferViewDiagnostic(source, undefined, {
            sourceType: 'buffer<N> or buffer',
        }, {
            sourceType: source.type.wgslType,
        })
    }
    if (!isRecord(descriptor)) {
        throwBufferViewDiagnostic(source, undefined, {
            descriptor: 'LayoutBufferViewDescriptor',
        }, {
            descriptor: describeValue(descriptor),
        })
    }

    const nativeBuiltin = descriptor.kind
    const addressSpace = descriptor.addressSpace
    const accessMode = descriptor.accessMode
    const pointerPath = descriptor.pointerPath ?? 'originating-variable'
    const parameterBuffers = descriptor.parameterBuffers
    const target = descriptor.target
    const byteOffset = descriptor.byteOffset
    const byteLength = descriptor.byteLength

    if (
        nativeBuiltin !== 'bufferView' &&
        nativeBuiltin !== 'bufferArrayView' &&
        nativeBuiltin !== 'bufferLength'
    ) {
        throwBufferViewDiagnostic(source, undefined, {
            kind: [ 'bufferView', 'bufferArrayView', 'bufferLength' ],
        }, { kind: nativeBuiltin })
    }
    if (
        addressSpace !== 'storage' &&
        addressSpace !== 'uniform' &&
        addressSpace !== 'workgroup'
    ) {
        throwBufferViewDiagnostic(source, undefined, {
            addressSpace: [ 'storage', 'uniform', 'workgroup' ],
        }, { addressSpace })
    }
    if (accessMode !== 'read' && accessMode !== 'read_write') {
        throwBufferViewDiagnostic(source, undefined, {
            accessMode: [ 'read', 'read_write' ],
        }, { accessMode })
    }
    const validAccessMode = addressSpace === 'storage'
        ? accessMode === 'read' || accessMode === 'read_write'
        : addressSpace === 'uniform'
            ? accessMode === 'read'
            : accessMode === 'read_write'
    if (!validAccessMode) {
        throwBufferViewDiagnostic(source, undefined, {
            accessMode: addressSpace === 'storage'
                ? [ 'read', 'read_write' ]
                : addressSpace === 'uniform'
                    ? 'read'
                    : 'read_write',
        }, { addressSpace, accessMode })
    }
    if (source.extent === 'runtime' && addressSpace !== 'storage') {
        throwBufferViewDiagnostic(source, undefined, {
            addressSpace: 'storage for a runtime-sized buffer',
        }, {
            addressSpace,
            sourceExtent: source.extent,
        })
    }
    if (
        pointerPath !== 'originating-variable' &&
        pointerPath !== 'function-parameter'
    ) {
        throwBufferViewDiagnostic(source, undefined, {
            pointerPath: [ 'originating-variable', 'function-parameter' ],
        }, { pointerPath })
    }
    const normalizedBuiltin = nativeBuiltin as LayoutBufferViewBuiltin
    const normalizedAddressSpace = addressSpace as LayoutBufferViewAddressSpace
    const normalizedAccessMode = accessMode as LayoutBufferViewAccessMode
    const normalizedPointerPath = pointerPath as LayoutBufferViewPointerPath
    const normalizedParameterPath = normalizeBufferViewParameterPath(
        source,
        normalizedPointerPath,
        parameterBuffers
    )
    const staticBufferByteLength =
        bufferViewStaticByteLength(source, normalizedParameterPath)

    if (normalizedBuiltin === 'bufferLength') {
        if (target !== undefined || byteOffset !== undefined || byteLength !== undefined) {
            throwBufferViewDiagnostic(source, undefined, {
                bufferLength: 'no target, byteOffset, or byteLength',
            }, { target, byteOffset, byteLength })
        }
        return registerBufferViewContract(Object.freeze({
            kind: 'LayoutBufferViewContract',
            nativeBuiltin: normalizedBuiltin,
            source,
            addressSpace: normalizedAddressSpace,
            accessMode: normalizedAccessMode,
            pointerPath: normalizedPointerPath,
            parameterBuffers: normalizedParameterPath,
            ...(staticBufferByteLength !== undefined
                ? { staticBufferByteLength }
                : {}),
            requiredAlignment: 1,
            minimumTypeSize: 0,
            requiredDeviceFeatures: unionDeviceFeatures([
                ...source.requiredDeviceFeatures,
                ...normalizedParameterPath.flatMap(
                    artifact => artifact.requiredDeviceFeatures
                ),
            ]),
            requiredLanguageFeatures: requiredBufferViewFeatures(
                source,
                undefined,
                normalizedAddressSpace,
                normalizedPointerPath
            ),
            contractHash: `layout-buffer-view-${fnv1a64(JSON.stringify({
                nativeBuiltin: normalizedBuiltin,
                source: source.abiHash,
                addressSpace: normalizedAddressSpace,
                accessMode: normalizedAccessMode,
                pointerPath: normalizedPointerPath,
                parameterBuffers: normalizedParameterPath.map(
                    artifact => artifact.abiHash
                ),
                staticBufferByteLength,
            }))}`,
        }))
    }

    if (!isLayoutArtifact(target)) {
        throwBufferViewDiagnostic(source, undefined, {
            target: 'LayoutArtifact',
        }, { target: describeValue(target) })
    }
    if (target.type.containsAtomic || target.type.containsBuffer) {
        throwBufferViewDiagnostic(source, target, {
            target: 'host-shareable type without atomic or buffer types',
        }, {
            containsAtomic: target.type.containsAtomic,
            containsBuffer: target.type.containsBuffer,
        })
    }
    const targetViolations = bufferViewTargetViolations(
        target.type,
        addressSpace,
        target.capabilityContract.uniformLayout
    )
    if (targetViolations.length > 0) {
        throwBufferViewDiagnostic(source, target, {
            target: `layout-compatible with ${addressSpace}`,
        }, { reasons: targetViolations })
    }
    if (
        normalizedBuiltin === 'bufferArrayView' &&
        target.extent !== 'runtime'
    ) {
        throwBufferViewDiagnostic(source, target, {
            target: 'host-shareable type without a fixed footprint',
        }, { extent: target.extent })
    }

    const requiredAlignment = requiredAlignmentOf(
        target.type,
        normalizedAddressSpace,
        target.capabilityContract.uniformLayout
    )
    const minimumTypeSize = minTypeSizeOf(target.type)
    const runtimeTail = target.extent === 'runtime'
        ? target.runtimeTail
        : undefined
    const normalizedOffset = normalizeOptionalBufferViewInteger(
        source,
        target,
        'byteOffset',
        byteOffset
    )
    const normalizedByteLength = normalizeOptionalBufferViewInteger(
        source,
        target,
        'byteLength',
        byteLength
    )
    if (
        normalizedOffset !== undefined &&
        normalizedOffset % requiredAlignment !== 0
    ) {
        throwBufferViewDiagnostic(source, target, {
            byteOffset: `multiple of ${requiredAlignment}`,
        }, { byteOffset: normalizedOffset, requiredAlignment })
    }
    if (normalizedBuiltin === 'bufferView' && normalizedByteLength !== undefined) {
        throwBufferViewDiagnostic(source, target, {
            byteLength: 'omitted for bufferView',
        }, { byteLength: normalizedByteLength })
    }
    if (
        normalizedBuiltin === 'bufferArrayView' &&
        normalizedByteLength !== undefined
    ) {
        if (normalizedByteLength < minimumTypeSize) {
            throwBufferViewDiagnostic(source, target, {
                byteLength: `>= ${minimumTypeSize}`,
            }, { byteLength: normalizedByteLength })
        }
        if (
            runtimeTail === undefined ||
            (
                normalizedByteLength - runtimeTail.offset
            ) % runtimeTail.elementStride !== 0
        ) {
            throwBufferViewDiagnostic(source, target, {
                byteLength: 'runtime tail extent divisible by its element stride',
            }, {
                byteLength: normalizedByteLength,
                arrayOffset: runtimeTail?.offset,
                arrayStride: runtimeTail?.elementStride,
            })
        }
    }

    if (staticBufferByteLength !== undefined) {
        if (minimumTypeSize > staticBufferByteLength) {
            throwBufferViewDiagnostic(source, target, {
                minimumTypeSize: `<= static buffer size ${staticBufferByteLength}`,
            }, { minimumTypeSize })
        }
        if (
            normalizedBuiltin === 'bufferView' &&
            normalizedOffset !== undefined &&
            normalizedOffset + minimumTypeSize > staticBufferByteLength
        ) {
            throwBufferViewDiagnostic(source, target, {
                range: `within static buffer size ${staticBufferByteLength}`,
            }, { byteOffset: normalizedOffset, minimumTypeSize })
        }
        if (
            normalizedBuiltin === 'bufferArrayView' &&
            (
                normalizedOffset !== undefined ||
                normalizedByteLength !== undefined
            ) &&
            (normalizedOffset ?? 0) + (normalizedByteLength ?? 0) >
                staticBufferByteLength
        ) {
            throwBufferViewDiagnostic(source, target, {
                range: `within static buffer size ${staticBufferByteLength}`,
            }, {
                byteOffset: normalizedOffset,
                byteLength: normalizedByteLength,
            })
        }
    }

    const contractWithoutHash = {
        kind: 'LayoutBufferViewContract' as const,
        nativeBuiltin: normalizedBuiltin,
        source,
        target,
        addressSpace: normalizedAddressSpace,
        accessMode: normalizedAccessMode,
        pointerPath: normalizedPointerPath,
        parameterBuffers: normalizedParameterPath,
        ...(staticBufferByteLength !== undefined
            ? { staticBufferByteLength }
            : {}),
        ...(normalizedOffset !== undefined ? { byteOffset: normalizedOffset } : {}),
        ...(normalizedByteLength !== undefined ? { byteLength: normalizedByteLength } : {}),
        requiredAlignment,
        minimumTypeSize,
        ...(runtimeTail !== undefined ? {
            arrayOffset: runtimeTail.offset,
            arrayStride: runtimeTail.elementStride,
        } : {}),
        requiredDeviceFeatures: unionDeviceFeatures([
            ...source.requiredDeviceFeatures,
            ...target.requiredDeviceFeatures,
            ...normalizedParameterPath.flatMap(
                artifact => artifact.requiredDeviceFeatures
            ),
        ]),
        requiredLanguageFeatures: requiredBufferViewFeatures(
            source,
            target,
            normalizedAddressSpace,
            normalizedPointerPath
        ),
    }
    const contract = Object.freeze({
        ...contractWithoutHash,
        contractHash: `layout-buffer-view-${fnv1a64(JSON.stringify({
            nativeBuiltin: normalizedBuiltin,
            source: source.abiHash,
            target: target.abiHash,
            addressSpace: normalizedAddressSpace,
            accessMode: normalizedAccessMode,
            pointerPath: normalizedPointerPath,
            parameterBuffers: normalizedParameterPath.map(
                artifact => artifact.abiHash
            ),
            staticBufferByteLength,
            byteOffset: normalizedOffset,
            byteLength: normalizedByteLength,
            requiredAlignment,
            minimumTypeSize,
            arrayOffset: runtimeTail?.offset,
            arrayStride: runtimeTail?.elementStride,
            requiredDeviceFeatures: target.requiredDeviceFeatures,
            requiredLanguageFeatures: contractWithoutHash.requiredLanguageFeatures,
        }))}`,
    })
    return registerBufferViewContract(contract)
}

function normalizeBufferViewParameterPath(
    source: LayoutArtifact,
    pointerPath: LayoutBufferViewPointerPath,
    value: unknown
): readonly LayoutArtifact[] {

    if (pointerPath === 'originating-variable') {
        if (value !== undefined) {
            throwBufferViewDiagnostic(source, undefined, {
                parameterBuffers: 'omitted for an originating variable',
            }, { parameterBuffers: describeValue(value) })
        }
        return Object.freeze([])
    }
    if (!Array.isArray(value) || value.length === 0) {
        throwBufferViewDiagnostic(source, undefined, {
            parameterBuffers: 'non-empty LayoutArtifact[] for a function-parameter path',
        }, { parameterBuffers: describeValue(value) })
    }

    const normalized: LayoutArtifact[] = []
    let current = source
    for (const candidate of value) {
        if (!isLayoutArtifact(candidate) || candidate.type.kind !== 'buffer') {
            throwBufferViewDiagnostic(source, undefined, {
                parameterBuffer: 'buffer LayoutArtifact',
            }, { parameterBuffer: describeValue(candidate) })
        }
        if (
            current.type.kind !== 'buffer' ||
            candidate.type.f16Enabled !== current.type.f16Enabled
        ) {
            throwBufferViewDiagnostic(source, candidate, {
                parameterBuffer: 'same buffer byte-granularity capability contract',
            }, {
                sourceF16Enabled: current.type.kind === 'buffer'
                    ? current.type.f16Enabled
                    : undefined,
                parameterF16Enabled: candidate.type.f16Enabled,
            })
        }
        const validConversion = current.extent === 'runtime'
            ? candidate.extent === 'runtime'
            : candidate.extent === 'runtime' ||
                (
                    candidate.extent === 'fixed' &&
                    candidate.byteLength <= current.byteLength
                )
        if (!validConversion) {
            throwBufferViewDiagnostic(source, candidate, {
                parameterBuffer: current.extent === 'runtime'
                    ? 'runtime buffer'
                    : `buffer<N> where N <= ${current.byteLength}, or runtime buffer`,
            }, {
                currentExtent: current.extent,
                currentByteLength: current.extent === 'fixed'
                    ? current.byteLength
                    : undefined,
                parameterExtent: candidate.extent,
                parameterByteLength: candidate.extent === 'fixed'
                    ? candidate.byteLength
                    : undefined,
            })
        }
        normalized.push(candidate)
        current = candidate
    }
    return Object.freeze(normalized)
}

function bufferViewStaticByteLength(
    source: LayoutArtifact,
    parameterBuffers: readonly LayoutArtifact[]
): number | undefined {

    const fixedSizes = [ source, ...parameterBuffers ]
        .filter(
            (artifact): artifact is FixedLayoutArtifact =>
                artifact.extent === 'fixed'
        )
        .map(artifact => artifact.byteLength)
    return fixedSizes.length === 0
        ? undefined
        : Math.min(...fixedSizes)
}

function normalizeLayoutSpec(value: unknown): LayoutCanonicalSpec {

    if (!isRecord(value)) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            unresolvedArtifactSubject(undefined),
            'LayoutCodec requires a LayoutSpec object.',
            { spec: 'LayoutSpec' },
            { spec: describeValue(value) }
        )
    }
    const name = value.name
    const label = value.label
    const type = value.type
    const fields = value.fields
    if (typeof name !== 'string' || !isIdentifier(name)) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            unresolvedArtifactSubject(typeof label === 'string' ? label : undefined),
            'LayoutSpec name must be a WGSL identifier.',
            { name: 'WGSL identifier string' },
            { name }
        )
    }
    if (label !== undefined && typeof label !== 'string') {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            unresolvedArtifactSubject(undefined),
            'LayoutSpec label must be a string.',
            { label: 'string' },
            { label: describeValue(label) }
        )
    }
    if (type !== undefined && fields !== undefined) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            unresolvedArtifactSubject(label as string | undefined),
            'LayoutSpec must declare either type or fields, not both.',
            { shape: 'type xor fields' },
            { type: describeValue(type), fields: describeValue(fields) }
        )
    }

    const stack = new Set<object>()
    const canonicalType = type !== undefined
        ? normalizeLayoutType(type, name, true, stack)
        : normalizeStructType(
            {
                kind: 'struct',
                name,
                fields,
            },
            name,
            true,
            stack
        )
    const spec: LayoutCanonicalSpec = {
        name,
        type: canonicalType,
        ...(label !== undefined ? { label } : {}),
    }
    return Object.freeze(spec)
}

function normalizeLayoutOptions(
    spec: LayoutCanonicalSpec,
    options: unknown
): Readonly<{
    usages: readonly LayoutCodecUsage[]
    uniformLayout: LayoutUniformContract
}> {

    if (!isRecord(options)) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
            artifactSubject(spec),
            'LayoutCodec options must be an object.',
            { options: 'LayoutCodecOptions' },
            { options: describeValue(options) }
        )
    }
    const usage = options.usage
    const uniformLayout = options.uniformLayout ?? 'portable'
    if (
        uniformLayout !== 'portable' &&
        uniformLayout !== 'uniform_buffer_standard_layout'
    ) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_USAGE_INCOMPATIBLE',
            artifactSubject(spec),
            'LayoutCodec uniform layout contract is unsupported.',
            {
                uniformLayout: [
                    'portable',
                    'uniform_buffer_standard_layout',
                ],
            },
            { uniformLayout }
        )
    }

    if (usage === undefined) {
        return Object.freeze({
            usages: Object.freeze([ ...DEFAULT_USAGES ]),
            uniformLayout,
        })
    }
    if (!Array.isArray(usage) || usage.length === 0) {
        throwLayoutDiagnostic(
            'SCRATCH_LAYOUT_USAGE_INCOMPATIBLE',
            artifactSubject(spec),
            'LayoutCodec usage must be a non-empty array.',
            { usage: 'non-empty LayoutCodecUsage[]' },
            { usage: describeValue(usage) }
        )
    }
    const seen = new Set<LayoutCodecUsage>()
    const usages: LayoutCodecUsage[] = []
    for (const entry of [ ...usage ]) {
        if (!isLayoutUsage(entry)) {
            throwLayoutDiagnostic(
                'SCRATCH_LAYOUT_USAGE_INCOMPATIBLE',
                artifactSubject(spec),
                'LayoutCodec usage includes an unsupported value.',
                {
                    usage: [ 'uniform', 'storage', 'readback', 'vertex', 'immediate' ],
                },
                { usage: entry }
            )
        }
        if (!seen.has(entry)) {
            seen.add(entry)
            usages.push(entry)
        }
    }
    return Object.freeze({
        usages: Object.freeze(usages),
        uniformLayout,
    })
}

function normalizeLayoutType(
    value: unknown,
    path: string,
    root: boolean,
    stack: Set<object>
): LayoutCanonicalTypeDescriptor {

    if (typeof value === 'string') return normalizeTypeShorthand(value, path)
    if (!isRecord(value)) {
        throwTypeUnsupported(path, {
            type: 'LayoutFieldType',
        }, {
            type: describeValue(value),
        })
    }
    if (stack.has(value)) {
        throwTypeUnsupported(path, {
            type: 'finite acyclic recursive layout descriptor',
        }, {
            type: 'cyclic descriptor',
        })
    }
    stack.add(value)
    try {
        const kind = value.kind ?? (
            value.element !== undefined && value.count !== undefined
                ? 'array'
                : undefined
        )
        if (kind === 'vector') {
            const component = value.component
            const length = value.length
            if (
                !isScalarType(component) ||
                !isVectorLength(length)
            ) {
                throwTypeUnsupported(path, {
                    vector: {
                        component: [ 'i32', 'u32', 'f32', 'f16' ],
                        length: [ 2, 3, 4 ],
                    },
                }, { component, length })
            }
            return Object.freeze({ kind, component, length })
        }
        if (kind === 'matrix') {
            const component = value.component
            const columns = value.columns
            const rows = value.rows
            if (
                (component !== 'f32' && component !== 'f16') ||
                !isMatrixDimension(columns) ||
                !isMatrixDimension(rows)
            ) {
                throwTypeUnsupported(path, {
                    matrix: {
                        component: [ 'f32', 'f16' ],
                        columns: [ 2, 3, 4 ],
                        rows: [ 2, 3, 4 ],
                    },
                }, { component, columns, rows })
            }
            return Object.freeze({ kind, component, columns, rows })
        }
        if (kind === 'atomic') {
            const component = value.component
            if (component !== 'i32' && component !== 'u32') {
                throwTypeUnsupported(path, {
                    atomic: { component: [ 'i32', 'u32' ] },
                }, { component })
            }
            return Object.freeze({ kind, component })
        }
        if (kind === 'array') {
            const elementValue = value.element
            const count = value.count
            if (!isPositiveSafeInteger(count)) {
                throwTypeUnsupported(path, {
                    count: 'positive safe integer',
                }, { count })
            }
            const element = normalizeLayoutType(
                elementValue,
                `${path}[]`,
                false,
                stack
            )
            if (containsRuntimeType(element) || element.kind === 'buffer') {
                throwTypeUnsupported(path, {
                    element: 'creation-fixed host-shareable type',
                }, { element: element.kind })
            }
            return Object.freeze({ kind, element, count })
        }
        if (kind === 'runtime-array') {
            const element = normalizeLayoutType(
                value.element,
                `${path}[]`,
                false,
                stack
            )
            if (containsRuntimeType(element) || element.kind === 'buffer') {
                throwRuntimeArrayDiagnostic(path, {
                    element: 'creation-fixed host-shareable type',
                }, { element: element.kind })
            }
            return Object.freeze({ kind, element })
        }
        if (kind === 'struct') {
            return normalizeStructType(value, path, root, stack)
        }
        if (kind === 'buffer') {
            if (!root) {
                throwTypeUnsupported(path, {
                    buffer: 'top-level LayoutSpec type only',
                }, { location: 'nested' })
            }
            const byteLength = value.byteLength
            const f16Enabled = value.f16Enabled ?? false
            if (
                byteLength !== undefined &&
                !isPositiveSafeInteger(byteLength)
            ) {
                throwTypeUnsupported(path, {
                    byteLength: 'positive safe integer or omitted',
                }, { byteLength })
            }
            if (typeof f16Enabled !== 'boolean') {
                throwTypeUnsupported(path, {
                    f16Enabled: 'boolean',
                }, { f16Enabled })
            }
            const granularity = f16Enabled ? 2 : 4
            if (
                byteLength !== undefined &&
                byteLength % granularity !== 0
            ) {
                throwTypeUnsupported(path, {
                    byteLength: `multiple of ${granularity}`,
                }, { byteLength, f16Enabled })
            }
            return Object.freeze({
                kind,
                ...(byteLength !== undefined ? { byteLength } : {}),
                f16Enabled,
            })
        }

        throwTypeUnsupported(path, {
            type: [
                'scalar/vector/matrix shorthand',
                'vector',
                'matrix',
                'atomic',
                'array',
                'runtime-array',
                'struct',
                'buffer',
            ],
        }, { kind, type: describeValue(value) })
    } finally {
        stack.delete(value)
    }
}

function normalizeStructType(
    value: Record<string, unknown>,
    path: string,
    root: boolean,
    stack: Set<object>
): LayoutCanonicalStructTypeDescriptor {

    const name = value.name
    const fieldsValue = value.fields
    if (typeof name !== 'string' || !isIdentifier(name)) {
        throwTypeUnsupported(path, {
            name: 'WGSL identifier string',
        }, { name })
    }
    if (!Array.isArray(fieldsValue) || fieldsValue.length === 0) {
        throwTypeUnsupported(path, {
            fields: 'non-empty LayoutFieldDescriptor[]',
        }, {
            fields: Array.isArray(fieldsValue)
                ? fieldsValue.length
                : describeValue(fieldsValue),
        })
    }

    const names = new Set<string>()
    const fields = [ ...fieldsValue ].map((field, index) => {
        if (!isRecord(field)) {
            throwTypeUnsupported(`${path}.${index}`, {
                field: 'LayoutFieldDescriptor',
            }, { field: describeValue(field) })
        }
        const fieldName = field.name
        const fieldType = field.type
        const align = field.align
        const size = field.size
        const fieldPath = typeof fieldName === 'string'
            ? (root ? fieldName : `${path}.${fieldName}`)
            : `${path}.${index}`
        if (typeof fieldName !== 'string' || !isIdentifier(fieldName)) {
            throwTypeUnsupported(fieldPath, {
                name: 'WGSL identifier string',
            }, { name: fieldName })
        }
        if (names.has(fieldName)) {
            throwTypeUnsupported(fieldPath, {
                name: 'unique field name',
            }, { name: fieldName })
        }
        names.add(fieldName)
        const type = normalizeLayoutType(fieldType, fieldPath, false, stack)
        if (type.kind === 'buffer') {
            throwTypeUnsupported(fieldPath, {
                type: 'non-buffer structure member',
            }, { type: 'buffer' })
        }
        if (align !== undefined && !isPositiveSafeInteger(align)) {
            throwMemberAttributeDiagnostic(fieldPath, {
                align: 'positive safe integer power of two',
            }, { align })
        }
        if (size !== undefined && !isPositiveSafeInteger(size)) {
            throwMemberAttributeDiagnostic(fieldPath, {
                size: 'positive safe integer',
            }, { size })
        }
        return Object.freeze({
            name: fieldName,
            type,
            ...(align !== undefined ? { align } : {}),
            ...(size !== undefined ? { size } : {}),
        })
    })

    for (let index = 0; index < fields.length; index++) {
        const field = fields[index]
        if (!containsRuntimeType(field.type)) continue
        const fieldPath = root ? field.name : `${path}.${field.name}`
        if (
            index !== fields.length - 1 ||
            field.type.kind !== 'runtime-array'
        ) {
            throwRuntimeArrayDiagnostic(fieldPath, {
                runtimeArray: 'direct final structure member',
            }, {
                index,
                finalIndex: fields.length - 1,
                type: field.type.kind,
            })
        }
        if (field.size !== undefined) {
            throwMemberAttributeDiagnostic(fieldPath, {
                size: 'omitted for runtime-sized array member',
            }, { size: field.size })
        }
    }

    return Object.freeze({
        kind: 'struct',
        name,
        fields: Object.freeze(fields),
    })
}

function normalizeTypeShorthand(
    value: string,
    path: string
): LayoutCanonicalTypeDescriptor {

    if (isScalarType(value)) {
        return Object.freeze({ kind: 'scalar', component: value })
    }
    const vector = /^vec([234])([fiuh])$/.exec(value)
    if (vector !== null) {
        const length = Number(vector[1]) as LayoutVectorLength
        const component = vector[2] === 'f'
            ? 'f32'
            : vector[2] === 'h'
                ? 'f16'
                : vector[2] === 'i'
                    ? 'i32'
                    : 'u32'
        return Object.freeze({ kind: 'vector', component, length })
    }
    const matrix = /^mat([234])x([234])([fh])$/.exec(value)
    if (matrix !== null) {
        return Object.freeze({
            kind: 'matrix',
            component: matrix[3] === 'h' ? 'f16' : 'f32',
            columns: Number(matrix[1]) as LayoutMatrixDimension,
            rows: Number(matrix[2]) as LayoutMatrixDimension,
        })
    }
    throwTypeUnsupported(path, {
        type: 'WGSL host-shareable numeric shorthand or recursive descriptor',
    }, {
        type: value,
        classification: classifyUnsupportedType(value),
    })
}

function lowerLayoutType(
    type: LayoutCanonicalTypeDescriptor,
    path: string
): LayoutTypeArtifact {

    if (type.kind === 'scalar') {
        const byteLength = type.component === 'f16' ? 2 : 4
        return Object.freeze({
            kind: 'scalar',
            extent: 'fixed',
            component: type.component,
            wgslType: type.component,
            alignment: byteLength,
            byteLength,
            constructible: true,
            hostShareable: true,
            containsAtomic: false,
            containsArray: false,
            containsBuffer: false,
            requiredDeviceFeatures: requiredF16DeviceFeatures(type.component),
            requiredLanguageFeatures: Object.freeze([]),
        })
    }
    if (type.kind === 'vector') {
        const componentByteLength = type.component === 'f16' ? 2 : 4
        const alignment = type.length === 2
            ? componentByteLength * 2
            : componentByteLength * 4
        return Object.freeze({
            kind: 'vector',
            extent: 'fixed',
            component: type.component,
            length: type.length,
            wgslType: vectorWgslType(type.component, type.length),
            alignment,
            byteLength: componentByteLength * type.length,
            constructible: true,
            hostShareable: true,
            containsAtomic: false,
            containsArray: false,
            containsBuffer: false,
            requiredDeviceFeatures: requiredF16DeviceFeatures(type.component),
            requiredLanguageFeatures: Object.freeze([]),
        })
    }
    if (type.kind === 'matrix') {
        const column = lowerLayoutType({
            kind: 'vector',
            component: type.component,
            length: type.rows,
        }, `${path}.column`) as LayoutVectorTypeArtifact
        const columnStride = checkedRoundUp(
            fieldSubject(path),
            column.alignment,
            column.byteLength,
            'matrix-column-stride'
        )
        return Object.freeze({
            kind: 'matrix',
            extent: 'fixed',
            component: type.component,
            columns: type.columns,
            rows: type.rows,
            columnStride,
            wgslType: matrixWgslType(
                type.component,
                type.columns,
                type.rows
            ),
            alignment: column.alignment,
            byteLength: checkedMultiplyLayoutSize(
                fieldSubject(path),
                columnStride,
                type.columns,
                'matrix-size'
            ),
            constructible: true,
            hostShareable: true,
            containsAtomic: false,
            containsArray: false,
            containsBuffer: false,
            requiredDeviceFeatures: requiredF16DeviceFeatures(type.component),
            requiredLanguageFeatures: Object.freeze([]),
        })
    }
    if (type.kind === 'atomic') {
        return Object.freeze({
            kind: 'atomic',
            extent: 'fixed',
            component: type.component,
            wgslType: `atomic<${type.component}>`,
            alignment: 4,
            byteLength: 4,
            constructible: false,
            hostShareable: true,
            containsAtomic: true,
            containsArray: false,
            containsBuffer: false,
            requiredDeviceFeatures: Object.freeze([]),
            requiredLanguageFeatures: Object.freeze([]),
        })
    }
    if (type.kind === 'array') {
        const element = lowerLayoutType(type.element, `${path}[]`)
        const alignment = requireTypeAlignment(element)
        const elementStride = checkedRoundUp(
            fieldSubject(path),
            alignment,
            requireTypeByteLength(element),
            'array-stride'
        )
        return Object.freeze({
            kind: 'array',
            extent: 'fixed',
            element,
            count: type.count,
            elementStride,
            wgslType: `array<${element.wgslType}, ${type.count}>`,
            alignment,
            byteLength: checkedMultiplyLayoutSize(
                fieldSubject(path),
                elementStride,
                type.count,
                'array-size'
            ),
            constructible: element.constructible,
            hostShareable: true,
            containsAtomic: element.containsAtomic,
            containsArray: true,
            containsBuffer: false,
            requiredDeviceFeatures: element.requiredDeviceFeatures,
            requiredLanguageFeatures: element.requiredLanguageFeatures,
        })
    }
    if (type.kind === 'runtime-array') {
        const element = lowerLayoutType(type.element, `${path}[]`)
        const alignment = requireTypeAlignment(element)
        const elementStride = checkedRoundUp(
            fieldSubject(path),
            alignment,
            requireTypeByteLength(element),
            'runtime-array-stride'
        )
        return Object.freeze({
            kind: 'runtime-array',
            extent: 'runtime',
            element,
            elementStride,
            wgslType: `array<${element.wgslType}>`,
            alignment,
            fixedPrefixByteLength: 0,
            minimumBindingSize: elementStride,
            constructible: false,
            hostShareable: true,
            containsAtomic: element.containsAtomic,
            containsArray: true,
            containsBuffer: false,
            requiredDeviceFeatures: element.requiredDeviceFeatures,
            requiredLanguageFeatures: element.requiredLanguageFeatures,
        })
    }
    if (type.kind === 'struct') return lowerStructType(type, path)

    const byteGranularity: 2 | 4 = type.f16Enabled ? 2 : 4
    const fixedByteLength = type.byteLength === undefined
        ? undefined
        : requireSafeLayoutSize(
            fieldSubject(path),
            type.byteLength,
            {
                reason: 'buffer-size',
                operation: 'identity',
                value: type.byteLength,
            }
        )
    const requiredDeviceFeatures = type.f16Enabled
        ? Object.freeze([ 'shader-f16' as GPUFeatureName ])
        : Object.freeze([])
    const common = {
        kind: 'buffer' as const,
        alignment: null,
        wgslType: fixedByteLength === undefined
            ? 'buffer'
            : `buffer<${fixedByteLength}>`,
        byteGranularity,
        f16Enabled: type.f16Enabled,
        constructible: false,
        hostShareable: true as const,
        containsAtomic: false,
        containsArray: false,
        containsBuffer: true,
        requiredDeviceFeatures,
        requiredLanguageFeatures: Object.freeze([ 'buffer_view' ]),
    }
    return fixedByteLength === undefined
        ? Object.freeze({
            ...common,
            extent: 'runtime',
            fixedPrefixByteLength: 0,
            minimumBindingSize: 0,
        })
        : Object.freeze({
            ...common,
            extent: 'fixed',
            byteLength: fixedByteLength,
        })
}

function lowerStructType(
    type: LayoutCanonicalStructTypeDescriptor,
    path: string
): LayoutFixedStructTypeArtifact | LayoutRuntimeStructTypeArtifact {

    const lowered = type.fields.map(field => ({
        descriptor: field,
        type: lowerLayoutType(
            field.type,
            path === type.name ? field.name : `${path}.${field.name}`
        ),
        offset: 0,
        alignment: 1,
        byteLength: undefined as number | undefined,
    }))
    let cursor = 0
    let alignment = 1
    for (const field of lowered) {
        const fieldPath = path === type.name
            ? field.descriptor.name
            : `${path}.${field.descriptor.name}`
        const naturalAlignment = requireTypeAlignment(field.type)
        const memberAlignment = field.descriptor.align ?? naturalAlignment
        if (
            !isPowerOfTwo(memberAlignment) ||
            memberAlignment < naturalAlignment
        ) {
            throwMemberAttributeDiagnostic(fieldPath, {
                align: `power of two >= natural alignment ${naturalAlignment}`,
            }, {
                align: field.descriptor.align,
                naturalAlignment,
            })
        }
        field.alignment = memberAlignment
        alignment = Math.max(alignment, memberAlignment)
        field.offset = checkedRoundUp(
            fieldSubject(fieldPath),
            memberAlignment,
            cursor,
            'field-offset'
        )
        if (field.type.extent === 'runtime') {
            cursor = field.offset
            continue
        }
        const naturalByteLength = field.type.byteLength
        const memberByteLength = field.descriptor.size ?? naturalByteLength
        if (memberByteLength < naturalByteLength) {
            throwMemberAttributeDiagnostic(fieldPath, {
                size: `>= natural byte length ${naturalByteLength}`,
            }, {
                size: field.descriptor.size,
                naturalByteLength,
            })
        }
        field.byteLength = memberByteLength
        cursor = checkedAddLayoutSize(
            fieldSubject(fieldPath),
            field.offset,
            memberByteLength,
            'field-end'
        )
    }

    const runtime = lowered.at(-1)?.type.extent === 'runtime'
    const fixedByteLength = runtime
        ? undefined
        : checkedRoundUp(
            fieldSubject(path),
            alignment,
            cursor,
            'struct-size'
        )
    const members = Object.freeze(lowered.map((field, index) => {
        const fieldPath = path === type.name
            ? field.descriptor.name
            : `${path}.${field.descriptor.name}`
        const nextOffset = lowered[index + 1]?.offset ?? (
            fixedByteLength ?? field.offset
        )
        const byteLength = field.byteLength
        return Object.freeze({
            kind: 'LayoutField' as const,
            name: field.descriptor.name,
            path: fieldPath,
            type: field.type,
            wgslType: field.type.wgslType,
            extent: field.type.extent,
            offset: field.offset,
            alignment: field.alignment,
            naturalAlignment: requireTypeAlignment(field.type),
            ...(byteLength !== undefined ? { byteLength } : {}),
            ...(field.type.extent === 'fixed'
                ? { naturalByteLength: field.type.byteLength }
                : {}),
            padding: byteLength === undefined
                ? 0
                : Math.max(0, nextOffset - (field.offset + byteLength)),
            ...(field.descriptor.align !== undefined
                ? { explicitAlign: field.descriptor.align }
                : {}),
            ...(field.descriptor.size !== undefined
                ? { explicitSize: field.descriptor.size }
                : {}),
        })
    }))
    const requiredDeviceFeatures = unionDeviceFeatures(
        lowered.flatMap(field => field.type.requiredDeviceFeatures)
    )
    const requiredLanguageFeatures = unionStrings(
        lowered.flatMap(field => field.type.requiredLanguageFeatures)
    )
    const common = {
        kind: 'struct' as const,
        name: type.name,
        wgslType: type.name,
        members,
        alignment,
        constructible: lowered.every(field => field.type.constructible),
        hostShareable: true as const,
        containsAtomic: lowered.some(field => field.type.containsAtomic),
        containsArray: lowered.some(field => field.type.containsArray),
        containsBuffer: false,
        requiredDeviceFeatures,
        requiredLanguageFeatures,
    }
    if (fixedByteLength !== undefined) {
        return Object.freeze({
            ...common,
            extent: 'fixed',
            byteLength: fixedByteLength,
        })
    }

    const tailField = lowered.at(-1)!
    const tail = tailField.type as LayoutRuntimeArrayTypeArtifact
    const runtimeTail: LayoutRuntimeTail = Object.freeze({
        path: members.at(-1)!.path,
        offset: tailField.offset,
        elementStride: tail.elementStride,
        elementAlignment: requireTypeAlignment(tail.element),
        elementByteLength: requireTypeByteLength(tail.element),
    })
    return Object.freeze({
        ...common,
        extent: 'runtime',
        fixedPrefixByteLength: tailField.offset,
        minimumBindingSize: checkedAddLayoutSize(
            fieldSubject(runtimeTail.path),
            tailField.offset,
            tail.elementStride,
            'runtime-struct-minimum-size'
        ),
        runtimeTail,
    })
}

function computeUsageCompatibility(
    type: LayoutTypeArtifact,
    capability: LayoutCapabilityContract
): LayoutUsageCompatibility {

    const deviceFeatures = type.requiredDeviceFeatures
    const inherentLanguageFeatures = type.requiredLanguageFeatures
    const uniformReasons = uniformUsageViolations(type, capability.uniformLayout)
    const storageReasons: string[] = []
    const readbackReasons: string[] = []
    const vertexReasons = vertexUsageViolations(type)
    const immediateReasons = immediateUsageViolations(type)
    return Object.freeze({
        uniform: compatibilityFact(
            uniformReasons,
            deviceFeatures,
            unionStrings([
                ...inherentLanguageFeatures,
                ...(capability.uniformLayout === 'uniform_buffer_standard_layout'
                    ? [ 'uniform_buffer_standard_layout' ]
                    : []),
            ]),
            false
        ),
        storage: compatibilityFact(
            storageReasons,
            deviceFeatures,
            inherentLanguageFeatures,
            type.containsAtomic
        ),
        readback: compatibilityFact(
            readbackReasons,
            deviceFeatures,
            inherentLanguageFeatures,
            false
        ),
        vertex: compatibilityFact(
            vertexReasons,
            deviceFeatures,
            inherentLanguageFeatures,
            false
        ),
        immediate: compatibilityFact(
            immediateReasons,
            deviceFeatures,
            unionStrings([
                ...inherentLanguageFeatures,
                'immediate_address_space',
            ]),
            false
        ),
    })
}

function compatibilityFact(
    reasons: readonly string[],
    requiredDeviceFeatures: readonly GPUFeatureName[],
    requiredLanguageFeatures: readonly string[],
    requiresMutableStorage: boolean
): LayoutUsageCompatibilityFact {

    return Object.freeze({
        compatible: reasons.length === 0,
        requiredDeviceFeatures,
        requiredLanguageFeatures,
        reasons: Object.freeze([ ...reasons ]),
        requiresMutableStorage,
    })
}

function uniformUsageViolations(
    type: LayoutTypeArtifact,
    contract: LayoutUniformContract
): string[] {

    if (type.kind === 'buffer') {
        return type.extent === 'fixed'
            ? []
            : [ 'runtime buffer is storage-only' ]
    }
    if (!type.constructible) {
        return [ 'uniform store type must be constructible and fixed-footprint' ]
    }
    return uniformLayoutViolations(type, contract)
}

function uniformLayoutViolations(
    type: LayoutTypeArtifact,
    contract: LayoutUniformContract
): string[] {

    const reasons: string[] = []
    if (type.kind === 'array') {
        const requiredAlignment = contract === 'portable'
            ? roundUpUnchecked(16, type.alignment)
            : type.alignment
        if (type.elementStride % requiredAlignment !== 0) {
            reasons.push(
                `array stride ${type.elementStride} is not a multiple of required alignment ${requiredAlignment}`
            )
        }
        reasons.push(...uniformLayoutViolations(type.element, contract))
    } else if (type.kind === 'struct') {
        for (let index = 0; index < type.members.length; index++) {
            const member = type.members[index]
            const requiredAlignment = requiredAlignmentOf(
                member.type,
                'uniform',
                contract
            )
            if (member.offset % requiredAlignment !== 0) {
                reasons.push(
                    `${member.path} offset ${member.offset} is not a multiple of required alignment ${requiredAlignment}`
                )
            }
            reasons.push(...uniformLayoutViolations(member.type, contract))
            const next = type.members[index + 1]
            if (
                contract === 'portable' &&
                member.type.kind === 'struct' &&
                member.type.extent === 'fixed' &&
                next !== undefined &&
                next.offset - member.offset <
                    roundUpUnchecked(16, member.type.byteLength)
            ) {
                reasons.push(
                    `${member.path} does not reserve the portable uniform structure gap`
                )
            }
        }
    }
    return reasons
}

function vertexUsageViolations(type: LayoutTypeArtifact): string[] {

    if (type.extent !== 'fixed') return [ 'vertex layout must have a fixed footprint' ]
    if (type.kind === 'scalar' || type.kind === 'vector') {
        return isVertexRepresentable(type) ? [] : [ `${type.wgslType} has no direct GPUVertexFormat` ]
    }
    if (type.kind !== 'struct') {
        return [ 'vertex layout root must be a numeric scalar/vector or a flat structure' ]
    }
    const invalid = type.members.filter(member =>
        member.type.extent !== 'fixed' ||
        (
            member.type.kind !== 'scalar' &&
            member.type.kind !== 'vector'
        ) ||
        !isVertexRepresentable(
            member.type as LayoutScalarTypeArtifact | LayoutVectorTypeArtifact
        )
    )
    return invalid.map(member =>
        `${member.path} has no direct GPUVertexFormat representation`
    )
}

function immediateUsageViolations(type: LayoutTypeArtifact): string[] {

    const reasons: string[] = []
    if (type.extent !== 'fixed' || !type.constructible) {
        reasons.push('immediate store type must be constructible and fixed-footprint')
    }
    if (type.containsArray) {
        reasons.push('immediate store type must not be or contain an array')
    }
    if (type.containsAtomic || type.containsBuffer) {
        reasons.push('immediate store type must not contain atomic or buffer types')
    }
    return reasons
}

function bufferViewTargetViolations(
    type: LayoutTypeArtifact,
    addressSpace: LayoutBufferViewAddressSpace,
    contract: LayoutUniformContract
): string[] {

    if (type.containsAtomic || type.containsBuffer) {
        return [ 'buffer view target must not contain atomic or buffer types' ]
    }
    return addressSpace === 'uniform'
        ? uniformLayoutViolations(type, contract)
        : []
}

function requiredAlignmentOf(
    type: LayoutTypeArtifact,
    addressSpace: LayoutBufferViewAddressSpace,
    contract: LayoutUniformContract
): number {

    const alignment = requireTypeAlignment(type)
    if (
        addressSpace === 'uniform' &&
        contract === 'portable' &&
        (
            type.kind === 'array' ||
            type.kind === 'runtime-array' ||
            type.kind === 'struct'
        )
    ) {
        return roundUpUnchecked(16, alignment)
    }
    return alignment
}

function minTypeSizeOf(type: LayoutTypeArtifact): number {

    if (type.extent === 'fixed') return type.byteLength
    if (type.kind === 'runtime-array') return type.elementStride
    if (type.kind === 'struct') return type.minimumBindingSize
    return type.minimumBindingSize
}

function minimumBindingSizeOf(type: LayoutTypeArtifact): number {

    return type.extent === 'fixed'
        ? type.byteLength
        : type.minimumBindingSize
}

function canonicalTypeArtifact(
    type: LayoutTypeArtifact,
    includeNames: boolean
): unknown {

    const common = {
        kind: type.kind,
        extent: type.extent,
        wgslType: includeNames ? type.wgslType : undefined,
        constructible: type.constructible,
        containsAtomic: type.containsAtomic,
        containsArray: type.containsArray,
        containsBuffer: type.containsBuffer,
        requiredDeviceFeatures: type.requiredDeviceFeatures,
        requiredLanguageFeatures: type.requiredLanguageFeatures,
    }
    if (type.kind === 'scalar') {
        return {
            ...common,
            component: type.component,
            alignment: type.alignment,
            byteLength: type.byteLength,
        }
    }
    if (type.kind === 'vector') {
        return {
            ...common,
            component: type.component,
            length: type.length,
            alignment: type.alignment,
            byteLength: type.byteLength,
        }
    }
    if (type.kind === 'matrix') {
        return {
            ...common,
            component: type.component,
            columns: type.columns,
            rows: type.rows,
            columnStride: type.columnStride,
            alignment: type.alignment,
            byteLength: type.byteLength,
        }
    }
    if (type.kind === 'atomic') {
        return {
            ...common,
            component: type.component,
            alignment: type.alignment,
            byteLength: type.byteLength,
        }
    }
    if (type.kind === 'array') {
        return {
            ...common,
            element: canonicalTypeArtifact(type.element, includeNames),
            count: type.count,
            elementStride: type.elementStride,
            alignment: type.alignment,
            byteLength: type.byteLength,
        }
    }
    if (type.kind === 'runtime-array') {
        return {
            ...common,
            element: canonicalTypeArtifact(type.element, includeNames),
            elementStride: type.elementStride,
            alignment: type.alignment,
            fixedPrefixByteLength: type.fixedPrefixByteLength,
            minimumBindingSize: type.minimumBindingSize,
        }
    }
    if (type.kind === 'struct') {
        return {
            ...common,
            name: includeNames ? type.name : undefined,
            alignment: type.alignment,
            ...(type.extent === 'fixed'
                ? { byteLength: type.byteLength }
                : {
                    fixedPrefixByteLength: type.fixedPrefixByteLength,
                    minimumBindingSize: type.minimumBindingSize,
                }),
            members: type.members.map(member => ({
                name: includeNames ? member.name : undefined,
                path: includeNames ? member.path : undefined,
                type: canonicalTypeArtifact(member.type, includeNames),
                extent: member.extent,
                offset: member.offset,
                alignment: member.alignment,
                naturalAlignment: member.naturalAlignment,
                byteLength: member.byteLength,
                naturalByteLength: member.naturalByteLength,
                padding: member.padding,
                explicitAlign: member.explicitAlign,
                explicitSize: member.explicitSize,
            })),
        }
    }
    return {
        ...common,
        alignment: null,
        byteGranularity: type.byteGranularity,
        f16Enabled: type.f16Enabled,
        ...(type.extent === 'fixed'
            ? { byteLength: type.byteLength }
            : {
                fixedPrefixByteLength: type.fixedPrefixByteLength,
                minimumBindingSize: type.minimumBindingSize,
            }),
    }
}

function registerStructNames(
    type: LayoutCanonicalTypeDescriptor,
    names: Map<string, string>,
    path: string
): void {

    if (type.kind === 'struct') {
        const signature = JSON.stringify(type)
        const existing = names.get(type.name)
        if (existing !== undefined && existing !== signature) {
            throwTypeUnsupported(path, {
                structName: 'one canonical definition per WGSL name',
            }, { structName: type.name })
        }
        names.set(type.name, signature)
        for (const field of type.fields) {
            registerStructNames(field.type, names, `${path}.${field.name}`)
        }
        return
    }
    if (type.kind === 'array' || type.kind === 'runtime-array') {
        registerStructNames(type.element, names, `${path}[]`)
    }
}

function containsRuntimeType(type: LayoutCanonicalTypeDescriptor): boolean {

    if (type.kind === 'runtime-array') return true
    if (type.kind === 'struct') {
        return type.fields.some(field => containsRuntimeType(field.type))
    }
    if (type.kind === 'array') return containsRuntimeType(type.element)
    if (type.kind === 'buffer') return type.byteLength === undefined
    return false
}

function requiredF16DeviceFeatures(
    component: LayoutScalarType
): readonly GPUFeatureName[] {

    return component === 'f16'
        ? Object.freeze([ 'shader-f16' as GPUFeatureName ])
        : Object.freeze([])
}

function requiredBufferViewFeatures(
    source: LayoutArtifact,
    target: LayoutArtifact | undefined,
    addressSpace: LayoutBufferViewAddressSpace,
    pointerPath: LayoutBufferViewPointerPath
): readonly string[] {

    return unionStrings([
        ...source.requiredLanguageFeatures,
        ...(target?.requiredLanguageFeatures ?? []),
        'buffer_view',
        ...(
            addressSpace === 'uniform' &&
            target?.capabilityContract.uniformLayout ===
                'uniform_buffer_standard_layout'
                ? [ 'uniform_buffer_standard_layout' ]
                : []
        ),
        ...(pointerPath === 'function-parameter'
            ? [ 'unrestricted_pointer_parameters' ]
            : []),
    ])
}

function normalizeOptionalBufferViewInteger(
    source: LayoutArtifact,
    target: LayoutArtifact,
    name: 'byteOffset' | 'byteLength',
    value: unknown
): number | undefined {

    if (value === undefined) return undefined
    if (!isNonNegativeSafeInteger(value) || value > WGSL_U32_MAX) {
        throwBufferViewDiagnostic(source, target, {
            [name]: `non-negative integer <= ${WGSL_U32_MAX}`,
        }, { [name]: value })
    }
    return value
}

function registerBufferViewContract(
    contract: LayoutBufferViewContract
): LayoutBufferViewContract {

    layoutBufferViewContracts.add(contract)
    return contract
}

function requireLayoutArtifact(value: unknown): asserts value is LayoutArtifact {

    if (isLayoutArtifact(value)) return
    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
        unresolvedArtifactSubject(undefined),
        'Layout operation requires a Scratch LayoutArtifact.',
        { layout: 'LayoutArtifact' },
        { layout: describeValue(value) }
    )
}

function normalizeRuntimeElementCount(
    artifact: LayoutArtifact,
    value: unknown
): number {

    if (!isPositiveSafeInteger(value)) {
        throwRuntimeExtentDiagnostic(artifact, value, {
            runtimeElementCount: 'positive safe integer',
        })
    }
    return value
}

function throwRuntimeExtentDiagnostic(
    artifact: LayoutArtifact,
    actual: unknown,
    expected: unknown
): never {

    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID',
        layoutArtifactSubject(artifact),
        'Runtime-sized LayoutArtifact requires one explicit valid extent.',
        expected,
        actual
    )
}

function throwTypeUnsupported(
    path: string,
    expected: unknown,
    actual: unknown
): never {

    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_TYPE_UNSUPPORTED',
        fieldSubject(path),
        'Layout type is not a supported WGSL host-shareable type.',
        expected,
        actual
    )
}

function throwRuntimeArrayDiagnostic(
    path: string,
    expected: unknown,
    actual: unknown
): never {

    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_RUNTIME_ARRAY_INVALID',
        fieldSubject(path),
        'Runtime-sized array placement is invalid.',
        expected,
        actual
    )
}

function throwMemberAttributeDiagnostic(
    path: string,
    expected: unknown,
    actual: unknown
): never {

    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_MEMBER_ATTRIBUTE_INVALID',
        fieldSubject(path),
        'Layout member align or size attribute is invalid.',
        expected,
        actual
    )
}

function throwBufferViewDiagnostic(
    source: LayoutArtifact,
    target: LayoutArtifact | undefined,
    expected: unknown,
    actual: unknown
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID',
        severity: 'error',
        phase: 'layout-codec',
        subject: layoutArtifactSubject(source),
        related: target === undefined ? [] : [ layoutArtifactSubject(target) ],
        message: 'Layout buffer-view contract is invalid.',
        expected,
        actual,
    })
}

function throwLayoutDiagnostic(
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

function classifyUnsupportedType(value: string): string {

    if (value === 'bool') return 'non-host-shareable-bool'
    if (value.startsWith('abstract-')) return 'abstract-numeric'
    if (value.startsWith('ptr<') || value.startsWith('ref<')) return 'pointer-or-reference'
    if (
        value.startsWith('texture_') ||
        value.startsWith('sampler') ||
        value === 'texture_external'
    ) {
        return 'opaque-binding-handle'
    }
    return 'unknown'
}

function artifactSubject(spec: Pick<LayoutCanonicalSpec, 'label'>): DiagnosticSubject {

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

function requireTypeAlignment(type: LayoutTypeArtifact): number {

    if (type.alignment !== null) return type.alignment
    throw new TypeError('Nested layout type unexpectedly has no alignment.')
}

function requireTypeByteLength(type: LayoutTypeArtifact): number {

    if (type.extent === 'fixed') return type.byteLength
    throw new TypeError('Nested layout type unexpectedly has a runtime extent.')
}

function checkedAddLayoutSize(
    subject: DiagnosticSubject,
    left: number,
    right: number,
    reason: string
): number {

    return requireSafeLayoutSize(subject, left + right, {
        reason,
        operation: 'addition',
        left,
        right,
    })
}

function checkedMultiplyLayoutSize(
    subject: DiagnosticSubject,
    left: number,
    right: number,
    reason: string
): number {

    return requireSafeLayoutSize(subject, left * right, {
        reason,
        operation: 'multiplication',
        left,
        right,
    })
}

function checkedRoundUp(
    subject: DiagnosticSubject,
    alignment: number,
    value: number,
    reason: string
): number {

    return requireSafeLayoutSize(
        subject,
        roundUpUnchecked(alignment, value),
        {
            reason,
            operation: 'alignment-rounding',
            alignment,
            value,
        }
    )
}

function requireSafeLayoutSize(
    subject: DiagnosticSubject,
    result: number,
    actual: Record<string, unknown>
): number {

    if (
        Number.isSafeInteger(result) &&
        result >= 0 &&
        result <= WGSL_U32_MAX
    ) {
        return result
    }
    throwLayoutDiagnostic(
        'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
        subject,
        'Layout byte-size arithmetic exceeds the JavaScript safe-integer or WGSL u32 domain.',
        {
            result: 'non-negative safe integer layout byte size representable by WGSL u32',
            safeIntegerMax: Number.MAX_SAFE_INTEGER,
            wgslU32Max: WGSL_U32_MAX,
        },
        {
            ...actual,
            result,
            safeIntegerMax: Number.MAX_SAFE_INTEGER,
            wgslU32Max: WGSL_U32_MAX,
        }
    )
}

function roundUpUnchecked(alignment: number, value: number): number {

    return Math.ceil(value / alignment) * alignment
}

function isPowerOfTwo(value: number): boolean {

    if (!Number.isSafeInteger(value) || value <= 0) return false
    let candidate = BigInt(value)
    return (candidate & (candidate - 1n)) === 0n
}

function isLayoutUsage(value: unknown): value is LayoutCodecUsage {

    return value === 'uniform' ||
        value === 'storage' ||
        value === 'readback' ||
        value === 'vertex' ||
        value === 'immediate'
}

function isScalarType(value: unknown): value is LayoutScalarType {

    return value === 'i32' ||
        value === 'u32' ||
        value === 'f32' ||
        value === 'f16'
}

function isVectorLength(value: unknown): value is LayoutVectorLength {

    return value === 2 || value === 3 || value === 4
}

function isMatrixDimension(value: unknown): value is LayoutMatrixDimension {

    return value === 2 || value === 3 || value === 4
}

function isIdentifier(value: string): boolean {

    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function isPositiveSafeInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {

    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function vectorWgslType(
    component: LayoutScalarType,
    length: LayoutVectorLength
): string {

    const suffix = component === 'f32'
        ? 'f'
        : component === 'f16'
            ? 'h'
            : component === 'i32'
                ? 'i'
                : 'u'
    return `vec${length}${suffix}`
}

function matrixWgslType(
    component: 'f32' | 'f16',
    columns: LayoutMatrixDimension,
    rows: LayoutMatrixDimension
): string {

    return `mat${columns}x${rows}${component === 'f16' ? 'h' : 'f'}`
}

function isVertexRepresentable(
    type: LayoutScalarTypeArtifact | LayoutVectorTypeArtifact
): boolean {

    if (type.component !== 'f16') return true
    return type.kind === 'vector' && (type.length === 2 || type.length === 4)
}

function unionStrings(values: readonly string[]): readonly string[] {

    return Object.freeze([ ...new Set(values) ].sort())
}

function unionDeviceFeatures(
    values: readonly GPUFeatureName[]
): readonly GPUFeatureName[] {

    return Object.freeze(
        [ ...new Set(values) ].sort() as GPUFeatureName[]
    )
}

function fnv1a64(value: string): string {

    let hash = 0xcbf29ce484222325n
    for (let index = 0; index < value.length; index++) {
        hash ^= BigInt(value.charCodeAt(index))
        hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }
    return hash.toString(16).padStart(16, '0')
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
                return firstCanonicalDifference(
                    expected[index],
                    actual[index],
                    `${path}[${index}]`
                )
            }
        }
    }
    if (isRecord(expected) && isRecord(actual)) {
        const keys = [ ...new Set([
            ...Object.keys(expected),
            ...Object.keys(actual),
        ]) ].sort()
        for (const key of keys) {
            if (!Object.is(expected[key], actual[key])) {
                return firstCanonicalDifference(
                    expected[key],
                    actual[key],
                    `${path}.${key}`
                )
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
