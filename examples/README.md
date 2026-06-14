# GeoScratch Examples

Run `npm run dev` from the repository root and open the Vite URL to browse examples. The examples browser lives at `examples/index.html`; each runnable demo also has a standalone page at `examples/<name>/index.html`.

Keep example runtime code in `main.js` and place only page shell concerns, such as the shared canvas and external scripts, in the matching HTML file.

Static assets served by Vite live in `examples/public/`. Example code may load those assets with absolute paths such as `/shaders/examples/GAW/land.wgsl` or `/images/Earth/earth.jpg`.
