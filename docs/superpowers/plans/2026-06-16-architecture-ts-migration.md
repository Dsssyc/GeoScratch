# GeoScratch Architecture and TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute ADR-003 in small verified phases: stabilize runtime and package boundaries, add type-contract validation, reduce avoidable CPU-side runtime work, and prepare the first safe TypeScript migration slice.

**Architecture:** Keep the existing default global `device` and `director` compatibility model for this branch, but make its ownership and initialization contract explicit and testable. Defer a full runtime/context replacement to a later ADR after the default runtime contract is protected by tests.

**Tech Stack:** ES modules, WebGPU browser APIs, Mocha/Chai, npm workspaces, TypeScript compiler for type-contract tests.

---

## Baseline

- Branch base: `new-feature` at `b12c5cd`.
- Working branch: `socu/architecture-ts-migration`.
- Fresh baseline verification before plan writing: `npm test` produced `42 passing`.
- Historical archive constraint: before core changes, inspect `director`, `device`, `binding`, `renderPass/computePass`, and `buffer` lifecycle because they define resource ownership, update timing, and kernel boundaries.

## Review Loop Rule

Each phase has the same exit gate:

1. Run the phase-specific tests listed in the phase.
2. Run `npm test`.
3. Run `npm run build` when runtime, package, or example import behavior changed.
4. Perform a five-axis review against correctness, readability, architecture, security, and performance.
5. Fix every Critical or Important issue found by review.
6. Repeat review after fixes until there are no Critical or Important issues.
7. Commit the phase before starting the next phase.

No phase is complete because a test command passes alone. The review loop must also be clean.

## Phase 0: Plan and Branch Checkpoint

**Files:**
- Create: `docs/superpowers/plans/2026-06-16-architecture-ts-migration.md`

- [x] Confirm the active branch is `socu/architecture-ts-migration`.

Run:
```bash
git branch --show-current
```

Expected output:
```text
socu/architecture-ts-migration
```

- [x] Confirm baseline tests pass.

Run:
```bash
npm test
```

Expected output includes:
```text
42 passing
```

- [x] Commit the plan.

Run:
```bash
git add docs/superpowers/plans/2026-06-16-architecture-ts-migration.md
git commit -m "docs: plan architecture and typescript migration"
```

## Phase 1: Architecture Boundary Pass

**Files:**
- Create: `tests/runtime-boundary.test.js`
- Create: `tests/architecture-boundary.test.js`
- Create: `docs/decisions/ADR-004-default-runtime-and-package-boundaries.md`
- Modify: `packages/geoscratch/src/gpu/context/device.js`
- Modify: `packages/geoscratch/src/gpu/context/device.d.ts`
- Modify: `packages/geoscratch/src/gpu/director/director.js`
- Modify: `packages/geoscratch/src/gpu/director/director.d.ts`
- Modify only if needed by tests: `packages/geoscratch/src/index.js`
- Modify only if public declarations change: `packages/geoscratch/src/index.d.ts`

**Contract to establish:**
- The default runtime remains compatible with existing `StartDash()`, `getDevice()`, `device`, and `director` imports.
- `getDevice()` must never busy-wait. Before initialization it must fail immediately with a clear error.
- `StartDash()` owns default GPU device initialization and returns `Promise<GPUDevice | undefined>`.
- `director` may remain the default global frame orchestrator, but its device ownership must be explicit: it lazily resolves the default device and caches limits only after a device exists.
- The package keeps `./src/*` only as a deprecated compatibility aperture. New examples and docs must rely on public entrypoints.

- [x] Write the RED runtime-boundary test.

