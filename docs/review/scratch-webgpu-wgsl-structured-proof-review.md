# Scratch WebGPU/WGSL Structured Proof Review

Status: Living review
Date: 2026-07-25

## Purpose

This review defines the living proof boundary for Scratch coverage of the
formal WebGPU and WGSL inventories. It replaces coverage decisions based on
source token searches, broad regular expressions, comments, ordinary
strings, or rationale prose with entry-bound structured evidence.

The proof system reviews whether Scratch can express and lower a formal
capability. It does not redefine WebGPU/WGSL semantics, infer hidden runtime
work, or expand the public Scratch API.

ADR-057 places this proof system in the GPU domain of the broader Scratch
foundation. Public-symbol evidence resolves through `geoscratch/scratch`; the
package root contributes only the `scratch` and `geo` namespaces.

## Fixed Authority

| Source | Pinned authority |
| --- | --- |
| WebGPU | W3C CRD 14 July 2026, SHA-256 `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30` |
| WGSL | W3C CRD 16 July 2026, SHA-256 `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa` |
| GPUWeb editor | `b33e6efb182d11156851271586563cc77575059c` |
| `gpuweb/types` | `9ba8a0618e1efad8e1ee444ef6ecfae761b2bc30`, package `0.1.71`, declaration SHA-256 `d2e5cfb2397ec8cacfd30de0e6f7992eb7db7b02cc83b7c43ef58bcd5aa88bc3` |
| Proposal index | 23 structured non-normative records |

The formal W3C inventory is authoritative. `gpuweb/types` is a declaration
cross-check and cannot add, remove, or redefine formal capability IDs.
Draft, inactive, and obsolete proposals remain observation records and do
not contribute managed coverage.

The one bounded network observation was partial. WGSL publication, editor,
types, and proposal metadata were observed; the WebGPU publication request
returned a fetch error. It was not retried. The pinned local publication
hash remains the WebGPU authority for this Goal.

## Schema V4

The current manifest and external schema are:

- `docs/review/manifests/scratch-webgpu-wgsl-current-coverage.json`
- `docs/review/manifests/scratch-webgpu-wgsl-current-coverage.schema.json`

The executable validator is
`scripts/scratch-webgpu-wgsl-structured-proof.mjs`. Schema v4 is the only
accepted path; there is no schema-v3 reader, dual generator, fallback
classifier, or historical catch-all.

The validator rejects:

- unknown top-level, entry, evidence, selector, requirements, and nested
  fields;
- unknown proof kinds and selector shapes;
- duplicate inventory IDs, evidence IDs, selectors, values, or requirement
  facts;
- missing, extra, or domain/kind-misassigned formal inventory entries;
- mismatched formal source anchors and manifest paths;
- mismatched entry selectors, WGSL contract IDs, WebGPU type members,
  browser requirements, and summary counts;
- unknown feature, extension, language-feature, limit, dependency, and
  condition values;
- paths outside the repository or files absent from the TypeScript program.

The generator is stable-sorted and time-noise-free. Two consecutive
generations must produce byte-identical current coverage, enable-extension,
and schema artifacts.

## Proof Chain

Every managed entry must close this chain:

1. formal inventory ID and source anchor;
2. finite coverage rule;
3. actual package public export;
4. declaration owned by Scratch source;
5. exact Scratch implementation evidence;
6. typed native WebGPU lowering or entry-bound WGSL compilation contract;
7. exact capability requirements;
8. a browser execution contract for every managed WGSL entry, with
   capability skips represented as explicit results.

Rationale explains the design but cannot satisfy any link.

The discriminated proof kinds are:

