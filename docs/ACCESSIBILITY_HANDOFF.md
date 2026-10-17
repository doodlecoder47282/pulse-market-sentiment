# Batcave shell accessibility handoff

Status: stable for parent integration; parent owns final browser QA and release.

Latest parent QA delta: the live P/C aggregate row exposed a 33px/18px document
overflow at 375px/390px with 200% root text. The owned stylesheet now wraps only
that aggregate's number, zone badge and index/Mag7 details, plus its title/provider
row (a 12:00:00 AM fixture exposed a second 20px overrun); `FlowPanel.tsx`,
provider behavior and financial values are unchanged. No overflow masking or text
reduction. Added focused regression; parent coordinates final delta peer review.
Parent light-theme QA also exposed dark-only regime headline tints. Banner-scoped
light shades now preserve the green/rose/amber/slate meanings with readable text;
dark styles, labels and all underlying regime data remain unchanged.

Final loaded-data follow-up: the Flow Alerts header's 15 alerts / 13 HIGH /
SCHWAB LIVE labels exposed another nowrap row. Scoped rules keyed to
stable header/summary/count classes now wrap the header; clear-all retains a
44px target and visible focus. Every count/status/action remains present.
Parent additionally authorized `FlowAlertsPanel.tsx`: clear-all is now a sibling
of the Radix collapse button, not an invalid nested button. Both controls have
explicit button types, names and 44px targets. Alert computation, queries, dismiss
callbacks and state are unchanged; only header markup changed.
Added regression; final peer AST/code review found no nested-button ancestor and
confirmed the unchanged dismiss callback. Parent owns live-response acceptance.

## Scope and design

Only the dashboard shell, its stylesheet, shell-only helper/component and focused
tests are owned by this worker. No provider, polling, account, storage, forecast,
native or AI behavior changes. iOS remains paused; SPY forecasts and crypto ENTER
remain disabled.

The existing dark/gold/glass treatment and eleven-workspace order remain.
The header now wraps rather than keeping an unbreakable action row. Take Five
moves into that action row: it no longer floats over settings or content.
Header buttons are at least 44 × 44 CSS pixels. Existing responsive visibility
is unchanged; no controls are newly hidden to fit enlarged text.

Both navigation strips have earlier/later scroll buttons and a native horizontal
scrollbar. The desktop retains Radix tabs and automatic Arrow/Home/End selection.
Mobile retains native navigation buttons (`aria-current="page"`); Tab visits
each, Enter/Space activates, and ArrowLeft/Right/Home/End move focus and activate.
Full accessible names complement the existing short mobile labels.

ResizeObserver measures header, regime banner, desktop dock and mobile dock.
Safe-area bottom offsets are read from computed CSS. Document focus/scroll padding
and main bottom clearance use those measurements. When chrome would consume more
than half the available visual viewport, the header/banner return to document flow;
the mobile dock stays fixed and desktop dock sticks near the viewport top so
workspace navigation remains reachable even during deep scrolling.
No nested vertical scroller or document overflow clipping is added. The preexisting
document overflow mask is removed so layout defects cannot be concealed.

Implementation references: `client/src/pages/dashboard.tsx`,
`client/src/index.css`, `client/src/hooks/use-shell-layout.ts`,
`client/src/components/ShellNavScroller.tsx`.

## Parent QA selectors and expectations

- `[data-testid="dashboard-header"]`, `[data-testid="dashboard-regime-banner"]`,
  `[data-testid="dashboard-tabs-dock"]`, `[data-testid="mobile-bottom-nav"]`.
- `.batcave-shell[data-shell-flow="true"]` means the short/tall-text viewport
  fallback is active; header/banner must have `position: static` and scroll away.
  Mobile navigation remains fixed; desktop navigation remains sticky with the
  measured top offset now zero (plus the existing dock gap).
  `false` retains measured sticky header/banner behavior.
- Main target: `#dashboard-main`; first keyboard stop:
  `[data-testid="skip-dashboard-content"]`.
- Header targets: `button-refresh`, `button-settings`, `btn-take-five-fab`;
  at their existing breakpoints also `button-theme-toggle`,
  `button-compact-toggle`, `button-shortcuts-hint`, `schwab-status-pill`.
  All visible targets must be inside viewport and at least 44 × 44.