Add this test behavior in `tests/runtime-boundary.test.js`:
```js
import { expect } from 'chai'
import { spawnSync } from 'node:child_process'

describe('default runtime boundary', () => {
    it('fails fast when getDevice is called before StartDash initializes WebGPU', () => {
        const script = "import getDevice from './packages/geoscratch/src/gpu/context/device.js'; try { getDevice(); process.exit(2); } catch (error) { if (!String(error.message).includes('StartDash')) process.exit(3); process.exit(0); }"
        const result = spawnSync(process.execPath, [ '--input-type=module', '--eval', script ], {
            cwd: process.cwd(),
            timeout: 1000,
        })

        expect(result.status).to.equal(0)
        expect(result.error).to.equal(undefined)
    })
})
```

Run:
```bash
npx mocha tests/runtime-boundary.test.js
```

Expected before implementation: fail because the child process times out or exits incorrectly under the current busy-wait behavior.

- [x] Implement the minimal runtime-boundary fix.

In `packages/geoscratch/src/gpu/context/device.js`:
- Replace the infinite loop in `getDevice()` with an immediate error when the default device is missing.
- Keep `StartDash()` as the only initializer for the default browser device.
- Keep `device.setDevice(instance)` for compatibility.
- Correct interpolated error logs to use template literals.
- Avoid adding a new runtime abstraction in this phase.

- [x] Update declaration files for the runtime boundary.

In `packages/geoscratch/src/gpu/context/device.d.ts`:
```ts
/// <reference types="@webgpu/types" />

export interface DefaultDeviceSlot {
    device: GPUDevice | undefined;
    setDevice(device: GPUDevice): void;
}

export default function getDevice(): GPUDevice;
export class Device {
    device?: GPUDevice;
    isPrepared?: boolean;
    setDevice(device: GPUDevice): void;
    static Create(): Promise<Device | undefined>;
}
export function StartDash(): Promise<GPUDevice | undefined>;
export const device: DefaultDeviceSlot;
```

- [x] Write the RED architecture-boundary test.

Add this behavior in `tests/architecture-boundary.test.js`:
```js
import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))

describe('architecture boundaries', () => {
    it('records the default runtime and package boundary decision', () => {
        const adr = read('docs', 'decisions', 'ADR-004-default-runtime-and-package-boundaries.md')

        expect(adr).to.include('default global runtime')
        expect(adr).to.include('deprecated compatibility aperture')
        expect(adr).to.include('StartDash')
    })

    it('keeps package public entrypoints explicit while src wildcard remains compatibility-only', () => {
        const pkg = readJson('packages', 'geoscratch', 'package.json')

        expect(pkg.exports).to.include.keys([ '.', './scratch', './geo', './geometry', './package.json' ])
        expect(pkg.exports['./src/*']).to.equal('./src/*')
    })
})
```

Run:
```bash
npx mocha tests/architecture-boundary.test.js
```

Expected before ADR-004 exists: fail because the ADR file is missing.

- [x] Add ADR-004.

Create `docs/decisions/ADR-004-default-runtime-and-package-boundaries.md` with these decisions:
- Keep the default global runtime for compatibility in this branch.
- `StartDash()` initializes the default browser GPU device.
- `getDevice()` is a fast contract check, not a blocking wait.
- `director` remains the default frame orchestrator for existing examples.
- `./src/*` remains only as a deprecated compatibility aperture until a separate deprecation/removal ADR.

- [x] Run Phase 1 verification.

Run:
```bash
npx mocha tests/runtime-boundary.test.js tests/architecture-boundary.test.js
npm test
npm run build
```

- [x] Review Phase 1.

Review against the Phase 1 contract and the five review axes. Fix every Critical or Important issue. Repeat the review until the verdict is "Approve".

- [x] Commit Phase 1.

Run:
```bash
git add docs/decisions/ADR-004-default-runtime-and-package-boundaries.md tests/runtime-boundary.test.js tests/architecture-boundary.test.js packages/geoscratch/src/gpu/context/device.js packages/geoscratch/src/gpu/context/device.d.ts packages/geoscratch/src/gpu/director/director.js packages/geoscratch/src/gpu/director/director.d.ts packages/geoscratch/src/index.d.ts
git commit -m "refactor: clarify default runtime boundary"
```

