import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { describeValue } from './type-utils.js'
import { programLayoutRequirementExpected, programLayoutRequirementSubject } from './program.js'
import type { BindLayout } from './binding.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { Program, ProgramBufferLayoutRequirement } from './program.js'
import type { ScratchRuntime } from './runtime.js'

export type RenderPipelineDescriptor = {
    label?: string
    program: Program
    vertex?: string
    fragment?: string
    bindLayouts?: BindLayout[]
    vertexBuffers?: GPUVertexBufferLayout[]
    targets: GPUColorTargetState[]
    primitive?: GPUPrimitiveState
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
}

export type ComputePipelineDescriptor = {
    label?: string
    program: Program
    compute?: string
    bindLayouts?: BindLayout[]
    constants?: Record<string, GPUPipelineConstantValue>
}

export interface RenderPipeline {
    runtime: ScratchRuntime
    id: string
    label?: string
    pipelineKind: 'render'
    program: Program
    vertexEntryPoint: string
    fragmentEntryPoint: string
    bindLayouts: BindLayout[]
    bindLayoutsByGroup: Map<number, BindLayout>
    vertexBuffers: GPUVertexBufferLayout[]
    targets: GPUColorTargetState[]
    targetFormats: GPUTextureFormat[]
    shaderModule: GPUShaderModule
    pipelineLayout: GPUPipelineLayout
    gpuPipeline: GPURenderPipeline
    isDisposed: boolean
}

export class RenderPipeline {

    constructor(runtime: ScratchRuntime, descriptor: RenderPipelineDescriptor = {} as RenderPipelineDescriptor) {

        runtime.assertActive()

        const program = descriptor.program
        if (!program || typeof program.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_PROGRAM_INVALID',
                severity: 'error',
                phase: 'pipeline',
                subject: { kind: 'Pipeline', pipelineKind: 'render' },
                message: 'RenderPipeline requires a Program.',
                expected: { program: 'Program' },
                actual: { program: program === undefined || program === null ? String(program) : typeof program },
            })
        }

        program.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-pipeline-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.pipelineKind = 'render'
        this.program = program
        this.vertexEntryPoint = (descriptor.vertex ?? program.entryPoints.vertex) as string
        this.fragmentEntryPoint = (descriptor.fragment ?? program.entryPoints.fragment) as string
        this.bindLayouts = normalizeBindLayouts(this, descriptor.bindLayouts)
        this.bindLayoutsByGroup = new Map(this.bindLayouts.map(layout => [ layout.group, layout ]))
        this.vertexBuffers = normalizeVertexBuffers(this, descriptor.vertexBuffers)
        this.targets = normalizeTargets(this, descriptor.targets)
        this.targetFormats = this.targets.map(target => target.format)
        this.isDisposed = false

        validateEntryPoints(this)
        validateProgramLayoutRequirements(this)

        const shaderModuleDescriptor: GPUShaderModuleDescriptor = {
            code: program.modules.join('\n'),
        }
        const shaderModuleLabel = labelWithSuffix(this.label, 'shader module')
        if (shaderModuleLabel !== undefined) shaderModuleDescriptor.label = shaderModuleLabel
        this.shaderModule = runtime.device.createShaderModule(shaderModuleDescriptor)

        const pipelineLayoutDescriptor: GPUPipelineLayoutDescriptor = {
            bindGroupLayouts: this.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        }
        const pipelineLayoutLabel = labelWithSuffix(this.label, 'layout')
        if (pipelineLayoutLabel !== undefined) pipelineLayoutDescriptor.label = pipelineLayoutLabel
        this.pipelineLayout = runtime.device.createPipelineLayout(pipelineLayoutDescriptor)

        const pipelineDescriptor: GPURenderPipelineDescriptor = {
            layout: this.pipelineLayout,
            vertex: {
                module: this.shaderModule,
                entryPoint: this.vertexEntryPoint,
                buffers: this.vertexBuffers,
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: this.fragmentEntryPoint,
                targets: this.targets,
            },
            primitive: descriptor.primitive ?? { topology: 'triangle-list' },
        }
        if (this.label !== undefined) pipelineDescriptor.label = this.label
        if (descriptor.depthStencil !== undefined) pipelineDescriptor.depthStencil = descriptor.depthStencil
        if (descriptor.multisample !== undefined) pipelineDescriptor.multisample = descriptor.multisample
        this.gpuPipeline = runtime.device.createRenderPipeline(pipelineDescriptor)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'render',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Pipeline belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_DISPOSED',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                message: 'Pipeline has been disposed.',
            })
        }

        this.runtime.assertActive()
        this.program.assertUsable()
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

