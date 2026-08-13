# ADR-071: Keep Current API Knowledge Bilingual And Source-Verified

## Status

Accepted

## Date

2026-08-14

## Context

GeoScratch has accumulated vision documents, ADRs, implementation plans, audits, and
examples. Those artifacts answer different historical or directional questions, but
none previously provided a complete present-tense account of every public Scratch and
Geo subsystem. Reconstructing ownership, lifecycle, composition, and diagnostics from
hundreds of exports consumes substantial human and agent context and can accidentally
treat an old ADR or example workflow as the current API.

The maintainer and Chinese-speaking users require Chinese documentation, while English
is the international publication and research language. Maintaining two independent
specifications would create competing facts. Generated signatures alone are also
insufficient because they cannot explain responsibility and authority boundaries.

## Decision

The repository owns a bilingual API knowledge system under `docs/api/`:

1. TypeScript source and package entrypoints are executable API facts.
2. English semantic pages are the canonical current API contract.
3. Every English page has a Chinese `_zh.md` translation. The English page governs
   any disagreement.
4. A SHA-256 digest of the canonical body records which English revision each Chinese
   page translates. Digest refresh is an explicit author operation, not part of normal
   generation or checking.
5. TypeDoc follows the real `geoscratch/scratch` and `geoscratch/geo` re-export graphs.
   A repository-owned normalizer emits deterministic committed JSON facts and Markdown
   references without exposing TypeDoc's unstable internal identifiers as a contract.
6. Every public source file belongs to exactly one canonical subsystem page, and every
   public runtime value has a source TSDoc summary.
7. `npm run docs:check` is read-only and rejects generated drift, missing summaries,
   incomplete or duplicate source ownership, missing/stale translations, broken links,
   unknown API references, and unreachable canonical pages.
8. The documentation gate runs as part of normal test and typecheck verification.
9. Root `AGENTS.md` requires agents to read and update the current API contract when
   changing public semantics.

Generated references enumerate names, declaration source and line, kind, summary,
declaration shape, callable signatures, and class/interface members. Handwritten pages
explain purpose, non-responsibilities, ownership, lifecycle, composition, diagnostics,
and the distinction between Scratch, Geo, and application assembly.

## Consequences

- Public API drift becomes a failing repository check rather than a later documentation
  discovery.
- Chinese translation freshness is mechanically visible without making translation
  prose a second source of truth.
- Agents can load the subsystem pages relevant to a task instead of repeatedly parsing
  the full implementation or all historical ADRs.
- A source-only comment change can move generated line locations and therefore requires
  regeneration; generated churn is accepted because locations are useful evidence.
- Authors still need judgment: digests prove revision pairing, not translation quality,
  and generated signatures do not replace semantic documentation.

## Rejected Alternatives

### Use A GitHub Wiki As The Authority

Rejected because it is not committed atomically with source branches and cannot
participate reliably in local or CI validation.

### Maintain Independent English And Chinese Specifications

Rejected because both languages would become competing semantic authorities.

### Publish Raw TypeDoc JSON

Rejected because internal reflection ids and serializer details are tool-specific and
would make repository consumers depend on TypeDoc internals.

### Generate Signatures Without Handwritten Pages

Rejected because signatures do not explain ownership, lifecycle authority, scheduling,
error attribution, or why adjacent responsibilities are deliberately excluded.