## Phase 2: Type Contracts Before File Conversion

**Files:**
- Create: `tsconfig.types.json`
- Create: `tests/types/public-api.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify declaration files touched by typecheck failures, starting with:
  - `packages/geoscratch/src/index.d.ts`
  - `packages/geoscratch/src/gpu/context/device.d.ts`
  - `packages/geoscratch/src/gpu/director/director.d.ts`
  - `packages/geoscratch/src/gpu/binding/binding.d.ts`
  - `packages/geoscratch/src/gpu/pass/renderPass.d.ts`
  - `packages/geoscratch/src/gpu/pass/computePass.d.ts`
  - `packages/geoscratch/src/gpu/pipeline/renderPipeline.d.ts`
  - `packages/geoscratch/src/gpu/pipeline/computePipeline.d.ts`

**Contract to establish:**
- TypeScript is introduced as a contract checker, not as a full source conversion.
- Public imports from `geoscratch`, `geoscratch/geo`, and `geoscratch/geometry` type-check.
- Runtime descriptor objects for device, binding, pass, and pipeline have declaration coverage good enough for consumers to use the public API without `any` for the main happy path.

- [x] Add the RED typecheck entrypoint.

Run:
```bash
npm install --save-dev typescript
```

Modify root `package.json`:
```json
"typecheck": "tsc -p tsconfig.types.json"
```

Create `tsconfig.types.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": [
    "tests/types/**/*.ts"
  ]
}
```

Create `tests/types/public-api.ts`:
```ts
import * as scr from 'geoscratch'
import { MercatorCoordinate } from 'geoscratch/geo'
import { plane, sphere } from 'geoscratch/geometry'

const startResult: Promise<GPUDevice | undefined> = scr.StartDash()
const device: GPUDevice = scr.getDevice()

const screen = scr.screen({
    canvas: document.createElement('canvas'),
})
const createdScreen: scr.Screen = scr.Screen.create({
    canvas: document.createElement('canvas'),
})

const pass = scr.renderPass({
    name: 'typed render pass',
    colorAttachments: [ { colorResource: screen } ],
})

const shader = scr.shader({
    name: 'typed shader',
    codeFunc: () => '@vertex fn vMain() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fMain() -> @location(0) vec4f { return vec4f(); }',
})

const pipeline = scr.renderPipeline({
    name: 'typed pipeline',
    shader: { module: shader },
})

const binding = scr.binding({
    name: 'typed binding',
    range: () => [ 3 ],
})

pass.add(pipeline, binding)

const mercator = MercatorCoordinate.fromLonLat([ 0, 0 ])
const planeGeometry = plane(2)
const sphereGeometry = sphere(1, 8, 4)

