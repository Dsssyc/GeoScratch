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

/** Generates an exact wide-fixed half-texel registration adapter for each actual raster level. */
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
    const offsets = levels.map(({ halfTexelQuanta }) =>
        `${fixedNamespace}Axis(${halfTexelQuanta.low}u, ${halfTexelQuanta.high}u)`
    ).join(', ')
    const code = `const ${namespace}_half_texel = array<${fixedNamespace}Axis, ` +
        `${levels.length}>(${offsets});

fn ${namespace}_axis_less(
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
    let half_texel = ${namespace}_half_texel[level];
    var registered = position;
    registered.axes[0] = ${namespace}_subtract_clamped(position.axes[0], half_texel);
    registered.axes[1] = ${namespace}_subtract_clamped(position.axes[1], half_texel);
    return registered;
}

${resolutionPreflightWgsl(namespace, 'current', currentSamplerNamespace, addressNamespace)}

${resolutionPreflightWgsl(namespace, 'next', nextSamplerNamespace, addressNamespace)}

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
    let resolution = ${namespace}_${slot}_resolution(position, level);
    if (resolution.x == 4u) { return ${samplerNamespace}_failed(level); }
    if (resolution.x == 0u) { return ${samplerNamespace}_missing(level); }
    if (resolution.x == 3u) {
        return ${samplerNamespace}Sample(vec4f(0.0), 3u, level, level);
    }
    if (resolution.y < level || resolution.y >= ${samplerNamespace}_level_count) {
        return ${samplerNamespace}_failed(level);
    }
    if (resolution.y > level) {
        return ${samplerNamespace}Sample(vec4f(0.0), 2u, level, resolution.y);
    }
    if (level + 1u < ${samplerNamespace}_level_count &&
        ${samplerNamespace}_edge_blend_weight(position, level) < 1.0f) {
        return ${samplerNamespace}Sample(vec4f(0.0), 2u, level, level + 1u);
    }
    return ${samplerNamespace}_sample_level(position, level);
}`
}

function resolutionPreflightWgsl(
    namespace: string,
    slot: 'current' | 'next',
    samplerNamespace: string,
    addressNamespace: string
): string {

    return `fn ${namespace}_${slot}_resolution(
    position: ${addressNamespace}FixedPosition,
    level: u32,
) -> vec2u {
    let address = ${addressNamespace}_address(position, ${samplerNamespace}_matrix[level]);
    let base = vec2i(address.tile * ${samplerNamespace}_page_size + address.texel);
    let tl = ${samplerNamespace}_resolution_global(base, level);
    let tr = ${samplerNamespace}_resolution_global(base + vec2i(1, 0), level);
    let bl = ${samplerNamespace}_resolution_global(base + vec2i(0, 1), level);
    let br = ${samplerNamespace}_resolution_global(base + vec2i(1, 1), level);
    if (tl.x == 4u || tr.x == 4u || bl.x == 4u || br.x == 4u) {
        return vec2u(4u, level);
    }
    if (tl.x == 0u || tr.x == 0u || bl.x == 0u || br.x == 0u) {
        return vec2u(0u, level);
    }
    if (tl.x == 3u || tr.x == 3u || bl.x == 3u || br.x == 3u) {
        return vec2u(3u, level);
    }
    return vec2u(
        max(max(tl.x, tr.x), max(bl.x, br.x)),
        max(max(tl.y, tr.y), max(bl.y, br.y)),
    );
}`
}

function normalizeNamespace(value: string | undefined, fallback?: string): string {

    const namespace = value ?? fallback
    if (namespace === undefined || !WGSL_IDENTIFIER.test(namespace)) {
        throw new TypeError('Flow pixel-center WGSL namespaces must be identifiers')
    }
    return namespace
}
