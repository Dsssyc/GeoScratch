import { createTestProgram } from './scratch-test-utils.js'
import { expect } from 'chai'
import {
    ScratchRuntime,
    inspectShader,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

function bindingFacts(binding) {

    const facts = {
        group: binding.group,
        binding: binding.binding,
        name: binding.name,
        type: binding.type,
        moduleIndex: binding.moduleIndex,
    }
    if (binding.inconclusive !== undefined) facts.inconclusive = binding.inconclusive

    return facts
}

function createBindLayout(runtime, entries, group = 0) {

    return runtime.createBindLayout({
        group,
        entries,
    })
}

function expectReportEmpty(report) {

    expect(report).to.deep.equal({
        version: 1,
        diagnostics: [],
        hasErrors: false,
        errorCount: 0,
        warningCount: 0,
    })
}

function expectSingleDiagnostic(report, include) {

    expect(report).to.include({
        version: 1,
        hasErrors: false,
        errorCount: 0,
        warningCount: 1,
    })
    expect(report.diagnostics).to.have.length(1)
    expect(report.diagnostics[0]).to.include(include)

    return report.diagnostics[0]
}

describe('scratch shader inspection', () => {

    it('extracts uniform buffer bindings', () => {

        const inspection = inspectShader(`
            struct Uniforms { value: vec4f }
            @group(0) @binding(1) var<uniform> uniforms: Uniforms;
        `)

        expect(inspection.modules).to.have.length(1)
        expect(inspection.diagnostics).to.deep.equal([])
        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 1,
                name: 'uniforms',
                type: 'uniform',
                moduleIndex: 0,
            },
        ])
        expect(inspection.bindings[0].source).to.include('var<uniform> uniforms')
    })

    it('extracts read-only storage buffer bindings', () => {

        const inspection = inspectShader(`
            @group(0) @binding(0) var<storage, read> inputValues: array<f32>;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'inputValues',
                type: 'read-storage',
                moduleIndex: 0,
            },
        ])
    })

    it('extracts writable storage buffer bindings', () => {

        const inspection = inspectShader(`
            @group(0) @binding(0) var<storage, read_write> outputValues: array<f32>;
            @group(0) @binding(1) var<storage> defaultWriteValues: array<f32>;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'outputValues',
                type: 'storage',
                moduleIndex: 0,
            },
            {
                group: 0,
                binding: 1,
                name: 'defaultWriteValues',
                type: 'storage',
                moduleIndex: 0,
            },
        ])
    })

    it('extracts sampled texture bindings', () => {

        const inspection = inspectShader(`
            @group(2) @binding(0) var colorTexture: texture_2d<f32>;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 2,
                binding: 0,
                name: 'colorTexture',
                type: 'texture',
                moduleIndex: 0,
            },
        ])
    })

    it('extracts sampler bindings', () => {

        const inspection = inspectShader(`
            @group(2) @binding(1) var colorSampler: sampler;
            @group(2) @binding(2) var shadowSampler: sampler_comparison;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 2,
                binding: 1,
                name: 'colorSampler',
                type: 'sampler',
                moduleIndex: 0,
            },
            {
                group: 2,
                binding: 2,
                name: 'shadowSampler',
                type: 'sampler',
                moduleIndex: 0,
            },
        ])
    })

    it('accepts binding and group attributes in either order', () => {

        const inspection = inspectShader(`
            @binding(3) @group(1) var<uniform> camera: Camera;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 1,
                binding: 3,
                name: 'camera',
                type: 'uniform',
                moduleIndex: 0,
            },
        ])
    })

    it('ignores binding declarations inside comments', () => {

        const inspection = inspectShader(`
            // @group(9) @binding(9) var<uniform> commentedLine: Camera;
            /*
             @group(8) @binding(8) var<storage, read> commentedBlock: array<f32>;
            */
            @group(0) @binding(0) var<uniform> camera: Camera;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'camera',
                type: 'uniform',
                moduleIndex: 0,
            },
        ])
    })

    it('preserves module index for multiple modules', () => {

        const inspection = inspectShader([
            '@group(0) @binding(0) var<uniform> camera: Camera;',
            '@group(1) @binding(0) var<storage, read> values: array<f32>;',
        ])

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'camera',
                type: 'uniform',
                moduleIndex: 0,
            },
            {
                group: 1,
                binding: 0,
                name: 'values',
                type: 'read-storage',
                moduleIndex: 1,
            },
        ])
    })

    it('returns an empty report when shader bindings match explicit bind entries', async() => {

        const { runtime } = await createRuntimeFixture()
        const inspection = inspectShader(`
            @group(0) @binding(0) var<uniform> camera: Camera;
            @group(0) @binding(1) var<storage, read> values: array<f32>;
            @group(0) @binding(2) var colorTexture: texture_2d<f32>;
            @group(0) @binding(3) var colorSampler: sampler;
        `)
        const bindLayout = await createBindLayout(runtime, [
            { binding: 0, name: 'camera', type: 'uniform', visibility: [ 'vertex' ] },
            { binding: 1, name: 'values', type: 'read-storage', visibility: [ 'compute' ] },
            { binding: 2, name: 'colorTexture', type: 'texture', visibility: [ 'fragment' ] },
            { binding: 3, name: 'colorSampler', type: 'sampler', visibility: [ 'fragment' ] },
        ])

        expectReportEmpty(inspection.compareBindLayouts([ bindLayout ]))
    })

    it('reports a shader binding that is missing from explicit bind entries', () => {

        const inspection = inspectShader(`
            @group(0) @binding(0) var<uniform> camera: Camera;
        `)
        const diagnostic = expectSingleDiagnostic(inspection.compareBindLayouts([]), {
            code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
            severity: 'warn',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'ShaderBinding',
            group: 0,
            binding: 0,
            name: 'camera',
        })
        expect(diagnostic.related).to.deep.equal([])
        expect(diagnostic.expected).to.deep.equal({
            source: 'WGSLReflection',
            group: 0,
            binding: 0,
            type: 'uniform',
        })
        expect(diagnostic.actual).to.deep.equal({
            source: 'BindLayout',
            present: false,
        })
    })

    it('reports an explicit bind entry that is missing from shader bindings', async() => {

        const { runtime } = await createRuntimeFixture()
        const bindLayout = await createBindLayout(runtime, [
            { binding: 0, name: 'camera', type: 'uniform', visibility: [ 'vertex' ] },
        ])
        const diagnostic = expectSingleDiagnostic(inspectShader('').compareBindLayouts([ bindLayout ]), {
            code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
            severity: 'warn',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 0,
            binding: 0,
            name: 'camera',
        })
        expect(diagnostic.related).to.deep.equal([])
        expect(diagnostic.expected).to.deep.equal({
            source: 'WGSLReflection',
            present: false,
        })
        expect(diagnostic.actual).to.deep.equal({
            source: 'BindLayout',
            group: 0,
            binding: 0,
            type: 'uniform',
        })
    })

    it('reports shader and bind entry type mismatches', async() => {

        const { runtime } = await createRuntimeFixture()
        const bindLayout = await createBindLayout(runtime, [
            { binding: 0, name: 'camera', type: 'storage', visibility: [ 'compute' ] },
        ])
        const diagnostic = expectSingleDiagnostic(inspectShader(`
            @group(0) @binding(0) var<uniform> camera: Camera;
        `).compareBindLayouts([ bindLayout ]), {
            code: 'SCRATCH_BIND_SHADER_TYPE_MISMATCH',
            severity: 'warn',
            phase: 'binding',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'BindLayoutEntry',
            group: 0,
            binding: 0,
            name: 'camera',
        })
        expect(diagnostic.related).to.deep.equal([
            {
                kind: 'ShaderBinding',
                group: 0,
                binding: 0,
                name: 'camera',
            },
        ])
        expect(diagnostic.expected).to.deep.equal({
            source: 'BindLayout',
            group: 0,
            binding: 0,
            type: 'storage',
        })
        expect(diagnostic.actual).to.deep.equal({
            source: 'WGSLReflection',
            group: 0,
            binding: 0,
            type: 'uniform',
        })
    })

    it('treats unsupported texture declarations as inconclusive', () => {

        const inspection = inspectShader(`
            @group(0) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;
            @group(0) @binding(1) var externalTexture: texture_external;
        `)

        expect(inspection.bindings.map(bindingFacts)).to.deep.equal([
            {
                group: 0,
                binding: 0,
                name: 'outputTexture',
                type: 'storage-texture',
                moduleIndex: 0,
                inconclusive: true,
            },
            {
                group: 0,
                binding: 1,
                name: 'externalTexture',
                type: 'external-texture',
                moduleIndex: 0,
                inconclusive: true,
            },
        ])
        expect(inspection.report).to.include({
            version: 1,
            hasErrors: false,
            errorCount: 0,
            warningCount: 2,
        })
        expect(inspection.report.diagnostics.map(diagnostic => diagnostic.code)).to.deep.equal([
            'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
            'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
        ])
        expect(inspection.report.diagnostics[0]).to.include({
            severity: 'warn',
            phase: 'program',
        })
        expect(inspection.report.diagnostics[0].subject).to.deep.equal({
            kind: 'ShaderBinding',
            group: 0,
            binding: 0,
            name: 'outputTexture',
        })
        expect(inspection.report.diagnostics[0].expected).to.deep.equal({
            source: 'WGSLReflection',
            supportedTypes: [ 'uniform', 'read-storage', 'storage', 'texture', 'sampler' ],
        })
        expect(inspection.report.diagnostics[0].actual).to.deep.equal({
            source: 'WGSLReflection',
            group: 0,
            binding: 0,
            type: 'storage-texture',
        })
        expect(inspection.compareBindLayouts([]).diagnostics.map(diagnostic => diagnostic.code)).to.deep.equal([
            'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
            'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
        ])
    })

    it('uses Program subject for Program input parser uncertainty', async() => {

        const { runtime } = await createRuntimeFixture()
        const program = await createTestProgram(runtime, {
            label: 'unsupported binding program',
            sourceParts: [
            `
            @group(0) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;
            @compute @workgroup_size(1)
            fn csMain() {
            }
            `,
            ],
            compute: 'csMain',
        })
        const inspection = inspectShader(program)

        expect(inspection.report.diagnostics).to.have.length(1)
        expect(inspection.report.diagnostics[0]).to.include({
            code: 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE',
            severity: 'warn',
            phase: 'program',
        })
        expect(inspection.report.diagnostics[0].subject).to.deep.equal({
            kind: 'Program',
            id: program.id,
            label: 'unsupported binding program',
        })
        expect(inspection.report.diagnostics[0].related).to.deep.equal([
            {
                kind: 'ShaderBinding',
                group: 0,
                binding: 0,
                name: 'outputTexture',
            },
        ])
    })

    it('suppresses an intentional bind entry mismatch by code, group, and binding', async() => {

        const { runtime } = await createRuntimeFixture()
        const bindLayout = await createBindLayout(runtime, [
            { binding: 0, name: 'camera', type: 'uniform', visibility: [ 'vertex' ] },
        ])

        expectReportEmpty(inspectShader('').compareBindLayouts([ bindLayout ], {
            suppress: [
                {
                    code: 'SCRATCH_BIND_SHADER_INDEX_MISMATCH',
                    group: 0,
                    binding: 0,
                },
            ],
        }))
    })

    it('includes Program context for Program input comparisons', async() => {

        const { runtime } = await createRuntimeFixture()
        const program = await createTestProgram(runtime, {
            label: 'inspection program',
            sourceParts: [
            `
            @group(0) @binding(0) var<uniform> camera: Camera;
            @compute @workgroup_size(1)
            fn csMain() {
            }
            `,
            ],
            compute: 'csMain',
        })
        const bindLayout = await createBindLayout(runtime, [
            { binding: 0, name: 'camera', type: 'storage', visibility: [ 'compute' ] },
        ])
        const diagnostic = expectSingleDiagnostic(inspectShader(program).compareBindLayouts([ bindLayout ]), {
            code: 'SCRATCH_BIND_SHADER_TYPE_MISMATCH',
            severity: 'warn',
            phase: 'binding',
        })

        expect(diagnostic.related).to.deep.equal([
            {
                kind: 'ShaderBinding',
                group: 0,
                binding: 0,
                name: 'camera',
            },
            {
                kind: 'Program',
                id: program.id,
                label: 'inspection program',
            },
        ])
    })
})
