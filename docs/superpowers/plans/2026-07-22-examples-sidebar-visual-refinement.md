# Examples Sidebar Visual Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the examples navigation scrollbar without disabling scrolling, and give every example item a subtly lighter normal surface.

**Architecture:** Keep the existing HTML and JavaScript unchanged. Extend the current source-structure regression coverage, then make a CSS-only change to the existing navigation and link rules so native scrolling remains authoritative across desktop and mobile layouts.

**Tech Stack:** CSS, Mocha, Chai, Vite, Playwright CLI

## Global Constraints

- Keep `.examples-nav` as the native scroll container with `overflow: auto` and its existing height constraints.
- Hide the scrollbar with `scrollbar-width: none`, `-ms-overflow-style: none`, and `.examples-nav::-webkit-scrollbar { display: none; }`.
- Set the normal `.example-link` background to `#1a2028`.
- Keep hover, focus, and active backgrounds at `#202833`.
- Preserve mouse-wheel, trackpad, touch, keyboard-focus, and programmatic scrolling.
- Do not change sidebar width, item spacing, typography, search behavior, selection logic, example content, rendering, or JavaScript.

---

### Task 1: Refine the examples navigation surface

**Files:**
- Reference: `docs/superpowers/specs/2026-07-22-examples-sidebar-visual-refinement-design.md`
- Modify: `tests/examples-structure.test.js:237-249`
- Modify: `examples/shared/index.css:87-110`

**Interfaces:**
- Consumes: Existing `.examples-nav`, `.example-link`, `.example-link:hover`, `.example-link:focus`, and `.example-link.is-active` CSS selectors.
- Produces: A native scroll container with no visible scrollbar, `#1a2028` normal item surfaces, and the existing `#202833` interactive surface.

- [ ] **Step 1: Extend the CSS regression tests**

Replace the current sidebar scrolling test and add the item-surface test with:

```js
    it('hides the examples scrollbar without disabling navigation scrolling', () => {
        const css = read('examples', 'shared', 'index.css')
        const sidebarRule = css.match(/\.examples-sidebar\s*\{([^}]*)\}/)?.[1] ?? ''
        const navigationRule = css.match(/\.examples-nav\s*\{([^}]*)\}/)?.[1] ?? ''
        const webkitScrollbarRule = css.match(/\.examples-nav::-webkit-scrollbar\s*\{([^}]*)\}/)?.[1] ?? ''

        expect(sidebarRule).to.match(/min-height:\s*0/)
        expect(navigationRule).to.match(/min-height:\s*0/)
        expect(navigationRule).to.match(/overflow:\s*auto/)
        expect(navigationRule).to.match(/scrollbar-width:\s*none/)
        expect(navigationRule).to.match(/-ms-overflow-style:\s*none/)
        expect(webkitScrollbarRule).to.match(/display:\s*none/)
    })

    it('distinguishes normal and interactive example item surfaces', () => {
        const css = read('examples', 'shared', 'index.css')
        const linkRule = css.match(/\.example-link\s*\{([^}]*)\}/)?.[1] ?? ''
        const interactiveRule = css.match(/\.example-link:hover,\s*\.example-link:focus,\s*\.example-link\.is-active\s*\{([^}]*)\}/)?.[1] ?? ''

        expect(linkRule).to.match(/background:\s*#1a2028/)
        expect(interactiveRule).to.match(/background:\s*#202833/)
    })
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```bash
npx mocha tests/examples-structure.test.js --grep "examples scrollbar|example item surfaces"
```

Expected: two failures because the scrollbar-hiding declarations, WebKit pseudo-element rule, and normal item background do not exist yet.

- [ ] **Step 3: Implement the minimal CSS change**

Change the affected rules to:

```css
.examples-nav {
    min-height: 0;
    overflow: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    padding: 10px;
}

.examples-nav::-webkit-scrollbar {
    display: none;
}

.example-link {
    display: grid;
    gap: 4px;
    border-radius: 6px;
    padding: 12px 10px;
    background: #1a2028;
    text-decoration: none;
}
```

Leave the existing interactive rule unchanged:

```css
.example-link:hover,
.example-link:focus,
.example-link.is-active {
    background: #202833;
    outline: none;
}
```

- [ ] **Step 4: Run the focused tests and verify the green state**

Run:

```bash
npx mocha tests/examples-structure.test.js --grep "examples scrollbar|example item surfaces"
```

Expected: `2 passing`.

- [ ] **Step 5: Verify the native browser behavior**

Start the documented development command:

```bash
npm run dev
```

Open the reported localhost URL with the Playwright CLI. At widths 320, 768, 1024, and 1440 pixels, verify:

- `.examples-nav` has `scrollHeight > clientHeight` wherever the catalog overflows.
- `getComputedStyle(nav).overflowY` is `auto` and `getComputedStyle(nav).scrollbarWidth` is `none`.
- `getComputedStyle(nav, '::-webkit-scrollbar').display` is `none`.
- A normal item background is `rgb(26, 32, 40)` and the active item background is `rgb(32, 40, 51)`.
- Wheel scrolling reaches the last item, and clicking Flow Layer or Hello GAW updates the URL, title, and active item.
- Repeated Tab navigation brings an initially off-screen bottom item into view and allows Enter to activate it.
- The browser console reports zero errors and zero warnings.

Stop the development server and close the browser session after verification.

- [ ] **Step 6: Run the complete repository gates**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: the full Mocha suite has zero failures, the production build exits successfully, and `git diff --check` produces no output.

- [ ] **Step 7: Review and commit the implementation**

Review only the intended CSS and regression-test changes, scan the staged diff for secrets, then run:

```bash
git add examples/shared/index.css tests/examples-structure.test.js
git commit -m "Refine examples sidebar styling"
```

Expected: one focused implementation commit, with ignored build and Playwright artifacts excluded.