| Kind | Verified fact |
| --- | --- |
| `public-export` | Symbol resolves through the real TypeScript module graph |
| `scratch-operation` | Export or named member resolves to a Scratch declaration |
| `function-call` | Typed call target, receiver type, source file, and optional literal arguments |
| `constructor-call` | Exact constructor node |
| `property-read` | Exact typed receiver and non-write access |
| `property-write` | Exact typed receiver and write access |
| `descriptor-field` | Exact owner type and contextual or declared field |
| `type-declaration` | Exact declaration in pinned `gpuweb/types` |
| `type-member` | Exact owner/member/member-kind declaration |
| `wgsl-contract` | Caller source reaches `GPUShaderModuleDescriptor.code` and the same descriptor reaches `createShaderModule` |
| `layout-contract` | `LayoutCodec` exposes packing, WGSL accessors, and readback views |
| `browser-execution` | Exact entry/profile, full requirements, runner return value, and result collection are connected |
| `n-a-composition` | Exact permitted DOM mixin composition |

No selector depends on source line numbers.

## Type-Aware Resolution

The engine constructs a TypeScript `Program` from
`packages/geoscratch/tsconfig.build.json` and all declared proof sources. A
single `TypeChecker` resolves:

- re-export aliases and package entrypoint ownership;
- call receiver types rather than member spelling alone;
- property read/write direction;
- contextual descriptor object types;
- declaration owner and member kinds;
- source-file identity;
- the specific descriptor variable carrying WGSL into native compilation.

This makes `GPUAdapterInfo.isFallbackAdapter` an ordinary positive proof. It
passes because the real property exists on the correct typed receiver and is
expressed through the managed runtime path. No name-specific exemption
exists.

## Raw-Handle Boundary

Raw `GPUDevice`, `GPUQueue`, and other native handles remain escape hatches.
They are not managed coverage.

For every managed entry, all `nativeLowering.operationEvidence` must point
under `packages/geoscratch/src/scratch/`. Keeping a valid public Scratch
symbol while redirecting lowering to a raw call in a test, example, legacy
module, or unrelated package source fails before that call can count as
evidence.

This rule does not hide native operations. The structured lowering still
names the exact operation and verifies its receiver and source node. It only
requires the operation to be reached through the managed Scratch boundary.

## WebGPU Coverage

The 582-entry WebGPU inventory closes all seven reviewed capability areas:

1. runtime, adapter, device, surface, canvas composition, loss, lifecycle,
   features, and limits;
2. buffers, textures, views, samplers, external textures, mapping,
   descriptors, and lifetime;
3. bind layouts/sets, shader modules, pipeline layouts, render/compute
   pipelines, and async creation;
4. command encoders, render/compute passes, render bundles, debug operations,
   and attachments;
5. queue uploads, external-image upload, all four copy directions, clear,
   mapping, readback, and transfer authority;
6. query sets, timestamps, occlusion, resolve, ordering, completion, and
   native failure observation;
7. validation, OOM/internal/device errors, optional conditions, WebIDL
   composition, and implementation constraints.

All 78 WebGPU methods use exact rules. Unknown IDs and forged owner/kind/member
facts fail before classification. Homogeneous owner rules are finite maps,
not naming-pattern defaults.

## WGSL Coverage

The 662-entry WGSL inventory covers directives/extensions, syntax,
declarations, control flow, types, address spaces, access modes, memory and
layout, stage interfaces, attributes, interpolation, built-ins, textures and
formats, capability conditions, limits, diagnostics, uniformity, aliasing,
and static/dynamic language semantics.

For every WGSL entry, the exact formal ID is bound to the lossless
caller-authored source path that becomes `GPUShaderModuleDescriptor.code` and
to the typed native `createShaderModule` call. Scratch does not parse,
translate, or reinterpret WGSL, so the browser/compiler remains the semantic
authority.

Layout entries add the `LayoutCodec` ABI contract. Every managed WGSL entry
also carries one browser execution proof. Entries with formal enable or
language-feature requirements bind to the corresponding executable contract;
the remaining entries bind to one of nine explicit proof profiles covering
source, binding, pipeline interface, diagnostics, layout, texture binding,
capability, and the two standalone limit cases.

The selector binds the formal ID, proof profile, enable extensions, device
features, language features, limits, dependencies, and conditions. The AST
proof follows symbol identity from the runner call's assigned result into the
declared result collection. Calling a valid runner and pushing an unrelated
object does not resolve. Missing execution, an uncompiled ordinary string, or
a result with different requirements fails.

