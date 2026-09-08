import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { GPURuntime } from 'geoscratch/scratch'

const directory = new URL('../examples/flowField/', import.meta.url)
let source = await readFile(new URL('flow-history.ts', directory), 'utf8')
source = source.replace(/import (\w+) from '(\.\/shaders\/[^']+)\?raw'/g,
    (_, name) => `const ${name} = ''`)
source = source.replace("from 'geoscratch/scratch'", `from ${JSON.stringify(import.meta.resolve('geoscratch/scratch'))}`)
source = source.replaceAll("from './flow-presentation.ts'", `from ${JSON.stringify(new URL('flow-presentation.ts', directory).href)}`)
source = source.replace("import { flowScreenProjectionWgsl, flowScreenViewValues } from './flow-screen-projection.ts'",
    `const flowScreenProjectionWgsl = () => ''
     const flowScreenViewValues = view => ({ relativeWorldFromClip: view.clipFromRelativeWorld,
         cameraX: [0,0], cameraY: [0,0], cameraZ: [0,0] })`)
source = source.replace("import { createFlowCenterCache } from './flow-center-cache.ts'",
    'const createFlowCenterCache = options => options.runtime.createTestCenterCache()')
// Run the real history owner with fake GPU leaves. Projection/shader and native
// resource validation are covered by the separate actual-graph browser proof.
const javascript = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
} }).outputText
const { createFlowHistory } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

describe('Flow history synchronous content ownership', () => {
    it('invokes exactly once on the same builder after uniform upload and before cache/clear/render', async () => {
        await fixture(async f => {
            const builder = f.builder(), draw = f.draw(), input = [draw]
            let calls = 0
            const frame = f.history.encode(builder, f.view, sameBuilder => {
                calls++
                assert.equal(sameBuilder, builder)
                assert.deepEqual(builder.steps.map(step => step.kind), ['upload'])
                assert.equal(builder.steps[0].value.label, 'Upload Flow Field history uniform')
                assert.deepEqual(f.history.facts(), f.initial)
                sameBuilder.upload({label:'particle uniforms'})
                sameBuilder.compute({label:'particle simulation'})
                sameBuilder.compute({label:'contour'})
                return input
            }, true, f.prepared, 'sdf-center-linear')
            assert.equal(calls, 1)
            assert.deepEqual(builder.steps.map(step => step.kind),
                ['upload', 'upload', 'compute', 'compute', 'cache', 'render', 'render', 'render', 'render'])
            const compose = builder.steps.find(step => step.kind === 'render' && step.value.label === 'Flow Field history B to A')
            assert.equal(compose.draws.at(-1), draw)
            input.length = 0
            assert.equal(compose.draws.at(-1), draw, 'Returned list was snapshotted synchronously')
            assert.equal(frame.cleared, true)
            assert.equal(f.history.facts().nextDirection, 'A-to-B')
            await f.history.observe(builder.submit())
            assert.equal(f.cache.observations, 1)
        })
    })

    it('keeps the existing array path and empty zero-time draws without replaying prior content', async () => {
        await fixture(async f => {
            const draw = f.draw(), first = f.builder()
            f.history.encode(first, f.view, [draw], true, f.prepared)
            const paused = f.builder()
            f.history.encode(paused, f.view, () => [], true, f.prepared, 'hard', .25, undefined, 0)
            const compose = paused.steps.find(step => step.kind === 'render' && step.value.label === 'Flow Field history A to B')
            assert.equal(compose.draws.length, 1)
            assert.notEqual(compose.draws[0], draw)
            const before = f.history.facts(), retained = f.builder()
            f.history.presentRetained(retained, f.view)
            assert.equal(retained.steps.filter(step => step.kind === 'render').length, 1)
            assert.equal(f.history.facts().nextDirection, before.nextDirection)
        })
    })

    it('does not change history/cache/presentation state when a producer throws or returns an invalid value', async () => {
        for (const invalid of [undefined, null, {}, Promise.resolve([]), 'draws']) {
            await fixture(async f => {
                f.history.encode(f.builder(), f.view, [], true, f.prepared)
                const before = f.history.facts(), disposal = f.disposals.length, builder = f.builder()
                assert.throws(() => f.history.encode(builder, f.changedView, () => invalid,
                    false, f.prepared, 'sdf-center-linear'), /synchronously return/)
                assert.deepEqual(f.history.facts(), before)
                assert.equal(f.disposals.length, disposal, 'Existing presentation commands are still owned')
                assert.equal(f.cache.builds, 0)
                assert.deepEqual(builder.steps.map(step => step.kind), ['upload'])
                const next = f.history.encode(f.builder(), f.view, [], true, f.prepared)
                assert.equal(next.cleared, false, 'Failed non-accumulation/change did not set clearPending')
            })
        }
        await fixture(async f => {
            const builder = f.builder(), error = new Error('producer failed')
            assert.throws(() => f.history.encode(builder, f.view, same => {
                same.compute({label:'producer-owned side effect'})
                throw error
            }, true, f.prepared, 'sdf-center-linear'), value => value === error)
            assert.deepEqual(f.history.facts(), f.initial)
            assert.equal(f.cache.builds, 0)
            assert.deepEqual(builder.steps.map(step => step.kind), ['upload', 'compute'],
                'The caller abandons producer work; history does not pretend to roll it back')
            assert.equal(f.history.encode(f.builder(), f.view, []).cleared, true)
        })
    })

    it('rejects wrong-runtime/submitted builders and invalid direct content before invoking a producer', async () => {
        await fixture(async f => {
            let calls = 0
            const producer = () => { calls++; return [] }
            assert.throws(() => f.history.encode({...f.builder(),runtime:{}}, f.view, producer), /same-runtime/)
            const submitted = f.builder()
            submitted.submit()
            assert.throws(() => f.history.encode(submitted, f.view, producer), /live SubmissionBuilder/)
            for (const invalid of [null, {}, 1, Promise.resolve([])]) {
                const builder = f.builder()
                assert.throws(() => f.history.encode(builder, f.view, invalid), /content must/)
                assert.equal(builder.steps.length, 0)
            }
            assert.equal(calls, 0)
        })
    })

    it('rejects producer submission without advancing history or arming a cache build', async () => {
        await fixture(async f => {
            const builder = f.builder()
            assert.throws(() => f.history.encode(builder, f.view, same => {
                same.submit()
                return []
            }, true, f.prepared, 'sdf-center-linear'), /must not submit/)
            assert.equal(builder.isSubmitted, true)
            assert.deepEqual(f.history.facts(), f.initial)
            assert.equal(f.cache.builds, 0)
            assert.equal(builder.steps.some(step => step.kind === 'render'), false)
        })
    })

    it('observes rejected asynchronous returns without accepting them or emitting a second unhandled rejection', async () => {
        const unhandled = [], observe = reason => unhandled.push(reason)
        process.on('unhandledRejection', observe)
        try {
            await fixture(async f => {
                for (const producer of [
                    () => Promise.reject(new Error('invalid async content')),
                    () => f.history.resize({width:16,height:8}),
                    () => ({then(_resolve,reject) { reject(new Error('invalid thenable content')) }}),
                ]) {
                    assert.throws(() => f.history.encode(f.builder(), f.view, producer), /synchronously return/)
                    assert.deepEqual(f.history.facts(), f.initial)
                }
                await new Promise(resolve => setImmediate(resolve))
                assert.deepEqual(unhandled, [])
            })
        } finally { process.off('unhandledRejection', observe) }
    })

    it('rejects synchronous history reentry, releases its guard on failure, and preserves lifecycle cleanup', async () => {
        await fixture(async f => {
            for (const operation of [
                () => f.history.reset(), () => f.history.dispose(),
                () => f.history.encode(f.builder(), f.view, []),
                () => f.history.presentRetained(f.builder(), f.view),
                () => f.history.observe({}),
            ]) {
                assert.throws(() => f.history.encode(f.builder(), f.view, () => {
                    operation()
                    return []
                }), /cannot reenter/)
                assert.deepEqual(f.history.facts(), f.initial)
            }
            let resize
            f.history.encode(f.builder(), f.view, () => {
                resize = f.history.resize({width:16,height:8})
                resize.catch(() => {})
                return []
            })
            await assert.rejects(resize, /cannot reenter/)
            f.history.reset()
            assert.equal(f.history.facts().hasPreviousView, false)
            f.history.dispose()
            f.history.dispose()
            assert.equal(f.history.facts().disposed, true)
            assert.equal(f.cache.disposed, true)
            assert.ok(f.resources.every(value => value.disposed), 'All history-owned leaves are retired')
        })
    })
})

