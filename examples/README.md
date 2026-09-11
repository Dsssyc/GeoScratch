# GeoScratch Examples

Run `npm run dev` from the repository root and open the Vite URL to browse examples. The examples browser lives at `examples/index.html`; each runnable demo also has a standalone page at `examples/<name>/index.html`.

Run `npm run backend:setup` once with Python 3.12–3.14. The root development
command owns Vite and one shared backend for both Underwater Terrain and Flow
Field; switching examples never switches processes. `Ctrl+C` stops the owned
services. A service startup/runtime exit also stops its peer. Use
`npm run dev:frontend` or `npm run dev:backend` for separate development.
The workspace's own `npm --workspace examples run dev` remains a frontend-only
Vite entrypoint for existing tools.

Frontend defaults are same-origin `/api/dem/` and `/api/flow/`. Vite dev and
preview proxy `/api` to the backend. Its default address is configured in
`backend/config.json`; set `EXAMPLES_BACKEND_PORT` in the launching shell to
override the port for both processes. Explicit `?tileServer=` URLs remain
available for external or standalone services. See the
[backend guide](./backend/README.md) for data preparation and diagnostics.

Keep example runtime code in `main.ts` and place only page shell concerns, such as the shared canvas and external scripts, in the matching HTML file.

Keep ordinary example assets beside the example that owns them. Use relative asset URLs for images and raw shader imports for WGSL files. Reserve `examples/public/` for large local data that must be loaded by stable absolute URL, such as `/json/examples/flow/station.bin`.

`Flow Field` is the independent velocity-only Virtual Raster consumer. It tiles the
27 time slices, derives advectable support and its visible contour on the GPU, and
keeps canonical particles independent of page residency. `Flow Layer` remains a
frozen reference implementation. Flow-specific composition stays inside
`examples/flowField/` until reuse evidence justifies a separate package decision.

Scratch examples must `await` persistent buffer, texture, sampler, query-set, bind-layout, and bind-set creation. Buffer consumers receive explicit `BufferRegion` values, while persistent texture bindings and pass attachments receive logical `TextureViewSpec` values. Examples must not pass whole BufferResource or TextureResource objects where one of those views is required.

A changed `TextureResource.resize()` must be awaited before the example relies on the replacement allocation; the same-size path returns an already-resolved promise. Replacement makes every affected BindSet stale, so reuse requires an explicit acknowledged `await bindSet.prepare()` before submission. Submission never creates or repairs persistent native bindings. Examples must not add synchronous compatibility helpers or reach into library source.

Scratch examples must also `await` render and compute pipeline creation. A pipeline wrapper is ready only after native async creation, compilation information, supporting-object scopes, and lifecycle checks settle successfully. Examples must not add immediate native fallbacks, lazy first-use compilation, or command/submission waits. Similarly named top-level renderer calls in explicitly legacy examples are a separate API and must not be silently converted by adding `await`.

Runtime allocation diagnostics are available through the read-only `runtime.diagnostics` facade. Examples that need machine-readable evidence should publish a bounded `runtime.diagnostics.exportEvidence()` result or selected immutable facts rather than copying browser console text or retaining native GPU handles.

`bufferMapping/` is the deterministic host-ownership proof. It initializes an
arbitrary-usage source through `createMappedBuffer()`, releases the WRITE
lease, performs a GPU-side `CopyCommand`, maps the destination through a READ
lease, verifies exact values, and proves that both native views detach after
release. It uses only the public `geoscratch` package API.

`submissionOrder/` is the deterministic queue-ordering proof. It must report `document.body.dataset.status === "passed"` and `document.body.dataset.result === "11"` in a WebGPU-capable browser.

`externalImageUpload/` is the deterministic native external-image upload proof. It constructs the command before mutating a local source canvas, uploads a cropped and vertically flipped region, verifies exact padded readback bytes, renders the same texture, and reports the result through `document.body.dataset.status`, `expectedBytes`, and `actualBytes`.

`textureResize/` is the deterministic logical-texture replacement proof. It explicitly resizes a surface, awaits one persistent `TextureResource` replacement transaction, observes the existing BindSet becoming stale, explicitly prepares it, and then reuses the same `BindSet`, `PassSpec`, `DrawCommand`, and `TextureViewSpec`. It renders through the acknowledged replacement allocation, copies it to a padded buffer, verifies exact padded readback bytes, and publishes identity, version, readiness, destruction, preparation, reuse, and byte-match facts through `document.body.dataset`.
