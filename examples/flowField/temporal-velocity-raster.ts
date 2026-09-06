import {
    webMercatorVirtualRasterWgslModule,
} from 'geoscratch/geo'
import type {
    WebMercatorVirtualRasterField,
} from 'geoscratch/geo'
import {
    flowPixelCenterRegistrationWgslModule,
} from './flow-pixel-center-registration.ts'

export type TemporalVelocityWgslOptions = Readonly<{
    group: number
    currentPageTableBinding: number
    currentAtlasBinding: number
    nextPageTableBinding: number
    nextAtlasBinding: number
    wrapper: string
    transitionTexels?: number
    sampleRegistration?: 'global-texel-lattice' | 'pixel-center'
    activitySupport?: 'bilinear' | 'nearest-texel-zero'
}>

export type TemporalVelocityWgslModule = Readonly<{
    kind: 'temporal-velocity-wgsl-module'
    sampleRegistration: 'global-texel-lattice' | 'pixel-center'
    activitySupport: 'bilinear' | 'nearest-texel-zero'
    code: string
    bindings: Readonly<{
        group: number
        current: Readonly<{ pageTable: number, atlas: number }>
        next: Readonly<{ pageTable: number, atlas: number }>
    }>
}>

/** Generates two public WebMercator samplers plus the example-local temporal wrapper. */
export function temporalVelocityWgslModule(
    current: WebMercatorVirtualRasterField,
    next: WebMercatorVirtualRasterField,
    options: TemporalVelocityWgslOptions
): TemporalVelocityWgslModule {

    assertCompatibleModels(current, next)
    const sampleRegistration = options?.sampleRegistration ?? 'global-texel-lattice'
    const activitySupport = options?.activitySupport ?? 'bilinear'
    if ((activitySupport !== 'bilinear' && activitySupport !== 'nearest-texel-zero') ||
        (activitySupport === 'nearest-texel-zero' && sampleRegistration !== 'pixel-center')) {
        throw new TypeError('Flow activity support requires bilinear or pixel-center nearest-texel-zero')
    }
    if (sampleRegistration !== 'global-texel-lattice' &&
        sampleRegistration !== 'pixel-center') {
        throw new TypeError(
            'Temporal velocity WGSL sampleRegistration must be global-texel-lattice or pixel-center'
        )
    }
    const bindings = [
        options?.currentPageTableBinding,
        options?.currentAtlasBinding,
        options?.nextPageTableBinding,
        options?.nextAtlasBinding,
    ]
    if (!Number.isSafeInteger(options?.group) || options.group < 0 ||
        bindings.some(value => !Number.isSafeInteger(value) || Number(value) < 0) ||
        new Set(bindings).size !== bindings.length || typeof options.wrapper !== 'string' ||
        !options.wrapper.includes('fn FlowVelocity_sample(')) {
        throw new TypeError('Temporal velocity WGSL requires distinct bindings and its sample wrapper')
    }
    const addressNamespace = 'FlowVelocityAddress'
    const sharedAddress = current.addressCodec.wgslModule({ namespace: addressNamespace })
    const registrationNamespace = 'FlowVelocityRegistration'
    const currentSamplerNamespace = 'FlowVelocityCurrent'
    const nextSamplerNamespace = 'FlowVelocityNext'
    const registration = sampleRegistration === 'pixel-center'
        ? flowPixelCenterRegistrationWgslModule(current, {
            namespace: registrationNamespace,
            addressNamespace,
            currentSamplerNamespace,
            nextSamplerNamespace,
        }).code
        : flowGlobalTexelRegistrationWgsl(
            registrationNamespace,
            `${addressNamespace}Fixed`,
            currentSamplerNamespace,
            nextSamplerNamespace,
        )
    const currentModule = webMercatorVirtualRasterWgslModule(current, {
        namespace: currentSamplerNamespace,
        addressNamespace,
        group: options.group,
        pageTableBinding: options.currentPageTableBinding,
        atlasBinding: options.currentAtlasBinding,
        ...(options.transitionTexels === undefined
            ? {}
            : { transitionTexels: options.transitionTexels }),
    })
    const nextModule = webMercatorVirtualRasterWgslModule(next, {
        namespace: nextSamplerNamespace,
        addressNamespace,
        group: options.group,
        pageTableBinding: options.nextPageTableBinding,
        atlasBinding: options.nextAtlasBinding,
        ...(options.transitionTexels === undefined
            ? {}
            : { transitionTexels: options.transitionTexels }),
    })
    const prefix = sharedAddress + '\n\n'
    if (!currentModule.code.startsWith(prefix) || !nextModule.code.startsWith(prefix)) {
        throw new TypeError('Temporal velocity models do not share one public address module')
    }
    return Object.freeze({
        kind: 'temporal-velocity-wgsl-module',
        sampleRegistration,
        activitySupport,
        code: [
            sharedAddress,
            currentModule.code.slice(prefix.length),
            nextModule.code.slice(prefix.length),
            registration,
            flowVelocitySourceBoundsWgsl(current),
            `const FlowVelocity_nearest_zero_gate = ${activitySupport === 'nearest-texel-zero'};`,
            flowSpawnSupportWgsl(),
            options.wrapper,
        ].join('\n\n'),
        bindings: Object.freeze({
            group: options.group,
            current: Object.freeze({
                pageTable: options.currentPageTableBinding,
                atlas: options.currentAtlasBinding,
            }),
            next: Object.freeze({
                pageTable: options.nextPageTableBinding,
                atlas: options.nextAtlasBinding,
            }),
        }),
    })
}