- Desktop triggers stay `tab-signals`, `tab-chart`, `tab-models`,
  `tab-heatseeker`, `tab-tradedesk`, `tab-regime`, `tab-cosmos`, `tab-news`,
  `tab-takefive`, `tab-edgelab`, `tab-crypto`.
- Mobile buttons stay `bottomnav-` plus the same eleven keys.
  The active desktop trigger has `aria-selected="true"`; the active mobile
  button has `aria-current="page"`. No misleading mobile tab role is added.
- Scroll controls: `desktop-nav-earlier`, `desktop-nav-later`,
  `mobile-nav-earlier`, `mobile-nav-later`. They move the strip without changing
  active workspace. Boundary buttons have `aria-disabled="true"` and remain
  focusable so scrolling does not discard focus. They are absent only when all
  workspaces already fit without scrolling.
- Scroll regions: `desktop-nav-scroll`, `mobile-nav-scroll`.
  `End` from a workspace control should focus/select Crypto and reveal its whole
  label; `Home` should focus/select Signals. Repeat with Arrow navigation through
  all eleven; Tab/Shift+Tab must leave the strip normally.

Matrix: widths 375/390/430, tablet 820/1024, desktop 1440; normal root font and
200% of the computed original font; normal/short viewport; reduced motion.
Check deep-switch reset, focused content controls clear of both docks, document
bottom reachable, text fitting its own control, no document horizontal overflow,
no runtime exceptions and no automatic AI. Fixtures should isolate expensive tabs;
successful shell QA does not certify their data or each legacy panel's layout.

## Focused tests and peer review

`npx tsx --test tests/accessibility-shell.test.ts tests/typescript-repair.test.ts`:
Final delta suite: 27/27 passed (13 shell + 14 peer). `git diff --check`: passed. The thirteen shell tests cover measured
geometry, short-view navigation reserve, actual-coordinate centering, focus reveal,
all eleven controls, keyboard/source contracts, scroll affordances, cleanup,
live P/C wrapping, theme-aware regime banner colors and loaded-alert header
wrapping/separate button semantics.
Source assertions are not a substitute for real focus/zoom/browser verification.

Independent TypeScript peer review: reviewed every final implementation diff and
read the focused regression suite. No unresolved blocking issue in assigned scope.

- The initial charm conversion is absent. `server/models.ts` now leaves
  `baseTarget = spot`, preserving effective prior behavior; signed/extreme charm
  fixtures cannot activate an unvalidated drift heuristic.
- `server/odteAlertEngine.ts` retains the early empty-candidate rejection before
  reduction. The preferred pool is nonempty by construction; no synthetic seed
  contract or non-null assertion supplies absent market evidence. Tests cover
  empty/out-of-band/absent chains and real candidate identity.
- Missing/nonfinite/nonpositive quarterly gamma crossings omit only the optional
  trajectory at the existing catch boundary. Genuine gamma/collar scaling remains
  unchanged and is regression-tested. Ticker spot stays numeric and invalid
  nonpositive values fail closed.
- Type-only import correction, contextual magnet typing, declared flow-source
  metadata, actual prior-candle timestamp, and seasonality Pick changes do not add
  provider/model calls or invent timestamps/market inputs.
- Recharts range areas receive exact low/high pairs, with range tooltip formatting;
  chart bounds/accessor fixtures passed. Visual rendering remains parent QA.
- Canonical `cosmos` now replaces obsolete `voices` in TabKey and numeric key 7.
  The help dialog shares the same numeric map; other legacy numeric bindings remain
  unchanged. Actual handler fixtures ensure each numeric target has a rendered
  dashboard panel, including Cosmos.

Reviewed peer files: `ChartPanel.tsx`, `DailyPlaybookChart.tsx`, `TickerContext.tsx`,
`ShortcutsModal.tsx`, `use-keyboard-shortcuts.ts`, and the nine backend files listed
in `docs/TYPESCRIPT_HANDOFF.md`; tests: `tests/typescript-repair.test.ts`.
This is scoped code/test signoff, not certification of predictive validity, full
legacy panel accessibility, live market data or release deployment.

Final peer chart-label delta: exact legend names/prices and line strength remain
present outside the clipped SVG, with wrapping and no ellipsis. Its new regression
passes. Review item MAG-1 was sent to parent: inline pastel price colors, especially
gamma-flip gold, were unsuitable for the light card surface. The peer's final
legend now uses `text-foreground` for prices while retaining colored line swatches.
Independently reviewed that correction: no unresolved code-level blocker in the
new legend, financial or keyboard changes. Parent retains visual release acceptance.
Also reviewed the peer's final tooltip delta: popover background, title and every
range/scalar item now use paired theme variables; exact range/scalar formatting
remains unchanged. The actual Recharts tooltip-markup regression passes. No
additional scoped code-review blocker found.

