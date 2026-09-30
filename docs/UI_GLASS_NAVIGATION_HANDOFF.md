# Batcave: persistent navigation and readability

September 30, 2026. Scope: the queued screenshot edit only. No calculations,
data providers, scoring, permissions, brokerage settings or native iOS code
were changed.

## Implemented design

- Main desktop tab dock sticks below the header throughout the active panel.
- Header height is measured with ResizeObserver, including font changes,
  viewport changes and safe-area padding; no fragile fixed-height assumption.
- Horizontal tab overflow stays inside the dock, and selection centers the
  active tab. Selecting a different workspace from deep in a panel returns
  to its start instead of stranding the user at the previous scroll depth.
- Restrained translucent glass on header/tab/mobile navigation, with blur,
  saturation, hairline borders and a quiet raised active pill. Data panels
  remain unfiltered and readable.
- Mobile bottom navigation remains fixed, inset and safe-area aware.
- Desktop rem scale increases from 16px to 17px; legacy 8–10px labels become
  12px, 11–12px text becomes 13px and small body text becomes 15px. Content
  width increases modestly from 1800px to 1920px.
- Reduced-motion and reduced-transparency alternatives plus an opaque
  unsupported-backdrop fallback. Existing tab order and data tools preserved.

## QA inventory

- Desktop 1440px: Edge Lab at top and deep scroll; header/dock bounding boxes
  do not overlap; each visible tab remains clickable.
- Desktop 1024px and 1920px: no document-level horizontal overflow; all eleven
  tabs reachable, using internal horizontal scrolling where required.
- Deep tab switch: new panel starts under the navigation, not at stale depth.
- Phone 375px/390px: bottom dock remains inside viewport after scrolling;
  late tabs can be selected; bottom content can scroll clear of the dock.
- Theme switch: light and dark nav surfaces and active/focus states readable.
- Keyboard navigation and reduced-motion path.
- Resize/zoom-style header change: dock offset follows measured header.
- Desktop computed typography confirms a modest readable increase, without
  applying scale/zoom to chart data or canvas coordinates.
- Existing build/type-check baseline: record any new diagnostics; no claims
  that the unrelated project-wide type errors were fixed.

## Verification

Production build passed. TypeScript has the same 59 pre-existing diagnostics
and no new dashboard errors. `git diff --check` passed.

Chromium browser checks passed at 375, 390, 820, 1024, 1440 and 1920px.
No page errors or document-level horizontal overflow occurred. At 1440px,
the scrolled dock top was 80px, below the 71.77px header. At 820px the dock
used an internal 856px scroll region inside 754px, with both ends selectable.
At 375px the mobile dock was inside x=8..367 and y=738..804 in an 812px
viewport; late-tab selection and returning to panel start passed.

Keyboard ArrowRight selected Crypto from Edge Lab. Theme toggle passed in
both directions; reviewed screenshots in dark and light. Reduced-motion
selection, deep scroll, internal overflow, and desktop-to-phone resize were
exercised. Resize exposed an off-screen active tab, fixed by recentering on
resize and initial data readiness. Header padding stress exposed content-box
measurement, fixed by observing the border box: a 107.77px header produced
a 116px dock offset, with no overlap. Safe-area CSS is present, but no physical
iPhone or native Xcode testing was performed.

Final desktop and phone screenshots were visually reviewed. Text and nav
labels were readable without chart scaling; no new clipping or overlap was
observed in tested views. This is bounded navigation/layout QA, not a fresh
audit of every application panel or live-feed health.

Edge Lab stress data was clearly marked, browser-only fixtures, with unrelated
requests isolated as 503 responses to avoid expensive provider/AI calls.
Fixtures are not in application code or the deployed bundle. No fixture
numbers represent live market readings. Existing backend was not restarted.
