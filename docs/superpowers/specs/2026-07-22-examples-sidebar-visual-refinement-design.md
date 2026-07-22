# Examples Sidebar Visual Refinement

## Goal

Refine the examples catalog without changing its layout or interaction model. The navigation must remain independently scrollable while its scrollbar is visually hidden, and every example item must have a subtle surface color that separates it from the sidebar background.

## Design

Update only `examples/shared/index.css`:

- Keep `.examples-nav` as the scroll container with `overflow: auto` and the existing height constraints.
- Hide the scrollbar cross-browser with `scrollbar-width: none`, `-ms-overflow-style: none`, and a hidden `::-webkit-scrollbar` pseudo-element.
- Give `.example-link` the normal background `#1a2028`.
- Keep the existing hover, focus, and active background `#202833`, preserving a clear interaction hierarchy.

Scrollbar hiding is visual only. Mouse-wheel, trackpad, touch, keyboard focus, and programmatic scrolling must continue to work. No JavaScript behavior changes are required.

## Verification

- Extend the examples structure test first so it fails until all cross-browser scrollbar rules and both item-state colors are present.
- Verify the focused test passes after the CSS change, then run the full test and build gates.
- In a real browser, verify the scrollbar is absent, wheel scrolling reaches the final item, a bottom item remains clickable, keyboard focus can bring off-screen items into view, and the page has no console errors or warnings.
- Check the layout at 320, 768, 1024, and 1440 pixels wide.

## Non-goals

- Do not change sidebar width, item spacing, typography, search behavior, or selection logic.
- Do not replace scrolling with custom JavaScript.
- Do not alter example content or rendering.