During isolated Vite checks, an existing interleaved lazy declaration failed before
React's development interop binding initialized. `CryptoPanel` is now declared
after all imports alongside the other lazy panels; no loading policy changed.
Removing the document overflow mask exposed existing enlarged Signals headings
and Fear & Greed bar widths. Scoped card-header wrapping and a bounded bar repaired
those widths without altering values or suppressing controls.

## Isolated browser evidence (not release acceptance)

Vite ran separately on port 5178; the main port 5000 was not rebuilt/restarted.
Browser requests were intercepted: one read-only cached snapshot, explicitly
synthetic headline/quotes/status, all unrelated API routes returned fixture 503.
No browser request reached providers or AI.

Chromium with reduced motion verified settled 375/390/430 widths, 820/1024 tablet,
1440 desktop, mobile root 16→32px and desktop root 17→34px. All visible header
targets stayed inside the viewport and measured at least 44 × 44. Document width
matched viewport width in the tested fixture states. At 375 × 400 and root 32px,
header/banner scrolled away while the 80px bottom dock stayed fixed at y=312..392.
End focused/selected/revealed Crypto; Home returned to Signals. Desktop End/Home
and numeric 7→Cosmos passed; no page exceptions were recorded.

Artifacts in `/home/user/workspace/`:

- `accessibility-shell-isolated-qa.json` (settled matrix and fixture limits).
- `accessibility-shell-mobile-normal.png`, `accessibility-shell-mobile-enlarged.png`,
  `accessibility-shell-mobile-short.png`.
- `accessibility-shell-desktop-normal.png`,
  `accessibility-shell-desktop-enlarged.png` (deep sticky dock),
  `accessibility-shell-desktop-top-enlarged.png`.
- `accessibility-shell-vite.log` (isolated frontend only).

These checks do not certify every legacy panel: existing internally clipped social
rows and horizontally scrolling Cosmos subtabs were observed outside the shell
scope. Parent must still exercise actual integrated touch/keyboard behavior,
focus-safe content scrolling, all eleven workspaces, normal motion, real response
states and the deployed preview. Browser snapshots are fixture evidence, not
market-health claims. The isolated browser is closed after evidence capture.

Final delta fixture verification: P/C data present (neutral zone, index 1.10,
Mag7 0.55, combined 1.01) now produces document widths exactly 375 and 390 at
200% root text. The real theme-toggle control switched the fixture banner to light;
its neutral headline computed `rgb(51, 65, 85)` and was visually reviewed.
Evidence: `accessibility-shell-final-delta-qa.json`,
`accessibility-shell-flow-375-enlarged.png`, `accessibility-shell-light-banner.png`.
The final combined test log is `accessibility-shell-cross-review-tests.log`.

Loaded-alert fixture verification (all API calls browser-intercepted): generated
the same 15 alerts / 13 HIGH / SCHWAB LIVE header in the unchanged alert function.
After five stable animation frames at 390px/root 32px, document width was 390px;
header/right edge 316px, toggle 178 × 204px, clear-all 66 × 44px. No nested buttons
or page exceptions. Tab from collapse focused clear-all. Enter cleared only these
browser-fixture alerts and left `aria-expanded="true"`; no runtime alerts were
dismissed and no server write occurred. Evidence:
`accessibility-shell-loaded-alerts-qa.json`,
`accessibility-shell-loaded-alerts-390-enlarged.png`.
The peer independently inspected final JSX ancestry, reran typecheck and all
27 focused tests, and signed off this header-only delta in `TYPESCRIPT_HANDOFF.md`.

## Final owned file inventory

1. `client/src/pages/dashboard.tsx`
2. `client/src/index.css`
3. `client/src/hooks/use-shell-layout.ts` (new)
4. `client/src/components/ShellNavScroller.tsx` (new)
5. `tests/accessibility-shell.test.ts` (new, 13 tests)
6. `docs/ACCESSIBILITY_HANDOFF.md` (new)
7. `client/src/components/FlowAlertsPanel.tsx` (parent-authorized header-only follow-up)

No worker build, main-process restart, commit or deployment was performed.