The migration corrected
`language-extension.texture_formats_tier1` to require
`texture-formats-tier1` in its browser proof. It also corrected texture
readback `copyTextureToBuffer` evidence to the real native call in
`scratch/command.ts`. Neither correction changes a classification.

## Closure

| Measure | Result |
| --- | ---: |
| Total formal entries | 1,244 |
| WebGPU | 582 |
| WGSL | 662 |
| Managed | 1,242 |
| Not applicable | 2 |
| Unresolved | 0 |
| Managed first class | 637 |
| Managed semantic equivalent | 605 |

The only N/A entries are Navigator and WorkerNavigator host-DOM composition.
No classification changed during the schema-v4 migration.

## Adversarial Evidence

Focused tests prove that all of these fail:

- target text present only in a comment or ordinary string;
- a correct member name on the wrong receiver type;
- a correct member in the wrong source file;
- a public symbol that is not exported through the package graph;
- a raw-device-only native call outside managed Scratch source;
- a missing node, unknown kind, unknown selector, duplicate selector, or
  repository-escaping path;
- a valid WebGPU type member assigned to another formal entry;
- a WGSL contract ID assigned to another formal entry;
- a WGSL payload not carried into the native shader descriptor;
- a browser contract missing execution/result dataflow or carrying different
  requirements;
- a valid browser runner call whose returned value is discarded while an
  unrelated object is pushed;
- a managed WGSL entry without a browser execution proof;
- a missing, duplicate, or domain/kind-misassigned formal inventory entry;
- a forged normative anchor or summary count;
- an unknown future WebGPU owner/member or WGSL profile key.

## Known Boundaries

- Ordinary audits verify checked-in browser execution wiring; they do not
  claim that optional hardware features are available on every machine.
  Actual browser runs may report explicit capability skips.
- A generic WGSL language entry binds lossless Scratch transport to a concrete
  executable proof profile. That profile proves compilation, pipeline
  creation, submission, and readback for the profile boundary; it does not
  claim that every arbitrary user shader is valid. Semantic validity remains
  the WebGPU implementation's responsibility.
- `gpuweb/types` proves declaration agreement only. It never overrides the
  formal W3C inventory.
- Formal-source freshness remains partial for this Goal because the one
  WebGPU publication request failed and retry was prohibited. This is an
  observation limitation, not an uncovered Scratch capability.
- The proof system does not change runtime diagnostics, scheduling,
  preparation, resource lifetime, or submission behavior.

## Independent Review And Concentrated Correction

The one permitted independent read-only review returned `issues-found` with
three findings:

1. non-extension WGSL entries had no entry/profile-bound executable result;
2. browser proof accepted a runner call plus any result-array push, without
   proving that the pushed value was the runner result;
3. `GPUAdapterInfo` entries proved only the aggregate Scratch snapshot, not
   the exact native member extraction.

The one permitted concentrated correction addressed all three:

- all 662 managed WGSL entries now carry exactly one browser proof, closed
  over 6 enable contracts, 12 language contracts, and 9 normative profile
  contracts;
- browser matching uses TypeChecker symbol identity to connect a runner
  return assignment to the value pushed into the exact result collection;
- `GPUAdapter.info`, `GPUDevice.adapterInfo`, the adapter fallback alias, the
  `GPUAdapterInfo` interface, and all seven `GPUAdapterInfo` members now use
  exact `adapter.info`, field-helper-with-literal, or typed property-read
  lowering evidence.

A headed Chrome 150 focused run produced 28 unique proofs: 25 executed and
passed, while 3 were explicitly skipped because the selected adapter lacked
the optional `subgroup-size-control`, `texture_formats_tier1`, or
`buffer_view` capability. It reported zero failed proofs, validation errors,
OOM errors, native failures, uncaptured errors, or device losses, and every
executed runtime reached a clean terminal state.

No second review was started. The final full gate is recorded only after it
actually occurs.