export interface ComputePipeline {
    runtime: ScratchRuntime
    id: string
    label?: string
    pipelineKind: 'compute'
    program: Program
    computeEntryPoint: string
    bindLayouts: BindLayout[]
    bindLayoutsByGroup: Map<number, BindLayout>
    constants?: Record<string, GPUPipelineConstantValue>
    shaderModule: GPUShaderModule
    pipelineLayout: GPUPipelineLayout
    gpuPipeline: GPUComputePipeline
    isDisposed: boolean
}

export class ComputePipeline {

    constructor(runtime: ScratchRuntime, descriptor: ComputePipelineDescriptor = {} as ComputePipelineDescriptor) {

        runtime.assertActive()

        const program = descriptor.program
        if (!program || typeof program.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_PROGRAM_INVALID',
                severity: 'error',
                phase: 'pipeline',
                subject: { kind: 'Pipeline', pipelineKind: 'compute' },
                message: 'ComputePipeline requires a Program.',
                expected: { program: 'Program' },
                actual: { program: program === undefined || program === null ? String(program) : typeof program },
            })
        }

        program.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-pipeline-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.pipelineKind = 'compute'
        this.program = program
        this.computeEntryPoint = (descriptor.compute ?? program.entryPoints.compute) as string
        this.bindLayouts = normalizeBindLayouts(this, descriptor.bindLayouts)
        this.bindLayoutsByGroup = new Map(this.bindLayouts.map(layout => [ layout.group, layout ]))
        if (descriptor.constants !== undefined) this.constants = descriptor.constants
        this.isDisposed = false

        if (!this.computeEntryPoint) {
            throwMissingEntryPoint(this, 'compute')
        }
        validateProgramLayoutRequirements(this)

        const shaderModuleDescriptor: GPUShaderModuleDescriptor = {
            code: program.modules.join('\n'),
        }
        const shaderModuleLabel = labelWithSuffix(this.label, 'shader module')
        if (shaderModuleLabel !== undefined) shaderModuleDescriptor.label = shaderModuleLabel
        this.shaderModule = runtime.device.createShaderModule(shaderModuleDescriptor)

        const pipelineLayoutDescriptor: GPUPipelineLayoutDescriptor = {
            bindGroupLayouts: this.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        }
        const pipelineLayoutLabel = labelWithSuffix(this.label, 'layout')
        if (pipelineLayoutLabel !== undefined) pipelineLayoutDescriptor.label = pipelineLayoutLabel
        this.pipelineLayout = runtime.device.createPipelineLayout(pipelineLayoutDescriptor)

        const computeStage: GPUProgrammableStage = {
            module: this.shaderModule,
            entryPoint: this.computeEntryPoint,
        }
        if (this.constants !== undefined) computeStage.constants = this.constants

        const pipelineDescriptor: GPUComputePipelineDescriptor = {
            layout: this.pipelineLayout,
            compute: computeStage,
        }
        if (this.label !== undefined) pipelineDescriptor.label = this.label
        this.gpuPipeline = runtime.device.createComputePipeline(pipelineDescriptor)
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'compute',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime: ScratchRuntime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_WRONG_RUNTIME',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Pipeline belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_DISPOSED',
                severity: 'error',
                phase: 'pipeline',
                subject: this.subject,
                message: 'Pipeline has been disposed.',
            })
        }

        this.runtime.assertActive()
        this.program.assertUsable()
        for (const layout of this.bindLayouts) {
            layout.assertUsable()
        }
    }

    dispose(): void {

        this.isDisposed = true
    }
}