function flowSpawnSupportWgsl(): string {
    return `fn FlowVelocity_spawn_possible(position: FlowVelocityAddressFixedPosition, level: u32) -> bool {
    if (level >= FlowVelocityCurrent_level_count || !FlowVelocity_source_contains(position)) { return false; }
    let current = FlowVelocityCurrent_load_position(position, level);
    let next = FlowVelocityNext_load_position(position, level);
    if (current.status == 4u || next.status == 4u) { return false; }
    if (current.status != 1u || next.status != 1u) { return true; }
    return any(current.value.xy != vec2f(0.0)) || any(next.value.xy != vec2f(0.0));
}`
}

function flowGlobalTexelRegistrationWgsl(
    namespace: string,
    fixedNamespace: string,
    currentSamplerNamespace: string,
    nextSamplerNamespace: string,
): string {

    return `fn ${namespace}_position(
    position: ${fixedNamespace}Position,
    _level: u32,
) -> ${fixedNamespace}Position {
    return position;
}

fn ${namespace}_sample_current(
    position: ${fixedNamespace}Position,
    level: u32,
) -> ${currentSamplerNamespace}Sample {
    return ${currentSamplerNamespace}_sample_compute(position, level);
}

fn ${namespace}_sample_next(
    position: ${fixedNamespace}Position,
    level: u32,
) -> ${nextSamplerNamespace}Sample {
    return ${nextSamplerNamespace}_sample_compute(position, level);
}`
}

function flowVelocitySourceBoundsWgsl(model: WebMercatorVirtualRasterField): string {

    const [ west, south, east, north ] = model.geographicBounds
    const northwest = model.addressCodec.fromLonLat([ west, north ]).fixed.limbs
    const southeast = model.addressCodec.fromLonLat([ east, south ]).fixed.limbs
    const axis = (value: Readonly<{ low: number, high: number }>) =>
        `FlowVelocityAddressFixedAxis(${value.low}u, ${value.high}u)`
    return `const FlowVelocity_source_west = ${axis(northwest[0]!)};
const FlowVelocity_source_north = ${axis(northwest[1]!)};
const FlowVelocity_source_east = ${axis(southeast[0]!)};
const FlowVelocity_source_south = ${axis(southeast[1]!)};

fn FlowVelocity_axis_less(
    left: FlowVelocityAddressFixedAxis,
    right: FlowVelocityAddressFixedAxis,
) -> bool {
    return left.high < right.high || (left.high == right.high && left.low < right.low);
}

fn FlowVelocity_source_contains(position: FlowVelocityAddressFixedPosition) -> bool {
    return !FlowVelocity_axis_less(position.axes[0], FlowVelocity_source_west) &&
        !FlowVelocity_axis_less(FlowVelocity_source_east, position.axes[0]) &&
        !FlowVelocity_axis_less(position.axes[1], FlowVelocity_source_north) &&
        !FlowVelocity_axis_less(FlowVelocity_source_south, position.axes[1]);
}`
}

function assertCompatibleModels(
    current: WebMercatorVirtualRasterField,
    next: WebMercatorVirtualRasterField
): void {

    const currentLimits = current?.coverage?.limits
    const nextLimits = next?.coverage?.limits
    if (current?.kind !== 'web-mercator-virtual-raster-field' ||
        next?.kind !== 'web-mercator-virtual-raster-field' ||
        current.plane.fieldKind !== 'vector' || next.plane.fieldKind !== 'vector' ||
        current.plane.channels !== 2 || next.plane.channels !== 2 ||
        current.plane.sampleType !== 'float32' || next.plane.sampleType !== 'float32' ||
        current.plane.gpuFormat !== 'rg32float' || next.plane.gpuFormat !== 'rg32float' ||
        current.plane.noData !== undefined || next.plane.noData !== undefined ||
        current.addressCodec.coordinateBits !== next.addressCodec.coordinateBits ||
        JSON.stringify(current.geographicBounds) !== JSON.stringify(next.geographicBounds) ||
        JSON.stringify(currentLimits) !== JSON.stringify(nextLimits)) {
        throw new TypeError('Temporal velocity WGSL requires compatible two-channel time models')
    }
}
