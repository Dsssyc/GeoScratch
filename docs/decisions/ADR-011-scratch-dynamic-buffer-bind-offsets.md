# ADR-011: Add Scratch Dynamic Buffer Bind Offsets

## Status

Accepted

## Date

2026-07-08

## Context

Scratch now has explicit bind layouts and bind sets, render and compute pipelines, executable draw and dispatch commands, layout-aware upload and readback, and program layout requirement validation.

The remaining low-level WebGPU binding primitive was dynamic buffer offsets. Without it, a command cannot bind one large uniform or storage buffer once and select a per-command byte slice through `setBindGroup()`.

This is a Scratch core primitive. It should not be modeled through a higher-level example abstraction, and it should not change `BindSet` into a per-command parameter object.

## Decision

Add `hasDynamicOffset?: boolean` to buffer bind layout entries:

- `UniformBindLayoutEntry`
- `StorageBindLayoutEntry`

Only `uniform`, `read-storage`, and `storage` entries may use `hasDynamicOffset`. Texture and sampler entries reject the flag with a structured binding diagnostic.

Dynamic buffer entries lower to WebGPU bind group layout entries with:

- `buffer.hasDynamicOffset = true`

Non-dynamic entries keep their existing normalized and lowered shapes; Scratch does not add `hasDynamicOffset: false`.

Add command-level dynamic offsets:

- `DrawCommandDescriptor.dynamicOffsets?: Record<number, number[]>`
- `DispatchCommandDescriptor.dynamicOffsets?: Record<number, number[]>`

The record key is the bind group number. The array is interpreted in ascending bind layout `binding` order for entries in that group that declare `hasDynamicOffset: true`.

`DrawCommand` and `DispatchCommand` validate dynamic offsets when the command is created:

- every required dynamic bind group must have offsets;
- supplied groups must belong to the command's bind sets;
- offset count must match the group's dynamic buffer entry count;
- offsets must be non-negative integers;
- uniform offsets must satisfy `minUniformBufferOffsetAlignment`;
- storage offsets must satisfy `minStorageBufferOffsetAlignment`.

Encoding keeps the old two-argument `setBindGroup(group, bindGroup)` form for bind sets without dynamic offsets, and uses `setBindGroup(group, bindGroup, dynamicOffsets)` only when required.

`BindSet` continues to own concrete resources and bind group caching. It does not store dynamic offsets, and dynamic offset values do not participate in bind group cache invalidation.

## Consequences

- Scratch can reuse large uniform and storage buffers across draw or dispatch commands while selecting a per-command slice explicitly.
- Dynamic offsets remain executable command state, which matches WebGPU's command encoding model.
- Bind group cache invalidation stays tied to allocation versions, not content epochs or dynamic offset values.
- Public TypeScript users can pass the new fields through both `geoscratch` and `geoscratch/scratch`.
- Invalid dynamic offsets use structured Scratch diagnostics instead of message parsing.

## Non-Goals

- Do not add buffer segment APIs.
- Do not add static buffer binding `offset`, `size`, or `minBindingSize` fields.
- Do not add dynamic or indirect draw and dispatch counts.
- Do not add scheduler dependency validation or automatic command ordering.
- Do not infer dynamic offsets from shader reflection.
- Do not migrate examples or geospatial integrations in this decision.