function normalizeVertexBuffers(pipeline: RenderPipeline, vertexBuffers: GPUVertexBufferLayout[] = []): GPUVertexBufferLayout[] {

    if (!Array.isArray(vertexBuffers)) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { vertexBuffers: 'GPUVertexBufferLayout[]' },
            actual: { vertexBuffers },
        })
    }

    return vertexBuffers.map((layout: GPUVertexBufferLayout, slot) => {
        if (!layout || typeof layout !== 'object') {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { layout: 'GPUVertexBufferLayout' },
                actual: { slot, layout: describeValue(layout) },
            })
        }

        if (!Number.isInteger(layout.arrayStride) || layout.arrayStride <= 0) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { arrayStride: 'positive finite number' },
                actual: { slot, arrayStride: layout.arrayStride },
            })
        }

        if (layout.stepMode !== undefined && ![ 'vertex', 'instance' ].includes(layout.stepMode)) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { stepMode: [ 'vertex', 'instance' ] },
                actual: { slot, stepMode: layout.stepMode },
            })
        }

        if (!Array.isArray(layout.attributes) || layout.attributes.length === 0) {
            throwVertexLayoutDiagnostic(pipeline, {
                expected: { attributes: 'non-empty GPUVertexAttribute[]' },
                actual: { slot, attributes: layout.attributes },
            })
        }

        const normalized: GPUVertexBufferLayout = {
            arrayStride: layout.arrayStride,
            attributes: layout.attributes.map((attribute: GPUVertexAttribute, attributeIndex: number) => normalizeVertexAttribute(
                pipeline,
                attribute,
                slot,
                attributeIndex
            )),
        }
        if (layout.stepMode !== undefined) normalized.stepMode = layout.stepMode

        return normalized
    })
}

function normalizeVertexAttribute(pipeline: RenderPipeline, attribute: GPUVertexAttribute, slot: number, attributeIndex: number): GPUVertexAttribute {

    if (!attribute || typeof attribute !== 'object') {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { attribute: 'GPUVertexAttribute' },
            actual: {
                slot,
                attributeIndex,
                attribute: describeValue(attribute),
            },
        })
    }

    if (!Number.isInteger(attribute.shaderLocation) || attribute.shaderLocation < 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { shaderLocation: 'non-negative integer' },
            actual: { slot, attributeIndex, shaderLocation: attribute.shaderLocation },
        })
    }

    if (!Number.isInteger(attribute.offset) || attribute.offset < 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { offset: 'non-negative integer' },
            actual: { slot, attributeIndex, offset: attribute.offset },
        })
    }

    if (typeof attribute.format !== 'string' || attribute.format.length === 0) {
        throwVertexLayoutDiagnostic(pipeline, {
            expected: { format: 'GPUVertexFormat' },
            actual: { slot, attributeIndex, format: attribute.format },
        })
    }

    return {
        shaderLocation: attribute.shaderLocation,
        offset: attribute.offset,
        format: attribute.format,
    }
}

function throwVertexLayoutDiagnostic(pipeline: RenderPipeline, { expected, actual }: { expected: unknown, actual: unknown }): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'pipeline',
        subject: pipeline.subject,
        related: [ pipeline.program?.subject ].filter(Boolean),
        message: 'RenderPipeline vertex buffer layout is invalid.',
        expected,
        actual,
    })
}

function normalizeBindLayouts(
    pipeline: RenderPipeline | ComputePipeline,
    bindLayouts: BindLayout[] = []
): BindLayout[] {

    if (!Array.isArray(bindLayouts)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'RenderPipeline bindLayouts must be an array.',
            expected: { bindLayouts: 'BindLayout[]' },
            actual: { bindLayouts },
        })
    }

    const groups = new Set<number>()
    return bindLayouts.map((layout: BindLayout) => {
        if (!layout || typeof layout.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline bindLayouts must contain BindLayout objects.',
                expected: { bindLayout: 'BindLayout' },
                actual: { bindLayout: describeValue(layout) },
            })
        }

        layout.assertRuntime(pipeline.runtime)

        if (groups.has(layout.group)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                related: [ layout.subject ],
                message: 'RenderPipeline cannot use more than one BindLayout for the same group.',
                expected: { group: 'unique' },
                actual: { group: layout.group },
            })
        }
        groups.add(layout.group)

        return layout
    })
}

