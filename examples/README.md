# GeoScratch Examples

Run `npm run dev` from the repository root and open the Vite URL to browse examples. The examples browser lives at `examples/index.html`; each runnable demo also has a standalone page at `examples/<name>/index.html`.

Keep example runtime code in `main.js` and place only page shell concerns, such as the shared canvas and external scripts, in the matching HTML file.

Keep ordinary example assets beside the example that owns them. Use relative asset URLs for images and raw shader imports for WGSL files. Reserve `examples/public/` for large local data that must be loaded by stable absolute URL, such as `/json/examples/flow/station.bin`.

Scratch examples must `await` persistent buffer, texture, sampler, query-set, bind-layout, and bind-set creation. Buffer consumers receive explicit `BufferRegion` values, while persistent texture bindings and pass attachments receive logical `TextureViewSpec` values. Examples must not pass whole BufferResource or TextureResource objects where one of those views is required.

A changed `TextureResource.resize()` must be awaited before the example relies on the replacement allocation; the same-size path returns an already-resolved promise. Replacement makes every affected BindSet stale, so reuse requires an explicit acknowledged `await bindSet.prepare()` before submission. Submission never creates or repairs persistent native bindings. Examples must not add synchronous compatibility helpers or reach into library source.

Scratch examples must also `await` render and compute pipeline creation. A pipeline wrapper is ready only after native async creation, compilation information, supporting-object scopes, and lifecycle checks settle successfully. Examples must not add immediate native fallbacks, lazy first-use compilation, or command/submission waits. Similarly named top-level renderer calls in explicitly legacy examples are a separate API and must not be silently converted by adding `await`.

Runtime allocation diagnostics are available through the read-only `runtime.diagnostics` facade. Examples that need machine-readable evidence should publish a bounded `runtime.diagnostics.exportEvidence()` result or selected immutable facts rather than copying browser console text or retaining native GPU handles.

`submissionOrder/` is the deterministic queue-ordering proof. It must report `document.body.dataset.status === "passed"` and `document.body.dataset.result === "11"` in a WebGPU-capable browser.

`externalImageUpload/` is the deterministic native external-image upload proof. It constructs the command before mutating a local source canvas, uploads a cropped and vertically flipped region, verifies exact padded readback bytes, renders the same texture, and reports the result through `document.body.dataset.status`, `expectedBytes`, and `actualBytes`.

`textureResize/` is the deterministic logical-texture replacement proof. It explicitly resizes a surface, awaits one persistent `TextureResource` replacement transaction, observes the existing BindSet becoming stale, explicitly prepares it, and then reuses the same `BindSet`, `PassSpec`, `DrawCommand`, and `TextureViewSpec`. It renders through the acknowledged replacement allocation, copies it to a padded buffer, verifies exact padded readback bytes, and publishes identity, version, readiness, destruction, preparation, reuse, and byte-match facts through `document.body.dataset`.