async function fixture(run) {
    const previous = {GPUBufferUsage:globalThis.GPUBufferUsage,GPUTextureUsage:globalThis.GPUTextureUsage}
    globalThis.GPUBufferUsage ??= {COPY_DST:8,UNIFORM:64}
    globalThis.GPUTextureUsage ??= {RENDER_ATTACHMENT:16,TEXTURE_BINDING:4}
    const resources = [], disposals = [], runtime = Object.create(GPURuntime.prototype)
    const leaf = descriptor => {
        const value = { ...descriptor, runtime, disposed:false, dispose() { this.disposed=true;disposals.push(this) },
            region() { return {resource:this} }, view() { return {resource:this} },
            async resize() {}, async prepare() {}, preparationState:'ready' }
        resources.push(value)
        return value
    }
    for (const name of ['createBuffer','createTexture','createBindLayout','createShaderModule','createRenderPipeline']) runtime[name] = async descriptor => leaf(descriptor)
    for (const name of ['createUploadCommand','createProgram','createRenderPass','createDrawCommand']) runtime[name] = descriptor => leaf(descriptor)
    runtime.createBindSet = async (layout, bindings, descriptor) => leaf({...descriptor,layout,bindings})
    const cache = {builds:0,observations:0,disposed:false,wgsl:'',layout:{},bindSet:{},resources:[],
        encode(builder) { this.builds++;builder.steps.push({kind:'cache'}) },
        facts() { return {builds:this.builds} },
        async observe() { this.observations++ },dispose() { this.disposed=true } }
    runtime.createTestCenterCache = () => cache
    const history = await createFlowHistory({runtime,surface:{runtime,format:'rgba8unorm'},size:{width:32,height:8},
        temporal:{layout:{runtime,group:1},wgsl:'fixture'},addressCodec:{},activityKill:.0001,
        mode:'clear',centerCache:{addressSpace:{},capacity:1}})
    const view = {kind:'geo-view-snapshot',clipFromRelativeWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
        cameraHigh:[0,0,0],cameraLow:[0,0,0],referenceViewport:[32,8]}
    const changedView = {...view,cameraHigh:[1,0,0]}
    const builder = () => ({runtime,isSubmitted:false,steps:[],
        upload(value) { this.steps.push({kind:'upload',value}) },
        compute(value) { this.steps.push({kind:'compute',value}) },
        render(value, draws) { this.steps.push({kind:'render',value,draws}) },
        submit() { this.isSubmitted=true;return {runtime:this.runtime} }})
    try {
        await run({runtime,resources,disposals,history,cache,view,changedView,builder,draw:()=>({runtime}),
            initial:history.facts(),prepared:{state:'ready',bindSet:{runtime},resources:[],requestedLevel:0,progress:.5}})
    } finally {
        history.dispose()
        for (const [key,value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]
            else globalThis[key] = value
        }
    }
}
