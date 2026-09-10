---
docId: api
canonical: true
apiSources:
---
# GeoScratch API

[简体中文](./README_zh.md)

This directory documents the current public API. TypeScript source and package
entrypoints are executable facts; these English pages are the canonical semantic
explanation. Chinese pages are translations. Vision documents describe direction,
ADRs explain decisions, and reviews record bounded evidence. None replaces this
present-tense API contract.

## Entrypoints

- [Scratch](./scratch/README.md) is the domain-neutral foundation for diagnostics,
  lifetime, cache, geometry, Worker execution, and explicit WebGPU resources and work.
- [Geo](./geo/README.md) adapts Scratch into coordinate, view, tile, field, Virtual
  Raster, CPU/GPU view cover, and terrain semantics. Geo may depend on Scratch;
  Scratch never depends on Geo.

Generated references enumerate all exports from the real entrypoints:
[Scratch reference](./reference/scratch.md), [Geo reference](./reference/geo.md), and
[machine-readable facts](./reference/api-docs.json).

## Maintenance

Run `npm run docs:generate` after public TypeScript changes, update the relevant
English and Chinese pages, then run `npm run docs:translations` to acknowledge the
translation update. `npm run docs:check` is read-only and rejects stale references,
missing source summaries, incomplete source ownership, broken links, or stale
translations.