function normalizeTargets(pipeline: RenderPipeline, targets: GPUColorTargetState[]): GPUColorTargetState[] {

    if (!Array.isArray(targets) || targets.length === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
            severity: 'error',
            phase: 'pipeline',
            subject: pipeline.subject,
            message: 'RenderPipeline requires at least one color target format.',
            expected: { targets: 'non-empty array' },
            actual: { targets },
        })
    }

    return targets.map((target) => {
        if (!target || typeof target.format !== 'string') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline target requires a texture format.',
                expected: { format: 'GPUTextureFormat' },
                actual: { target },
            })
        }

        return { ...target }
    })
}

function validateProgramLayoutRequirements(pipeline: RenderPipeline | ComputePipeline): void {

    for (const requirement of pipeline.program.layoutRequirements) {
        const bindLayout = pipeline.bindLayoutsByGroup.get(requirement.group)
        if (bindLayout === undefined) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [ pipeline.program.subject, pipeline.subject ],
                actual: { group: undefined },
            })
        }

        const entry = bindLayout.entries.find(candidate => candidate.binding === requirement.binding)
        if (entry === undefined) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                ],
                actual: {
                    group: bindLayout.group,
                    bindings: bindLayout.entries.map(candidate => candidate.binding),
                },
            })
        }

        if (requirement.name !== undefined && entry.name !== requirement.name) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { name: entry.name },
            })
        }

        if (entry.type !== requirement.type) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { type: entry.type },
            })
        }

        if (requirement.visibility !== undefined && !requirement.visibility.every(stage => entry.visibility.includes(stage))) {
            throwProgramLayoutMismatch(pipeline, requirement, {
                related: [
                    pipeline.program.subject,
                    pipeline.subject,
                    bindLayout.subject,
                    bindLayout.entrySubject(entry),
                ],
                actual: { visibility: entry.visibility },
            })
        }
    }
}

function throwProgramLayoutMismatch(
    pipeline: RenderPipeline | ComputePipeline,
    requirement: ProgramBufferLayoutRequirement,
    details: {
        actual: unknown
        related: DiagnosticSubject[]
    }
): never {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH',
        severity: 'error',
        phase: 'program',
        subject: programLayoutRequirementSubject(requirement),
        related: details.related,
        message: 'Pipeline bind layouts do not satisfy Program buffer layout requirements.',
        expected: programLayoutRequirementExpected(requirement),
        actual: details.actual,
    })
}

function validateEntryPoints(pipeline: RenderPipeline) {

    if (!pipeline.vertexEntryPoint) {
        throwMissingEntryPoint(pipeline, 'vertex')
    }

    if (!pipeline.fragmentEntryPoint) {
        throwMissingEntryPoint(pipeline, 'fragment')
    }
}

function throwMissingEntryPoint(pipeline: RenderPipeline | ComputePipeline, stage: 'vertex' | 'fragment' | 'compute') {

    throwScratchDiagnostic({
        code: 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING',
        severity: 'error',
        phase: 'program',
        subject: {
            kind: 'ShaderEntryPoint',
            programId: pipeline.program.id,
            name: '',
            stage,
        },
        related: [ pipeline.program.subject, pipeline.subject ],
        message: 'RenderPipeline requires a Program entry point for each shader stage.',
        expected: { stage, entryPoint: 'string' },
        actual: { entryPoint: undefined },
    })
}

function labelWithSuffix(label: string | undefined, suffix: string) {

    return label === undefined ? undefined : `${label} ${suffix}`
}
