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
            bindGroupLayouts: [],
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
    }

    dispose() {

        this.isDisposed = true
    }
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
