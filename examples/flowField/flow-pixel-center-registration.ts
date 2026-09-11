import type { WebMercatorVirtualRasterField } from 'geoscratch/geo'

export type FlowPixelCenterRegistrationLevel = Readonly<{
    level: number
    matrixId: string
    halfTexelQuanta: Readonly<{ low: number, high: number }>
}>

export type FlowPixelCenterRegistrationWgslModule = Readonly<{
    kind: 'flow-pixel-center-registration-wgsl-module'
    namespace: string
    addressNamespace: string
    positionFunction: string
    currentSampleFunction: string
    nextSampleFunction: string
    levels: readonly FlowPixelCenterRegistrationLevel[]
    code: string
}>

export type FlowPixelCenterRegistrationWgslOptions = Readonly<{
    namespace?: string
    addressNamespace: string
    currentSamplerNamespace: string
    nextSamplerNamespace: string
}>

const WGSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const U32_MASK = 0xffff_ffffn

/** Generates exact half-texel registration and reuses each no-NoData footprint load for readiness and interpolation. */
export function flowPixelCenterRegistrationWgslModule(
    model: WebMercatorVirtualRasterField,
    options: FlowPixelCenterRegistrationWgslOptions
): FlowPixelCenterRegistrationWgslModule {

    if (model?.kind !== 'web-mercator-virtual-raster-field' ||
        model.addressSpace?.pageSize[0] !== 256 || model.addressSpace.pageSize[1] !== 256 ||
        model.plane.noData !== undefined) {
        throw new TypeError(
            'Flow pixel-center registration requires one 256-texel WebMercator Virtual Raster ' +
            'without a NoData sentinel'
        )
    }
    const namespace = normalizeNamespace(options?.namespace, 'FlowPixelCenterRegistration')
    const addressNamespace = normalizeNamespace(options?.addressNamespace)
    const currentSamplerNamespace = normalizeNamespace(options?.currentSamplerNamespace)
    const nextSamplerNamespace = normalizeNamespace(options?.nextSamplerNamespace)
    const coordinateBits = model.addressCodec.coordinateBits
    const levels = Array.from(
        { length: model.addressSpace.levelCount },
        (_value, level): FlowPixelCenterRegistrationLevel => {
            const matrixId = model.addressSpace.matrixId(level)
            const matrix = Number(matrixId)
            if (!Number.isSafeInteger(matrix) || String(matrix) !== matrixId) {
                throw new TypeError('Flow pixel-center registration requires numeric matrix ids')
            }
            const halfTexelShift = coordinateBits - matrix - 9
            if (halfTexelShift < 0) {
                throw new RangeError(
                    `Flow pixel-center registration at matrix ${matrixId} requires at least ` +
                    `${matrix + 9} coordinate bits`
                )
            }
            const halfTexelQuanta = 1n << BigInt(halfTexelShift)
            return Object.freeze({
                level,
                matrixId,
                halfTexelQuanta: Object.freeze({
                    low: Number(halfTexelQuanta & U32_MASK),
                    high: Number((halfTexelQuanta >> 32n) & U32_MASK),
                }),
            })
        }
    )
    const fixedNamespace = `${addressNamespace}Fixed`
    const positionFunction = `${namespace}_position`
    const currentSampleFunction = `${namespace}_sample_current`
    const nextSampleFunction = `${namespace}_sample_next`
    const code = `fn ${namespace}_axis_less(
    left: ${fixedNamespace}Axis,
    right: ${fixedNamespace}Axis,
) -> bool {
    return left.high < right.high || (left.high == right.high && left.low < right.low);
}

fn ${namespace}_subtract_clamped(
    value: ${fixedNamespace}Axis,
    delta: ${fixedNamespace}Axis,
) -> ${fixedNamespace}Axis {
    if (${namespace}_axis_less(value, delta)) {
        return ${fixedNamespace}Axis(0u, 0u);
    }
    return ${fixedNamespace}_subtract_axis(value, delta);
}

fn ${positionFunction}(
    position: ${fixedNamespace}Position,
    level: u32,
) -> ${fixedNamespace}Position {
    let half = ${currentSamplerNamespace}_half_texel_at(level);
    let half_texel = ${fixedNamespace}Axis(half.x, half.y);
    var registered = position;
    registered.axes[0] = ${namespace}_subtract_clamped(position.axes[0], half_texel);
    registered.axes[1] = ${namespace}_subtract_clamped(position.axes[1], half_texel);
    return registered;
}

${registeredSamplerWgsl(
        namespace,
        'current',
        currentSamplerNamespace,
        addressNamespace,
    )}

${registeredSamplerWgsl(
        namespace,
        'next',
        nextSamplerNamespace,
        addressNamespace,
    )}`
    return Object.freeze({
        kind: 'flow-pixel-center-registration-wgsl-module',
        namespace,
        addressNamespace,
        positionFunction,
        currentSampleFunction,
        nextSampleFunction,
        levels: Object.freeze(levels),
        code,
    })
}

