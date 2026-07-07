import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'

export class RenderPipeline {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.pipelineKind = 'render'
        this.program = program
        this.vertexEntryPoint = descriptor.vertex ?? program.entryPoints.vertex
        this.fragmentEntryPoint = descriptor.fragment ?? program.entryPoints.fragment
        this.bindLayouts = normalizeBindLayouts(this, descriptor.bindLayouts)
        this.bindLayoutsByGroup = new Map(this.bindLayouts.map(layout => [ layout.group, layout ]))
        this.targets = normalizeTargets(this, descriptor.targets)
        this.targetFormats = this.targets.map(target => target.format)
        this.isDisposed = false

        validateEntryPoints(this)

        this.shaderModule = runtime.device.createShaderModule({
            label: labelWithSuffix(this.label, 'shader module'),
            code: program.modules.join('\n'),
        })
        this.pipelineLayout = runtime.device.createPipelineLayout({
            label: labelWithSuffix(this.label, 'layout'),
            bindGroupLayouts: this.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        })
        this.gpuPipeline = runtime.device.createRenderPipeline({
            label: this.label,
            layout: this.pipelineLayout,
            vertex: {
                module: this.shaderModule,
                entryPoint: this.vertexEntryPoint,
                buffers: [],
            },
            fragment: {
                module: this.shaderModule,
                entryPoint: this.fragmentEntryPoint,
                targets: this.targets,
            },
            primitive: descriptor.primitive ?? { topology: 'triangle-list' },
            ...(descriptor.depthStencil !== undefined ? { depthStencil: descriptor.depthStencil } : {}),
            ...(descriptor.multisample !== undefined ? { multisample: descriptor.multisample } : {}),
        })
    }

    get subject() {

        const subject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'render',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    dispose() {

        this.isDisposed = true
    }
}

export class ComputePipeline {

    constructor(runtime, descriptor = {}) {

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
        this.label = descriptor.label
        this.pipelineKind = 'compute'
        this.program = program
        this.computeEntryPoint = descriptor.compute ?? program.entryPoints.compute
        this.bindLayouts = normalizeBindLayouts(this, descriptor.bindLayouts)
        this.bindLayoutsByGroup = new Map(this.bindLayouts.map(layout => [ layout.group, layout ]))
        this.constants = descriptor.constants
        this.isDisposed = false

        if (!this.computeEntryPoint) {
            throwMissingEntryPoint(this, 'compute')
        }

        this.shaderModule = runtime.device.createShaderModule({
            label: labelWithSuffix(this.label, 'shader module'),
            code: program.modules.join('\n'),
        })
        this.pipelineLayout = runtime.device.createPipelineLayout({
            label: labelWithSuffix(this.label, 'layout'),
            bindGroupLayouts: this.bindLayouts.map(layout => layout.gpuBindGroupLayout),
        })
        this.gpuPipeline = runtime.device.createComputePipeline({
            label: this.label,
            layout: this.pipelineLayout,
            compute: {
                module: this.shaderModule,
                entryPoint: this.computeEntryPoint,
                ...(this.constants !== undefined ? { constants: this.constants } : {}),
            },
        })
    }

    get subject() {

        const subject = {
            kind: 'Pipeline',
            id: this.id,
            pipelineKind: 'compute',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

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

    dispose() {

        this.isDisposed = true
    }
}

function normalizeBindLayouts(pipeline, bindLayouts = []) {

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

    const groups = new Set()
    return bindLayouts.map((layout) => {
        if (!layout || typeof layout.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE',
                severity: 'error',
                phase: 'pipeline',
                subject: pipeline.subject,
                message: 'RenderPipeline bindLayouts must contain BindLayout objects.',
                expected: { bindLayout: 'BindLayout' },
                actual: { bindLayout: layout === undefined || layout === null ? String(layout) : typeof layout },
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

function normalizeTargets(pipeline, targets) {

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

function validateEntryPoints(pipeline) {

    if (!pipeline.vertexEntryPoint) {
        throwMissingEntryPoint(pipeline, 'vertex')
    }

    if (!pipeline.fragmentEntryPoint) {
        throwMissingEntryPoint(pipeline, 'fragment')
    }
}

function throwMissingEntryPoint(pipeline, stage) {

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

function labelWithSuffix(label, suffix) {

    return label === undefined ? undefined : `${label} ${suffix}`
}