void startResult
void device
void screen
void createdScreen
void mercator
void planeGeometry
void sphereGeometry
```

Run:
```bash
npm run typecheck
```

Expected before declaration fixes: fail with declaration mismatch errors.

- [x] Fix declarations until `npm run typecheck` passes.

Keep fixes focused on public contracts. Do not rename JavaScript source files in this phase.

- [x] Add a Mocha guard for the typecheck script.

In an existing package/workspace test or a new `tests/type-contracts.test.js`, assert:
```js
expect(readJson('package.json').scripts.typecheck).to.equal('tsc -p tsconfig.types.json')
expect(exists('tests', 'types', 'public-api.ts')).to.equal(true)
```

- [x] Run Phase 2 verification.

Run:
```bash
npm run typecheck
npm test
npm run build
```

- [x] Review Phase 2.

Review declaration accuracy against the JavaScript implementations. Fix every Critical or Important issue. Repeat until the review verdict is "Approve".

- [x] Commit Phase 2.

Run:
```bash
git add package.json package-lock.json tsconfig.types.json tests/types/public-api.ts tests/type-contracts.test.js packages/geoscratch/src/**/*.d.ts
git commit -m "test: add public type contract checks"
```

## Phase 3: Performance-Sensitive Runtime Cleanup

**Files:**
- Create or modify: `tests/runtime-performance-contracts.test.js`
- Modify: `packages/geoscratch/src/gpu/director/director.js`
- Modify: `packages/geoscratch/src/gpu/director/director.d.ts`
- Modify: `packages/geoscratch/src/gpu/pass/renderPass.js`
- Modify: `packages/geoscratch/src/gpu/pass/renderPass.d.ts`
- Modify: `packages/geoscratch/src/gpu/pipeline/computePipeline.js`
- Modify only if needed: `packages/geoscratch/src/gpu/pass/computePass.js`

**Contract to establish:**
- A frame with no visible stages must not submit an empty command buffer list.
- `RenderPass.update()` must be idempotent so a pass can refresh attachment views without corrupting its own method table.
- `ComputePipeline.isComplete()` must not reference an undefined render pass variable while creating its pipeline.
- Update-list behavior must remain deduplicated and should not require a resource to update more than once per frame unless `updatePerFrame` is true.

- [x] Write RED tests for runtime hot-path behavior.

Add behavior in `tests/runtime-performance-contracts.test.js`:
```js
import { expect } from 'chai'
import { Director } from '../packages/geoscratch/src/gpu/director/director.js'
import { RenderPass } from '../packages/geoscratch/src/gpu/pass/renderPass.js'
import { ComputePipeline } from '../packages/geoscratch/src/gpu/pipeline/computePipeline.js'

describe('runtime performance contracts', () => {
    it('does not submit an empty queue when no visible stages produce work', () => {
        const director = new Director()
        let submitCount = 0
        director.device = {
            queue: {
                submit: () => { submitCount++ },
            },
            createCommandEncoder: () => {
                throw new Error('no encoder should be created')
            },
        }
        director.addStage({ name: 'hidden', items: [], visibility: false })

        director.tickRender()

        expect(submitCount).to.equal(0)
    })

    it('lets RenderPass.update run more than once without replacing initialize()', () => {
        const texture = {
            texture: { width: 1, height: 1 },
            format: 'rgba8unorm',
            view: () => ({}),
            registerCallback: () => 0,
        }
        const pass = new RenderPass({
            name: 'repeatable render pass',
            colorAttachments: [ { colorResource: texture } ],
        })

        pass.update()
        pass.dirty = true
        pass.update()

        expect(pass.initialized).to.equal(true)
        expect(pass.initialize).to.be.a('function')
    })

    it('creates compute pipelines from isComplete without an undefined renderPass reference', () => {
        const pipeline = Object.create(ComputePipeline.prototype)
        const binding = {}
        let receivedBinding

        pipeline.pipeline = undefined
        pipeline.pipelineCreating = false
        pipeline.createPipeline = (nextBinding) => {
            receivedBinding = nextBinding
        }

        expect(() => pipeline.isComplete({}, binding)).not.to.throw()
        expect(receivedBinding).to.equal(binding)
    })
})
```

Run:
```bash
npx mocha tests/runtime-performance-contracts.test.js
```

Expected before implementation: fail because empty submit happens and repeated `RenderPass.update()` breaks `initialize`.

- [x] Implement the minimal hot-path fixes.

In `director.tickRender()`:
- Skip `queue.submit()` when no command buffers were produced.
- Preserve current stage ordering and execution semantics.

In `RenderPass.initialize()`:
- Set `this.initialized = true`.
- Do not assign to `this.initialize`.

In `ComputePipeline.isComplete()`:
- Pass `binding` to `createPipeline()`.
- Do not reference `renderPass`.

In update-list code:
- Preserve dedupe semantics.
- Convert object-backed sets to `Map` only if it simplifies code without changing public behavior.

- [x] Run Phase 3 verification.

Run:
```bash
npx mocha tests/runtime-performance-contracts.test.js
npm test
npm run build
```

- [x] Review Phase 3.

Review specifically for behavior drift in render ordering, command submission, and attachment refresh. Fix every Critical or Important issue. Repeat until the review verdict is "Approve".

- [x] Commit Phase 3.

Run:
```bash
git add tests/runtime-performance-contracts.test.js packages/geoscratch/src/gpu/director/director.js packages/geoscratch/src/gpu/director/director.d.ts packages/geoscratch/src/gpu/pass/renderPass.js packages/geoscratch/src/gpu/pass/renderPass.d.ts
git commit -m "perf: avoid empty runtime work"
```

## Phase 4: First TypeScript Migration Slice

**Files:**
- Create: `docs/decisions/ADR-005-typescript-source-migration-build-boundary.md`
- Modify: `tsconfig.types.json`
- Modify: stable leaf modules only after ADR-005 chooses a build boundary.

**Contract to establish:**
- Do not rename runtime `.js` modules to `.ts` until the package has a clear source/build boundary.
- The first migration slice must either:
  - use `checkJs` on stable leaf modules as the immediate source-compatible migration step, or
  - introduce a compiler output boundary that lets `.ts` source emit `.js` and `.d.ts` without breaking package exports.
- The chosen approach must be documented before any source conversion.

- [x] Write ADR-005 before converting source files.

ADR-005 must decide one of these paths:
- Path A: Source-compatible migration first: keep runtime `.js`, add `// @ts-check` and JSDoc to stable leaf modules, and rely on `tsc` for contract checks.
- Path B: Build-boundary migration first: introduce `src/*.ts` source with emitted package output, then migrate stable leaf modules.

