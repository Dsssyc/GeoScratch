# README preview

`DayDream.webp` is the looping banner used by both repository READMEs. Its relative
link follows the branch being viewed on GitHub. Commit the image together with the
README changes; no running example server is needed to display it.

GitHub supports [inline WebP images](https://github.blog/changelog/2025-08-28-added-support-for-webp-images/).
Animated WebP retains full-color gradients and enough intermediate frames for
smooth particle motion without the size of an equivalent long GIF.

The left branding is rendered from `preview-branding.html`, using the existing
`icons/icon_light.png` logo and a project name plus short description. The globe is
captured from `examples/helloGAW/index.html?proof=1` in an isolated headless Chrome
session using the existing WebGPU renderer, shaders, textures, and seeded particles.
The complete 2520 × 1440 black-background viewport has the same aspect ratio as
the final banner. A capture-only Vite transform adjusts the existing camera's
projection scale and offset to place the globe at (580, 240) in the 840 × 480
output. It checks its source anchor before applying the transform. The renderer,
shaders, source files, and normal example behavior are unchanged.

The entire rendered frame is downsampled uniformly, then transparent branding is
overlaid at (0, 0). There is no separate globe image rectangle, crop, padding,
image translation, or feather mask. Each admitted simulation frame waits for the
example's GPU observation; resizing during capture is rejected.

To regenerate, install dependencies with `npm ci`, install Google Chrome and
`ffmpeg` plus `cwebp` and `webpmux` (from libwebp), and run from the repository root:

```sh
npm --workspace geoscratch run build
node scripts/render-readme-preview.mjs
```

Check layout changes with one real rendered frame before exporting the full loop:

```sh
node scripts/render-readme-preview.mjs /tmp/geoscratch-preview.png --still
```

The script starts and closes its own localhost Vite server and browser. It requires
a working headless WebGPU adapter and never launches a foreground browser. Pass an
optional output path as the first argument. Set `KEEP_PREVIEW_FRAMES=1` to retain
temporary source frames and the JSON render evidence for inspection.

The banner is 840 × 480 with 600 frames over thirty seconds at 20 fps, looping
indefinitely. One loop contains exactly one Earth turn: the example's 1000
simulation steps wrap the land texture once and the cloud texture twice. Each
sample advances one or two original simulation steps, averaging 33⅓ simulation
steps per second of playback for continuous particle motion.

Forty extra samples blend the non-periodic particles over two seconds at the loop
boundary. Their land and cloud phases match the beginning exactly modulo a full
texture wrap, so the blend introduces no additional Earth rotation. The static
branding stays stationary. Only the globe receives a black-preserving RGB gamma lift
(`output = 255 × (input / 255)^0.8`) to bring its midtones closer to the original
PNG. Light smoothing reduces screen-pattern aliasing. WebP is encoded at quality
50 without GIF palette reduction or additional dithering. Compression preserves
all 600 frames and their 50 ms duration, so it does not alter rotation or particle timing.

Each frame is encoded independently with `cwebp`, then `webpmux` assembles complete
opaque frames with blending and disposal disabled. Do not use animation rectangle
optimization such as `img2webp -min_size`: it can exclude dark changing bloom from
the update rectangle, creating a vertical cutoff even when the original PNG is
correct. `readme-webp.mjs` checks every final ANMF record for full-canvas geometry,
replacement flags, and timing. Tests include the actual cropped rectangle metadata
from the previously broken frame 342, without committing the obsolete large image.

Before committing a replacement, inspect the full animation, verify its frame
count and loop metadata, check that both README image paths exist, and confirm
the capture reports no page, network, or GPU failures. Compare decoded animation
frames against their source PNGs, especially the brightest left-facing glow.
Checking original-frame borders alone cannot detect encoding-induced cutoffs.
