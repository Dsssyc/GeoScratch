# Bilingual API Knowledge System Design

Status: Accepted
Date: 2026-08-14

## Goal

Establish a complete, repository-owned API knowledge system for the current
`geoscratch/scratch` and `geoscratch/geo` public surfaces. English is the
canonical specification language. Chinese pages are paired translations for
the maintainer and Chinese-speaking users. Machine-generated API facts prevent
the prose documentation from silently drifting away from TypeScript exports.

## Problem

GeoScratch already has vision documents, ADRs, plans, and audits, but none of
those artifacts answers the complete present-tense question: what does the
current public API expose, who owns each object, how do objects compose, and
which lifecycle and diagnostic rules apply?

The growing implementation makes source-only reconstruction expensive for both
humans and agents. Historical ADRs can also remain accurate records while no
longer describing the current API. Without a repository-level agent contract,
changes can update code without updating the knowledge needed to reason about
that code later.

## Sources Of Truth

The documentation classes have distinct authority:

1. TypeScript source and package entrypoints are the executable API fact.
2. English files under `docs/api/` are the canonical semantic documentation for
   the current API.
3. Chinese `_zh.md` files are translations of exact English counterparts.
4. ADRs explain accepted and superseded decisions; they are historical records.
5. Vision documents describe intended direction and are not evidence that an
   API currently exists.
6. Reviews and audits record bounded evidence from a particular change.

When implementation and canonical API prose disagree, the discrepancy must be
investigated. A contributor must not silently assume either side is correct.

## Documentation Topology

`docs/api/README.md` and `README_zh.md` are the navigation roots. Scratch and Geo
each have subsystem pages covering their complete current public topology:

- Scratch: overview, diagnostics, lifetime, cache, geometry, GPU runtime and
  surfaces, GPU resources and data, programs and bindings, commands and
  submissions, readback and observation, and Worker execution.
- Geo: overview, coordinates and precision, views and frame control, fields,
  tile models and demand, Virtual Raster models and runtime, GPU frontiers, and
  terrain rendering.

Every canonical subsystem page states purpose, responsibilities,
non-responsibilities, ownership, lifecycle, composition, diagnostics, public
API groups, examples where appropriate, and related decisions.

## Generated API Facts

TypeDoc reads the actual TypeScript package entrypoints and follows re-exports.
A repository script normalizes its reflection model into deterministic,
committed JSON manifests and Markdown references for `geoscratch/scratch` and
`geoscratch/geo`.

The normalized facts include every exported symbol's name, kind, declaration
source, summary, signature text where applicable, and parent/member structure.
Generated files are not edited manually. Regeneration must be deterministic,
and `docs:check` fails when the committed files differ from fresh output.

## Translation Contract

Canonical pages carry front matter with `canonical: true` and a stable `docId`.
Chinese pages carry `canonical: false`, `translationOf`, and a SHA-256 digest of
the corresponding canonical body. The digest detects an English change that
has not been translated. It does not claim to assess translation quality.

API identifiers, TypeScript signatures, diagnostic codes, URLs, and executable
examples remain unchanged in translation. If Chinese and English prose differ,
the English canonical page governs.

## Validation

`npm run docs:generate` regenerates deterministic API facts and refreshes
translation metadata only when explicitly requested by the documentation
author. `npm run docs:check` is read-only and fails on:

- stale generated API facts;
- an exported runtime symbol without a documentation summary;
- missing or duplicated canonical document ids;
- missing Chinese counterparts or stale translation digests;
- broken relative Markdown links;
- invalid documented API symbol references;
- missing subsystem registration in the API navigation; or
- generated files edited by hand.

The documentation check is part of the root test and typecheck gates so API
changes cannot bypass it in normal verification.

## Agent Contract

A root `AGENTS.md` directs all agents to read the canonical API root and relevant
subsystem pages before changing implementation. It states the authority order
above and requires coordinated updates whenever public API, ownership,
lifecycle, state transitions, diagnostics, or module dependencies change.

The contract also preserves the macro-first boundary: example-specific
assembly is evidence of a possible missing primitive, not permission to move a
narrow workflow unchanged into Scratch or Geo.

## Publication

Repository Markdown is the source of truth and remains useful in GitHub, local
editors, package review, and agent context. A future documentation site may
render the same files and generated references, but it must not become a
separate editable authority.

## Acceptance

- Every current public Scratch and Geo export appears in deterministic generated
  facts and Markdown reference pages.
- Every public runtime value has a source documentation summary.
- Every current subsystem has complete English semantic documentation and a
  paired Chinese translation.
- Translation staleness, API drift, missing coverage, and broken links fail a
  single documented command.
- Root `AGENTS.md` makes documentation reading and maintenance mandatory.
- Existing package build, typecheck, and test gates continue to pass.

## Rejected Alternatives

### GitHub Wiki As The Authority

Rejected because it is not versioned atomically with source branches and cannot
participate reliably in repository CI.

### Independent English And Chinese Specifications

Rejected because both languages would become competing facts. Chinese is a
translation with explicit freshness metadata.

### Generated TypeDoc Pages Only

Rejected because signatures do not explain ownership, lifecycle authority,
composition boundaries, or why a concept does not own adjacent systems.

### Hand-Maintained Symbol Lists

Rejected because the current public surface is already too large for manual
enumeration to remain reliable.