function registeredSamplerWgsl(
    namespace: string,
    slot: 'current' | 'next',
    samplerNamespace: string,
    addressNamespace: string
): string {

    return `fn ${namespace}_sample_${slot}(
    position: ${addressNamespace}FixedPosition,
    level: u32,
) -> ${samplerNamespace}Sample {
    let address = ${addressNamespace}_address(position, ${samplerNamespace}_matrix_at(level));
    let base = vec2i(address.tile * ${samplerNamespace}_page_size_value() + address.texel);
    // The factory forbids a payload NoData sentinel. These loaded samples carry
    // the same metadata statuses as resolution_global, plus reusable values.
    let tl = ${samplerNamespace}_load_global(base, level);
    let tr = ${samplerNamespace}_load_global(base + vec2i(1, 0), level);
    let bl = ${samplerNamespace}_load_global(base + vec2i(0, 1), level);
    let br = ${samplerNamespace}_load_global(base + vec2i(1, 1), level);
    if (tl.status == 4u || tr.status == 4u || bl.status == 4u || br.status == 4u) {
        return ${samplerNamespace}_failed(level);
    }
    if (tl.status == 0u || tr.status == 0u || bl.status == 0u || br.status == 0u) {
        return ${samplerNamespace}_missing(level);
    }
    if (tl.status == 3u || tr.status == 3u || bl.status == 3u || br.status == 3u) {
        return ${samplerNamespace}Sample(vec4f(0.0), 3u, level, level);
    }
    let resolved_level = max(max(tl.resolved_level, tr.resolved_level), max(bl.resolved_level, br.resolved_level));
    if (resolved_level < level || resolved_level >= ${samplerNamespace}_level_count_value()) {
        return ${samplerNamespace}_failed(level);
    }
    if (resolved_level > level) {
        return ${samplerNamespace}Sample(vec4f(0.0), 2u, level, resolved_level);
    }
    if (level + 1u < ${samplerNamespace}_level_count_value() &&
        ${samplerNamespace}_edge_blend_weight(position, level) < 1.0f) {
        return ${samplerNamespace}Sample(vec4f(0.0), 2u, level, level + 1u);
    }
    // Fallback is a signal to the temporal owner: it must re-register the
    // original canonical position at the new shared level, not this position.
    let value = mix(mix(tl.value, tr.value, address.sub_texel.x),
        mix(bl.value, br.value, address.sub_texel.x), address.sub_texel.y);
    return ${samplerNamespace}Sample(value, max(max(tl.status, tr.status), max(bl.status, br.status)), level, level);
}`
}

function normalizeNamespace(value: string | undefined, fallback?: string): string {

    const namespace = value ?? fallback
    if (namespace === undefined || !WGSL_IDENTIFIER.test(namespace)) {
        throw new TypeError('Flow pixel-center WGSL namespaces must be identifiers')
    }
    return namespace
}
