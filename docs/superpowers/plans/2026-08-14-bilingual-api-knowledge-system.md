# Bilingual API Knowledge System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete English-canonical, Chinese-translated API knowledge system whose generated facts and validation gates track every current Scratch and Geo export.

**Architecture:** TypeDoc converts the real TypeScript entrypoints into a reflection model; a repository-owned generator normalizes that model into committed deterministic JSON and Markdown. Handwritten bilingual subsystem pages explain semantic boundaries while front-matter digests, symbol references, link checks, and source documentation coverage prevent drift.

**Tech Stack:** TypeScript 6, TypeDoc 0.28, Node.js ESM, Markdown, Mocha, SHA-256.

## Global Constraints

- English API documentation is canonical; Chinese files are translations.
- TypeScript source and public entrypoints remain executable API facts.
- API identifiers, signatures, diagnostic codes, and examples are never translated.
- Vision, ADR, review, and API documentation retain distinct authority.
- Generated reference files are deterministic and must not be edited manually.
- No documentation tool may add runtime dependencies or browser code.
- The repository remains the documentation authority even if a site is added later.

---

### Task 1: Documentation Fact Generator And Tests

**Files:**
- Create: `scripts/api-docs.mjs`
- Create: `scripts/api-docs-lib.mjs`
- Create: `docs/api/api-docs.json`
- Create: `tests/api-docs.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `packages/geoscratch/src/scratch.ts`, `packages/geoscratch/src/geo/index.ts`.
- Produces: `generateApiDocumentation()`, `checkApiDocumentation()`, normalized JSON and Markdown reference files.

- [ ] Write tests proving complete export enumeration, deterministic output, missing-summary failure, invalid API reference failure, and stale generated-file detection.
- [ ] Run `npx mocha tests/api-docs.test.js` and confirm the missing implementation fails.
- [ ] Add TypeDoc as a development dependency and implement normalized fact extraction without exposing TypeDoc JSON as a repository contract.
- [ ] Generate `scratch-api.json`, `geo-api.json`, `scratch.md`, and `geo.md` under `docs/api/reference/`.
- [ ] Run `npx mocha tests/api-docs.test.js` and confirm all generator tests pass.

### Task 2: Canonical And Translated Semantic Wiki

**Files:**
- Create: `docs/api/README.md` and `docs/api/README_zh.md`
- Create: `docs/api/scratch/*.md` and paired `*_zh.md` files
- Create: `docs/api/geo/*.md` and paired `*_zh.md` files

**Interfaces:**
- Consumes: generated public symbol ids in the form `geoscratch/scratch#Name` and `geoscratch/geo#Name`.
- Produces: canonical subsystem explanations and Chinese translations with exact counterpart metadata.

- [ ] Document every Scratch subsystem, including ownership, lifecycle, composition, diagnostics, non-responsibilities, API groups, examples, and ADR links.
- [ ] Document every Geo subsystem with the same required semantic sections.
- [ ] Translate every canonical page into Chinese without translating code identifiers or changing API commitments.
- [ ] Register every page in both language navigation roots and link each translation pair bidirectionally.

### Task 3: Translation, Link, And Coverage Gates

**Files:**
- Modify: `scripts/api-docs-lib.mjs`
- Modify: `scripts/api-docs.mjs`
- Modify: `tests/api-docs.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run docs:generate`, `npm run docs:translations`, and read-only `npm run docs:check`.

- [ ] Test duplicate document ids, missing translations, stale canonical digests, broken relative links, unknown API symbol references, missing navigation entries, and generated drift.
- [ ] Implement strict front-matter parsing and canonical-body digesting.
- [ ] Implement Markdown link and `api:` symbol validation using generated facts.
- [ ] Make `docs:check` regenerate in memory and compare bytes without mutating tracked files.
- [ ] Run `npm run docs:check` and confirm a clean result.

### Task 4: Source Documentation Coverage

**Files:**
- Modify: public declarations under `packages/geoscratch/src/scratch/`
- Modify: public declarations under `packages/geoscratch/src/geo/`
- Modify: generated reference files under `docs/api/reference/`

**Interfaces:**
- Produces: a non-empty source summary for every public runtime class, function, and variable.

- [ ] Use generated missing-summary diagnostics to enumerate undocumented runtime exports.
- [ ] Add concise TSDoc that states behavior and ownership rather than restating names.
- [ ] Regenerate references and repeat until source documentation coverage is complete.
- [ ] Run package build and typecheck to prove comments did not alter declarations or behavior.

### Task 5: Repository Agent Contract And Integration

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `package.json`
- Create: `docs/decisions/ADR-071-bilingual-api-knowledge-system.md`

**Interfaces:**
- Produces: mandatory authority, reading, updating, and verification rules for future agents and contributors.

- [ ] Write the root agent contract with exact pre-reading and documentation update triggers.
- [ ] Document the API Wiki and commands from both root READMEs.
- [ ] Record the accepted authority and drift-gate decision in ADR-071.
- [ ] Integrate `docs:check` into root `test` and `typecheck` scripts.
- [ ] Run `npm run docs:check`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Review the final diff for generated noise, stale terminology, untranslated commitments, and accidental implementation changes.
