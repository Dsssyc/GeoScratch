# ADR-062: Make Scratch Persistent Cache Lifecycle Explicit

## Status

Accepted

## Date

2026-08-07

## Context

ADR-058 defined `PersistentCache.dispose()` as connection disposal without data
deletion. That is correct for durable editing and recovery data, but the public
descriptor did not require an application to state whether a namespace should be
reused, reset on startup, or scoped to one application session. The Underwater Terrain example
also reduced the choice to `none | persistent` while hard-coding persistence and
budget details.

A `clearOnClose` boolean would not provide a truthful browser contract. Page
termination, process failure, and a non-awaited `pagehide` handler can prevent an
asynchronous IndexedDB/OPFS cleanup from finishing. Conversely, treating every
cache as durable can retain high-churn visualization pages longer than the
application intends.

## Decision

### Required lifecycle policy

Every `PersistentCache.open()` descriptor must include exactly one lifecycle:

```ts
type PersistentCacheLifecycle =
    | { kind: 'durable'; open: 'reuse' | 'clear-before-open' }
    | { kind: 'session' }
```

The policy is snapshotted by the cache and reported by `inspect()`.

- `durable/reuse` preserves committed entries across disposal and later opens.
- `durable/clear-before-open` clears committed entries and immediately reclaims
  namespace journals and orphan payloads before `open()` resolves.
- `session` performs the same open-time reset, then clears entries, journals, and
  payloads when an explicitly awaited `dispose()` runs.

An open-time reset is part of opening the cache. Storage failure rejects `open()`;
the implementation does not return an instance that silently retained old data.
Session cleanup failure rejects `dispose()`, but the database connection is still
closed and the instance still reaches `disposed`.

### Browser termination boundary

`session` guarantees that a later session opening the same namespace does not
reuse content left by an earlier session. It does not claim that physical deletion
completed at the instant a tab crashed or was terminated. Explicit disposal
performs cleanup immediately; a later session's open-time reset recovers residue
from an unclean termination.

Lifecycle reset is namespace-wide and destructive. Independent active contexts
must not claim conflicting lifecycle authority over the same namespace. An
application that needs multiple contexts coordinates their opening and disposal or
assigns distinct namespaces, as the DEM Worker shards do.

### Orthogonal persistence and application policy

`requestPersistence` remains an independent request to the browser storage
manager. It does not control application retention and does not turn a session
cache into a durable cache.

Scratch still has no built-in JavaScript memory cache. A session cache uses the
same IndexedDB and OPFS path and therefore still performs disk-backed writes. A
high-churn visualization that does not want those writes omits cache construction;
GPU residency, in-flight request coalescing, and application memory remain separate
policies.

Applications own namespace, budgets, persistence request, and lifecycle selection.
The Underwater Terrain example must expose those choices instead of embedding one persistent
policy.

## Alternatives Rejected

- **Implicit durable reuse:** rejected because callers cannot audit retention intent.
- **`clearOnClose: boolean`:** rejected because browser termination cannot guarantee
  asynchronous cleanup completion.
- **A Scratch-owned memory/session tier:** rejected because application working-set
  policy remains outside the generic persistent cache.
- **Worker-coupled cache cleanup:** rejected because Worker and Cache are independent
  Scratch capabilities with separate lifecycle authority.

## Consequences

- Editing applications can deliberately retain recovery data across restarts.
- Visualization applications can select no disk cache, reset-on-open storage, or a
  session-scoped disk cache according to their workload.
- Diagnostics expose the active lifecycle rather than requiring callers or agents
  to reconstruct it from startup code.
- ADR-058's storage and commit model remains accepted; this decision replaces only
  its implicit durable lifecycle assumption.
- ADR-059's `none | persistent` DEM boundary is refined so persistent mode also
  carries explicit lifecycle, budget, and persistence-request policy.
