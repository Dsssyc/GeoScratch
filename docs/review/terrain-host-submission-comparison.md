# Terrain host submission and cover placement comparison

Date: 2026-09-10. Follows the [host attribution and implementation audit](./terrain-host-submission-performance.md).

The instrumentation follows the [DevTools Profiler protocol](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).


The available non-main display is 144 Hz, not 120 Hz. A dedicated Chrome 152
instance is launched in the background with a unique temporary profile and its
whole window inside that display. Bounds are verified before and after each run.
An AppKit activation observer verifies that the owned browser never becomes the
foreground app; the user can switch between other apps. Every accepted run closes
its browser/profile, foreground observer, Vite and read-only tile service. One
earlier attempt used an overly strict unchanged-foreground-PID check and aborted
before measurement; it is excluded. No display setting or existing browser was
changed.

The accepted 52-bit GPU/CPU paired traces (`native-52-gpu-2`, `native-52-gpu-3`,
`native-52-cpu-all-1b`, `native-52-cpu-all-2`) have approximately 6.9-ms median
host intervals. The following ranges are the two per-run statistics, not pooled
percentiles. CPU means cover plus source intent; GPU drawing/residency remain.

| Scope | GPU | CPU cover + source intent |
| --- | ---: | ---: |
| Shaded construction p50 | 1.1–1.2 ms | 1.4 ms |
| Shaded native observation p50 | 5.6–5.7 ms | 4.8–4.9 ms |
| Shaded native observation p95 | 7.7–7.8 ms | 7.8 ms |
| Wireframe construction p50 | 1.0–1.1 ms | 1.3–1.4 ms |
| Wireframe native observation p50 | 8.4–9.2 ms | 7.6–7.7 ms |
| Wireframe native observation p95 | 10.5–15.0 ms | 8.2–8.4 ms |
| Shaded admitted frames per 90 moves, including confirmation | 90–91 | 91 |
| Wireframe admitted frames per 90 moves, including confirmation | 86–90 | 90 |
| Submitted-camera lag p95, shaded / wireframe | 0 / 0–1 moves | 0 / 0 moves |
| First request after cold move | 14.5–20.3 ms | 7.0–8.5 ms |
| Acknowledged selected-resource readiness, 20-ms polling | 166.5–168.5 ms | 124.5–147.1 ms |

Maximum in-flight work remains two. One GPU wireframe trace has a two-move maximum
lag; the other GPU wireframe and both CPU wireframe traces have a one-move maximum.
Every trace drains to the current submitted capture with no pending work. Admission
includes confirmation frames and is not the count of unique camera poses displayed.
The full-scenario page-main-thread task totals are 1,218–1,230 ms GPU versus
1,178–1,202 ms CPU. These include all four traces (two timestamped), A-B-A, loading,
MapLibre and proof publication; the different frame counts and observer work mean
they are not isolated per-frame terrain CPU cost. They do not establish that CPU
selection lowers total application CPU on other workloads.

The shared diagnostic optimization was separately replayed in `before, after,
before, after` order on that same display. Only its three diagnostic modules came
from `006c7d2` in the before runs; every served module hash is retained. Shaded
construction p50 is 1.3 ms before and 1.2 ms after; wireframe is 1.1–1.2 ms before
and 1.1 ms after. Whole-scenario task totals are 1,289–1,308 ms before versus
1,277–1,288 ms after, with differing admission counts. Native-observation results
remain variable. This supports a small host-cost reduction, not a large frame-rate
gain. Raw runs: `native-submit-before-{1,2}` and `native-submit-after-{1,2}`.

Accept the bounded diagnostic optimization. Keep the current GPU selector as the
production authority for this change; do not add another live selector or a mode
switch. This is a migration/correctness decision, not a claim that GPU cover won
the performance comparison. CPU selection has a repeated latency advantage in this
tested scene, with a modest increase in synchronous construction. Further GPU-cover
complexity is not justified by these results alone. Promoting the CPU prototype
would require the explicit product/upload ownership contract and CPU construction
failure boundaries already identified in the placement audit; temporary source
substitutions and unused GPU allocations are not that contract.

The final 52-bit CPU rendering and streaming gates and GPU/CPU shadow rendering
gate pass. A 1,000-ms delayed GPU-feedback run starts all 18 requests during motion,
zero afterward, and drains at the final capture with zero pending tasks. Together
with the production lifecycle, complete cover/2:1/DPR/overflow and native failure
gates above, this closes the current bounded comparison. It does not establish
cross-device superiority or equivalence at every floating-point threshold.

Checkpoints: `006c7d2` adds attribution, `4be1c01` corrects proof assumptions, and
`13d5670` implements the diagnostic optimization. Revert `13d5670` to remove the
production optimization while keeping its measurement tools; subsequent experiment
and report changes are independently removable. No frozen Flow Layer or backend
data was changed.

The final checkout passes typecheck, all 1,739 tests (two opt-in pending), build
and read-only docs validation (828 public symbols, 20 canonical pages and 20
translations). Final headless GPU/CPU sampler checks also retain all 89 raw lag
samples per trace and reject observations from another trace. The production
optimization's complete reverse patch passes `git apply --reverse --check` against
this checkout, so `git revert 13d5670` remains independent of this later report.
