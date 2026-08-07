# DEM Tile Wireframe Debug View Design

## Goal

Add a live DEM rendering mode that exposes the exact GPU-selected tile set and
the triangle topology after mesh stitching. Each logical tile receives a stable
pseudo-random color, and only triangle edges remain visible. A checkbox in the
DEM control panel switches between shaded terrain and this diagnostic view
without rebuilding the DEM graph, virtual raster, frontier, or pipelines.

## Source Facts

- The terrain draw is a non-indexed, indirect `triangle-list` draw. The vertex
  shader dereferences the shared index and position storage buffers.
- Mesh stitching happens in the terrain vertex shader. Boundary vertices are
  snapped after consulting the GPU-produced LoD map.
- Tile identity is available in every `GpuTileFrontierVisibleInstance` as
  `(matrixLevel, tileRow, tileCol)`.
- A physical atlas slot is transient residency state and must not determine a
  tile's diagnostic color.
- WebGPU core has no polygon-mode state that turns a triangle pipeline into a
  wireframe pipeline.

## Chosen Rendering Model

The shaded and diagnostic modes share the same terrain vertex entry point. The
vertex output gains two values:

- a barycentric coordinate selected from `vertexIndex % 3`; and
- a flat tile color derived from a deterministic integer hash of
  `(matrixLevel, tileRow, tileCol)`.

The existing shaded fragment entry point ignores these values. A second
fragment entry point evaluates barycentric derivatives, discards triangle
interiors, and writes an antialiased premultiplied line color. Because both
modes execute the same vertex entry point, the debug view observes the real
high-precision position calculation, virtual-raster elevation sampling, LoD
neighbor lookup, and boundary vertex snapping. It does not maintain a second
interpretation of mesh stitching.

The hash must be stable across frames, camera movement, atlas eviction, page
reload, and physical-slot reuse. Colors are constrained away from black so
adjacent visible tiles remain inspectable over the dark map. Exact global color
uniqueness is not claimed for an unbounded tile matrix; the contract is a
deterministic low-collision diagnostic color keyed by logical tile identity.

## Persistent GPU Graph

Initialization creates all render objects once:

- shaded terrain program, pipeline, and one command per frontier parity;
- tile-wireframe terrain program, pipeline, and one command per parity; and
- the existing LoD-map program, pipeline, and commands.

The graph owns a `shaded | tile-wireframe` presentation state. A setter changes
only that state. `renderFrame()` selects the already-created terrain command for
the current presentation and frontier parity. No shader compilation, pipeline
creation, bind-set preparation, resource upload, virtual-raster mutation, or
frontier reset is allowed during a mode switch.

Provenance checks use the terrain command actually submitted in that frame.
Stable-identity facts include both persistent presentation paths, so switching
modes cannot alter the graph identity hash or persistent runtime counts.

## Control Panel

The existing Tweakpane becomes a DEM-level control surface rather than a cache-
only surface:

- pane title: `DEM Layer`;
- `Rendering` folder: `Tile wireframe` checkbox;
- `Cache` folder: the existing cache policy, status, preference, advanced
  fields, apply button, and reset button.

The checkbox is a live control. It invokes the presentation setter and requests
one render immediately. Its value is stored independently in `localStorage` and
restored on the next page load. It does not participate in cache URL parameters
or require `Apply & Reload`. Invalid or unavailable rendering preference
storage falls back to shaded terrain without blocking DEM initialization.

The page publishes the active presentation and panel state as DOM dataset facts
for deterministic browser verification.

## Ownership And Lifetime

The feature remains owned by `examples/demLayer/`. It demonstrates how Scratch
render programs and immutable draw commands can represent a live diagnostic
view, but it does not add tile-specific API to Scratch or Geo.

Both terrain presentation paths share the existing buffers, bind layouts, bind
sets, textures, pass, indirect arguments, frontier, and virtual raster. Their
program, pipeline, and command wrappers follow the same page/runtime lifetime as
the current graph. The toggle retains no frame history and allocates no GPU or
CPU data.

## Failure Behavior

- Failure to compile either persistent terrain pipeline fails initialization
  through the existing structured GPU diagnostics path.
- A malformed stored rendering preference is removed when possible and treated
  as `false`.
- A toggle after page disposal is ignored by the mounted UI owner and rejected
  by the graph presentation setter if called directly.
- Mode changes made while a frame is in flight affect the next frame only.

## Verification

Unit and fake-GPU tests must prove:

- logical tile keys produce deterministic colors and the shader does not use
  `physicalSlot` for color;
- the wireframe fragment path discards triangle interiors and uses barycentric
  derivatives;
- both terrain pipelines and both parity command sets are created before the
  first frame;
- toggling changes the submitted terrain command while preserving graph
  identity and persistent resource counts;
- rendering preference parsing, persistence, invalid-state fallback, and panel
  callback behavior are deterministic.

Real Chrome WebGPU proof must demonstrate:

- the default shaded view still renders;
- enabling the checkbox switches live to a nonblank multicolor triangle
  wireframe at a pitched camera angle;
- multiple logical tiles have visibly distinct stable colors;
- disabling the checkbox restores shaded terrain;
- both toggles preserve graph identity and do not create additional pipelines,
  programs, commands, buffers, textures, or bind sets; and
- no uncaptured WebGPU error, page error, or console error occurs.

## Non-Goals

- A generic Scratch wireframe abstraction.
- CPU-generated or compute-generated edge buffers.
- Native line-list replacement geometry.
- Atlas-slot visualization.
- Tile labels, picking overlays, or frontier statistics overlays.
- Changes to LoD selection, virtual-raster residency, or mesh-stitching rules.
