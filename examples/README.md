# GeoScratch Examples

Run `npm run dev` from the repository root and open the Vite URL to browse examples. The examples browser lives at `examples/index.html`; each runnable demo also has a standalone page at `examples/<name>/index.html`.

Keep example runtime code in `main.js` and place only page shell concerns, such as the shared canvas and external scripts, in the matching HTML file.

Keep ordinary example assets beside the example that owns them. Use relative asset URLs for images and raw shader imports for WGSL files. Reserve `examples/public/` for large local data that must be loaded by stable absolute URL, such as `/json/examples/flow/station.bin`.

`submissionOrder/` is the deterministic queue-ordering proof. It must report `document.body.dataset.status === "passed"` and `document.body.dataset.result === "11"` in a WebGPU-capable browser.