This branch should choose Path A unless there is a concrete reason to move package output during the same branch.

- [x] Write the RED type migration test.

Extend `tsconfig.types.json` so it includes the first stable checked leaf module, starting with:
```json
"packages/geoscratch/src/core/utils/uuid.js"
```

Run:
```bash
npm run typecheck
```

Expected before JSDoc/check fixes: fail if the selected file has implicit or incompatible types.

- [x] Implement the first source-compatible TypeScript migration slice.

For `packages/geoscratch/src/core/utils/uuid.js`:
- Add `// @ts-check`.
- Add JSDoc return types.
- Keep the `.js` filename and public import paths unchanged.
- Keep `packages/geoscratch/src/core/utils/uuid.d.ts` synchronized if it exists or create it if absent.

- [x] Run Phase 4 verification.

Run:
```bash
npm run typecheck
npm test
npm run build
```

- [x] Review Phase 4.

Review for type drift, package export drift, and accidental build-boundary changes. Fix every Critical or Important issue. Repeat until the review verdict is "Approve".

- [x] Commit Phase 4.

Run:
```bash
git add docs/decisions/ADR-005-typescript-source-migration-build-boundary.md tsconfig.types.json packages/geoscratch/src/core/utils/uuid.js packages/geoscratch/src/core/utils/uuid.d.ts
git commit -m "refactor: start source-compatible typescript migration"
```

## Final Completion Audit

Before marking the thread goal complete:

- [ ] Re-read `docs/decisions/ADR-003-architecture-before-typescript-migration.md`.
- [ ] Re-read this plan.
- [ ] Verify every Phase 1, Phase 2, Phase 3, and Phase 4 checkbox is complete.
- [ ] Verify every ADR-003 completion signal has current evidence:
  - Public package entrypoints are explicit and intentional.
  - Internal modules can change without requiring examples to import through `packages/geoscratch/src/*`.
  - Device, director, resource, pass, pipeline, and binding ownership rules are documented and reflected in code.
  - Per-frame CPU update paths are identifiable and avoid work when no resource changed.
  - Public API type coverage exists and passes `npm run typecheck`.
- [ ] Run final verification:

```bash
npm run typecheck
npm test
npm run build
git status --short
```

- [ ] Perform final review. Fix every Critical or Important issue and repeat verification after fixes.
- [ ] Only after the audit is proven, mark the goal complete.
