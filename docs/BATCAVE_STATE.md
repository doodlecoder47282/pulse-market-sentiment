# Batcave checkpoint

Updated: 2026-10-14. This is a compact handoff, not a live-health certificate.

## 2026-10-08: quant-fixes branch (PR to main)

Completed objective: apply the 37 fixes from the quant code review (Claude Doc
"Batcave Terminal - Quant Code Review"), with the user's priorities: Schwab is
always connected (no backup-data work: F1.1 and F12.3 dropped), and every
output, above all every dollar figure, must be accurate for any account size.
Cosmos kept as a tab with all trade instructions removed.

How: five workstream agents (data/time, options math, statistics,
validation/sizing/ML, labels/security), each reviewed by another, then an
integration pass (one expiry clock), a money-math audit of every $ output, and
an independent verifier that had not seen the work.

Evidence:
- Verifier: 33 of 37 DONE, F8.1 and F9.1 PARTIAL (no historical option chains,
  not enough real ML data yet; both relabeled and gated), F1.1 and F12.3
  dropped by the user. Five dollar checks match an independent Python
  recomputation (GEX per 1%, sizer at the ask with fees, 0DTE charm to
  settlement, theta to the close, Wilson and Kelly).
- Quant tests: 164 pass, 0 fail (`tests/quant`, run in CI and locally).
- CI (`.github/workflows/quant-fixes.yml`, report on branch
  `ci-reports-quant`): build passes; all 121 GET routes return the same status
  as main; no runtime errors; tsc error count checked per file vs main.

Visible behavior changes: sizers show 0 contracts until the new option-P&L
ledger has evidence; whale and 0DTE track records restart on real option
marks; many "calibrated" labels now read "not tested" or "no demonstrated
skill"; OU band and seasonal windows usually read "not significant"; Discord
cards are off until `PULSE_DISCORD_*` env vars are set; a public bind without
`BATCAVE_ACCESS_KEY` returns 503 on /api (override `BATCAVE_ALLOW_OPEN=1`).

Blockers (user action):
- Revoke and regenerate the Discord webhooks and the Schwab app secret: they
  are in public git history. Merging does not remove them.
- History cleanup is a destructive rewrite: only with explicit approval.

Known risks / not verified: live Schwab fields (settlementType, quoteTime on
$VIX, vega units), the SPX exchange fee (sizer requires it for index roots),
EOD brief still has hard-coded default weekly targets in routes.ts,
`data/greek_gradient.db*` still tracked.

Re-grade (independent graders, same rubric, branch at 8403510): overall
C- -> C+. Sectors: 1 B-, 2 B, 3 B-, 4 B-, 5 C+, 6 B-, 7 B-, 8 B-, 9 C, 10 C+,
11 B- (deploy blocked until webhooks/Schwab secret revoked), 12 C+. Full
table and fix-next list in the review doc. Top open items: ML feature log
mixes SPY/SPX scales; Models/Exposures read the CBOE chain as primary;
edge-survival card ignores the option ledger; picker T1 projection biased low.

## 2026-10-09: rounds 2-4 on quant-fixes (PR #3), HEAD 98ebb45

User rules added: Schwab is the ONLY source for stock/index/options data and
every calculation and ML input built on it (CBOE removed; when Schwab can't
answer, routes return 503 or a labeled partial, never delayed/old data or a
500). Closest-to-tick data via the Schwab Streamer (LEVELONE equities and
options, CHART_EQUITY; Schwab has no time-and-sales stream). News and crypto
from professional-grade external sources, tiered and labeled (official SEC,
Fed, BLS, BEA, Treasury, CFTC first; Coinbase + Kraken for majors;
DexScreener + Jupiter for Solana DEX). Agents ran on Opus 5.5 medium effort
(math, review, grading) and Sonnet 5.5 (mechanical work).

Process: 9 round-2 workstreams with rotating peer review and fix rounds,
5 round-3 workstreams from the re-grade's "needs code" list, a round-4 fix
pass, an independent verifier, CI on every merge.

Evidence:
- Independent re-grade at 36e2883 (before round 4): 1 A-, 2 A-, 3 B+, 4 A-,
  5 A-, 6 B+, 7 A-, 8 A-, 9 B+, 10 B+, 11 B+ (code), 12 B; overall B+
  (was C- at the start). Round 4 then fixed the graders' remaining
  "needs code" items; an independent verifier checked them (quarterly cone
  re-derived in scipy to the cent) and its 3 partial findings were fixed.
- Quant tests: 500 pass, 0 fail (local and CI). New parse test over every
  server/shared file (caught a bundle-breaking duplicate declaration).
- CI run 37912521652 (98ebb45): build OK; no route regressions; every head
  5xx is a 503 with dataState; access gate incl. fail-closed; tsc 163 vs
  main 182, no file worse than main.

What blocks an A on the remaining sectors is real data, not code: graded
live 0DTE/whale fires, 60+ real ML sessions and a promoted model, cone and
odds coverage on held-out data, historical option chains (paid, needs
approval), dealer open/close data (not offered by Schwab).

Blockers (owner action):
- Revoke/regenerate the Discord webhooks and the Schwab app secret (public
  git history). Delete pre-encryption backups/ (plaintext tokens).
- Set INDEX_OPTION_FEE_PER_CONTRACT from a real SPX trade confirm (index
  dollar P&L is shown before fees until then).
- Weekly targets live in the Heatseeker levels store (seeded with an old
  week's values; update them each week).
- Merging untracks data/greek_gradient.db* and the scheduler state file: stop
  the server before pulling on Windows.

Not verified live: Schwab Streamer login and index symbols ($VIX9D etc.),
strikeCount semantics, closePrice roll after 16:00, request sizes, Railway
deploy of the ML sidecar, client rendering in a browser.

UI follow-up (06c2e0c, CI 37947924832 green, screenshots in ci-reports-quant
shots/): regime banner reads "Regime unavailable" with the missing inputs
instead of "Neutral ... size down"; missing VIX change no longer treated as
0%; NET GEX shows "—" when unknown; header and page title say Batcave. CI now
screenshots all 11 tabs (desktop) and Signals (phone) on every run.

Next step: user reviews and merges PR #3; then one live session with Schwab
connected to confirm the streamer and the unverified fields above.

UX audit (CI 37953742495 at 4d51cb6, tests/ux/ux-audit.mjs, output in
ci-reports-quant ux/): 11 tabs x 6 viewports, Schwab disconnected. Result in
the Claude Doc "Batcave UX and Visual Audit": UX grade C+, 26 fixes ranked.
Top items: profane emoji splash, mandatory affirmation gate, Edge Lab shows a
score and SPX-scale "SPY" levels with no inputs, contradictory regime chips,
LIVE badge over failed models, raw JSON errors, phone tab bar hides 6 tabs,
~45% of a laptop screen is chrome, 13-59% of text under 10 px. No page
errors, no sideways scroll, tab switches 40-255 ms. Phone per-tab metrics
not measured (bottom bar lacks test IDs). No UX fixes implemented yet.

UX batch 1 (09c4ef9 + header follow-up; CI 37961552901 green: 507 tests,
tsc 163 vs 182, no route regressions, UX audit all six sizes incl. phones
via bottomnav-* IDs): splash deleted; pre-market checklist opt-in (Settings,
off by default, skip button, no scroll lock); Edge Lab gives "insufficient
data" with no score below 2 real inputs and hides SPX weekly targets for
non-SPX symbols or when unset/older than 7 days (tests/quant/ux1.test.ts);
regime rotation reports missing axes instead of "balanced" (dataState on
/api/regime); chip renamed "Rotation"; Models shows NOT BUILT and one
sentence instead of an error wall; raw HTTP/JSON errors replaced
(client/src/lib/friendlyError.ts); explainer copy fixed (no trade advice,
Take Five, News sources, slang); Take 5 moved into the header; last update in
ET. Phone CLS 0.28-0.34 -> under 0.05. Note: the audit doc wrongly said the
DISCONNECTED pill is not clickable; it already opens Schwab settings.
Remaining from the fix list: items 7-8 (phone nav, chrome height), 11-26.

UX batch 2 (edfd745..HEAD; CI 37983452339 at 2e516e2 green, tsc 162 vs
182, no route regressions): bottom tab bar (4 tabs + More sheet) below
1024px, tab row above; FX/crypto carousel removed from above the tabs; tab
explainers collapse to one line (content starts ~210px down on a laptop, was
~440); all text-[8-10.5px] raised to 11px and faded muted greys removed
(text under 10px per tab 6-384 -> 0-10, contrast failures 2-14 -> 1-4,
mostly separators); one brand-colored active tab; Connect Schwab notice on
Schwab-fed tabs; layout shift 0 on every screen. Canary rows narrowed after
that run (not yet CI-verified). Remaining: tap targets under 24px on touch
(42-79 per screen size, mostly chips), designed empty states per panel,
visual hierarchy, fonts, brand kit, professional mode, CI thresholds.

Vercel (user connected it 2026-10-09; user chose website only for now):
vercel.json builds the client (vite build -> dist/public) and rewrites every
/api/* call to api/unavailable.js, which answers 503 {dataState:
"unavailable"} so panels show "No Batcave server is connected". No server
code, secrets or Schwab access on Vercel. Production on Vercel follows main
(old UI with the profane splash) until PR #3 is merged; quant-fixes gets a
preview URL. Later: deploy the server (Railway was the earlier choice), set
VITE_API_BASE in Vercel, add CORS for the Vercel origin on the server, set
BATCAVE_ACCESS_KEY / BATCAVE_TOKEN_KEY, register the Schwab callback URL, and
rotate the exposed Schwab secret and Discord webhooks first.

Cleanup (f4d1d85 + CI dependency commit 7c21b60): removed unreferenced root
scripts, 8 unused components, 23 unused shadcn UI files, splash CSS, the 9
tracked ML model files (none had the current feature schema, so none could be
served; ml_service/models/*.lgb and *_meta.json are now gitignored runtime
outputs) and 21 npm packages used only by removed files. The dev workspace
cannot reach npm; .github/workflows/npm-add.yml installs/uninstalls from
.github/npm-add.txt and commits the lockfile. Speed Insights renders only on
Vercel builds (vite define __ON_VERCEL__). Kept on purpose: data/sessions,
data/analogs, data/mm-predictions (tracked runtime history; untracking would
delete the user's local copies on pull).

2026-10-09: PR #3 merged into main (8537193, CI 37998352961 green on its
head). Vercel production deployed 8537193 ("Deployment has completed");
the page itself was not viewed from here (workspace cannot reach vercel.app).
Merged work branches r2-a..i, r3-1..5, r4 still exist on GitHub: deleting
branches is blocked from this workspace; the owner can delete them in
GitHub > Branches (all are fully contained in main). Kept: ios-capacitor,
feat/capacitor-ios (unmerged iOS work, on hold), ci-reports-* (CI output).
2026-10-10: user bought Railway ($5 plan). PR #4 merged (d94e669): ML spawn
'error' handler (missing python crashed the server), railway.json health
check + npm run build, nixpacks.toml Node 20, analogs seed fallback for a
volume on /app/data, RAILWAY-DEPLOY.md rewritten (volume, variables incl.
PULSE_ML_AUTOSTART=0, keep the registered Schwab callback and use the
paste-back Connect flow). Not verified: an actual Railway build (no access
from this workspace).
User report: Railway variables were empty (invalid_client); then the Connect
button was a dud (disabled when /api/schwab/auth-url failed, no reason
shown; window.open after async blocked on Safari/iOS). PR #5 (480708c):
login button is a real link, copy fallback always shown, dialog explains a
missing access key or missing SCHWAB_* variables (auth-url now 503 with the
names), optional automatic callback /api/schwab/oauth/callback with a
one-time state (tests/quant/schwab-oauth.test.ts). Not verified live.
2026-10-11: user connected Schwab on Railway; panels still empty. Logs:
repeated 401 on trader/v1/userPreference (Trader API refused: app likely
lacks "Accounts and Trading Production"; streamer off, REST market data
unaffected), token refresh OK, no marketdata errors in the excerpt. PR #6
(ac5bd34): Settings "Test Schwab data" (/api/schwab/selftest: quotes,
daily history, chain, Trader API with plain-language results); intraday
minute bars fall back to the last session when the market is closed (were
blank all weekend); streamer retries a 401 every 30 min. Not verified live.
Next step: user redeploys, runs Test Schwab data, reports the four lines.

## 2026-10-11: product direction (user decisions, keep for every session)

Goal: a paid subscription service for self-directed Schwab investors, only
after it earns it. Decided with the user:
- Model A: each client connects their OWN Schwab account (per-user OAuth,
  read-only). Never serve one Schwab account's data to other users
  (redistribution: Schwab API terms + exchange OPRA/Cboe rules).
- Investors only: self-directed individuals; no order placement, no advice,
  no sizing instructions; disclosures reviewed by counsel before charging.
- Schwab commercial approval is required before other clients can connect;
  public reports (WealthLab, NinjaTrader) show it is slow; fallback is each
  pilot user registering their own individual Schwab app key.
- Proposal to Schwab drafted as a Claude Doc "Batcave x Schwab: Developer
  Partnership Proposal": https://claude.ai/code/artifact/aa5ae289-0995-407f-b5e2-e415fe90794a
  (asks Schwab for approval path, Streamer without Trader scope, token
  lifetime, display/derived-data rules, and their Greek/IV methodology).
- Gates before paid launch: (1) Railway stable 2 weeks, (2) Schwab commercial
  approval + counsel review, (3) 3 months of graded alerts published.
- Known single-user assumptions to remove for multi-client: token store is
  one row (schwabTokenStore.ts ROW_ID=1); schwab.ts REST cache, rate budget
  and Streamer are process-global; access gate is one shared key; Discord
  webhooks and schedulers are global.

2026-10-12 trust pass (bb59820, CI 38202063956 green: 511 tests, tsc 162 vs
162, UX budget all pass): the user's questions are now checks.
"Can I trust it" -> tests/quant/no-advice-language.test.ts (fails on
trade-instruction phrases in subscriber-facing text; personal-edition files
exempt with reasons). BATCAVE_EDITION=investor hides/403s EOD trade setups
and disables Discord trade cards; default personal edition unchanged.
"Does it fit my device / react to my touch / can I read it" ->
tests/ux/budget.json ceilings checked by ux-audit.mjs; the CI step now fails
when any is exceeded (ratchet: lower ceilings as screens improve). Fixed two
misattributed Take Five quotes. Next on this track: position sizer as a
plain user-driven risk calculator in the investor edition, live checks of
our Greeks/IV against Schwab's chain fields, tap targets under 24 px.

2026-10-12 design + access: color directions canvas for the user to pick
(Design artifact https://claude.ai/artifact/SYBtywydPiTERPHoahGKv6: today,
A Night Desk (recommended), B Institutional Navy, C Signal Contrast; sample
data). User wants a free website link before subscriptions: allowed shapes
are a labelled demo (no Schwab data) or invite-only per-tester deployments
on each tester's own Schwab app; a shared server showing the owner's Schwab
data to others is not (redistribution).

2026-10-12 iOS + free link (quant-fixes 522930b, 6c68583, cccbebb; not on main yet):
- iOS: Capacitor 8 project ported from ios-capacitor (no generated assets
  committed). .github/workflows/ios-build.yml compiles for the Simulator
  (Xcode 26.3, BUILD SUCCEEDED, launched, screenshot) and publishes
  Batcave-iOS-Xcode.zip to ci-reports-ios. Rebuild after UI changes by editing
  .github/ios-build.txt. Capacitor deps added via npm-add (devDependencies).
  User opened the folder instead of App.xcodeproj once; their Mac needs an
  update before it can run the iOS 26 simulator. Not yet run on a device.
- Demo edition (BATCAVE_EDITION=demo, docs/DEMO.md): server/demoMarket.ts
  simulates quotes, minute/daily bars and BSM chains behind schwabFetchMeta;
  Schwab never called, sign-in refused, /api read-only for visitors (loopback
  schedulers allowed), gate "open-demo", SAMPLE DATA strip in the sticky
  header, chips credit "Sample". 13 tests (tests/quant/demo-market.test.ts);
  526/526 quant tests pass locally. CI run 38207537360: demo guards all PASS,
  10 data endpoints return populated JSON, 0 page errors, strip visible.
  Not deployed: needs a second Railway service (owner step, usage cost).
- Testers (docs/TESTERS.md): each tester forks, deploys their own Railway
  service (investor edition) with their own Schwab individual app.
- CI run 38207537360 FAILED only on the UX budget: tap targets <24px rose by
  5 on phones/tablets and one clipped line, from live news topic chips,
  social posts and crypto rows (content varies by time), not from the demo.
  Fix by enlarging those chips (Chart engine/timeframe toggles, News topics,
  Regime pivots, Cosmos thermal, crypto sections) rather than raising budgets.

2026-10-12 iPhone 17 batch (quant-fixes 7e0483f..ac9ca4c, CI 38222385015 green,
iOS CI 38219184330 green; not on main yet):
- Edge to edge on iPhone (viewport-fit=cover, contentInset never, safe-area
  padding, dark status-bar band, UIUserInterfaceStyle Dark). Verified on an
  iPhone 17 simulator (Xcode 26.3) against a demo server on the Mac runner:
  header below the Dynamic Island, bottom bar above the home indicator.
- Touch: 44px minimum below 1024px (base-layer rule + Button variants +
  header controls). UX audit: phone-15 controls under 44px went from ~10 per
  tab to 0-1; under 24px 48 -> 0 on phones and tablets; sub-10px text worst
  tab 11 -> 3; low-contrast 5 -> 3; off-screen phone-se 7 -> 1. Budget
  ratcheted to these values. The audit now names layout-shift sources.
- Original app icon ("B" over a level line, amber on near-black) and a black
  launch screen with a 120pt mark replace the Capacitor placeholders. The
  web favicon resembles a famous comic-book logo; not used for the app icon.
- Try the demo button (VITE_DEMO_URL from repo variable BATCAVE_DEMO_URL);
  demo Settings can switch back to your own server (iOS only).
- Fixed: server listen used reusePort (Linux only) and could not start on
  macOS (ENOTSUP). Fixed: crypto peak/grader SQL used ?N placeholders that
  better-sqlite3 rejects, so live crypto outcomes were never recorded (new
  test runs the SQL under better-sqlite3 in CI). Fixed: gamma/short-vol
  banners gave sizing/hedging instructions; no-advice check widened.
- Demo: price tape reads Sample. Former gaps, both closed 2026-10-14: whale
  flow was always empty (now sample sweeps, docs/DEMO.md); tape symbols not
  in demoMarket TABLE got hash prices (bases added).
- Risk seen once (iOS CI 38224381267): the app sat on the loading skeleton
  for 50 s; the demo server logged only /api/health, no /api/snapshot. The
  rerun (38226102296) served /api/snapshot in 2.3 s and loaded. Cause
  unknown; getOrBuild shares one in-flight build with no timeout, so a hung
  upstream fetch would hold every client on the skeleton. Candidate fix: a
  timeout on the shared build that falls back to the stale/unavailable path.

## 2026-10-14: options flow attribution, meme structure

Completed objectives (branch quant-fixes, commits after 881665f):

1. Options flow: how whales are picked and tracked. Verified by an
   independent agent against the Schwab snapshot facts (cumulative volume,
   last print only, NBBO, no prints). Eight defects fixed:
   `server/flowAttribution.ts` (per-contract ledger: increments attributed
   to the print inside the interval at its price, pre-scan volume at the
   first mid, high-water mark, ordering guard, prior-session restart,
   stale-quote side unknown, 5-minute burst, coverage-gated ask share that
   says it is an estimate), `server/flowDedup.ts` (one dedup key for live
   and restart; hydrated keys never matched before, so a restart re-fired
   18 h of whales), gate reasons and the Discord card name the premium and
   side basis, the second volume memory is gone, demo volume is monotone.
   Tests: flow-attribution 11, flow-gate-review 31, demo-market 14; full
   suite 575 pass / 1 skipped before the meme work.
2. Meme structure (the user's "community coins" thread), `docs/MEME_STRUCTURE.md`:
   `shared/memeStructure.ts` (execution cost from pool depth, line
   position, three categories, range / survival stats, hold-vs-rotate with
   timing on a slider), community watch (`server/cryptoCommunity*.ts`,
   `/api/crypto/community`, personal-edition writes, demo sample), cards in
   the Crypto tab, structure chips and the exact round-trip cost on every
   tracked launch. Independent review: 13 findings, all fixed; 34 + 6 tests.

3. Heatmap 3D surface (e1dd85f): `shared/surfaceProjection.ts`,
   `client/src/lib/surfaceDraw.ts`, `client/src/components/ThermalSurface.tsx`;
   grid / 3D toggle in the thermal panel; docs/HEATMAP.md section 7. 9 tests
   plus a headless Chromium render of the sample chain at 375 / 820 / 1180 px.
4. CI findings fixed (82606b4): missing pickPool import (tsc gate); Chart
   tab crash on every viewport, pre-existing and exposed once queries stopped
   pausing on navigator.onLine: no Schwab spot made the outlook's expected
   move NaN, JSON turned it into null, the scenario card called toFixed.

Verified in CI (run 38525331878 on 5632d3b): demo smoke PASS for
/api/crypto/community (3 sample rows, reclaimed dips 1/1/0, $1k trips
2.69 / 3.12 / 5.21%), writes refused; UX scorecard for the crypto tab: no
overflow, no overlapping text, no tap targets under 24 px; demo screenshot
of the Structure section inspected.

Not verified: live DexScreener / GeckoTerminal calls (unreachable from the
dev environment); the iPhone/iPad layout of the new cards (ios-build.yml
runs on ios/ changes; edit .github/ios-build.txt to rebuild); the CI run for
82606b4 and later (read ci-reports-quant RUN.txt for the sha).

Known risks: the watch classifier is tentative until holder concentration
and mint authority are read for watch tokens; the 0DTE map composer is still
pending; the edgelab tablet-portrait CLS (0.55) is instrumented but not
fixed; overlappingSvgText 2 (Signals: "Spot" x "ZERO-Γ FLIP" tspans) is
pre-existing and outside the text-overlap budget.

CI green at 96ded05 (run 38529009336): tsc head 159 errors vs base 162, no
file gained any; 628 quant tests, 626 pass, 0 fail; demo smoke 11 PASS;
UX audit on seven viewports: 0 page errors, 0 overflow, 0 overlapping text,
worst-tab CLS 0 (edgelab fixed by the sized skeleton), tap targets under
24 px 0 except one on tablet-13-landscape (budget 29).

5. 0DTE map (docs/ODTE_MAP.md): `shared/odteMap.ts` composer (gap,
   straddle and sigma ranges, labelled strikes in $/1% and $/pt, band from
   the re-priced crossings, ladders, personal-edition zones, text block,
   comparison helper), `shared/odteSettle.ts` (settle evaluation, tally),
   `server/odteForward.ts` (the forward moved out of routes.ts, injectable
   sources, additive gammaCrossings / sessionOpen / priorClose),
   `server/odteMapLedger.ts` (09:35 ET morning plan, 16:06 ET settle, SQLite
   ledger, investor view without zones), Trade Desk card, routes
   /api/odte/map, /api/odte/map/ledger, /api/odte/map/compare (personal).
   Independent review: 12 findings, all fixed; 31 tests across three files.
   The friend's map scale matches $ per point, not per 1%; the per-point
   switch is there for the live comparison. No tuning to his numbers.

CI green at 4564720 (run 38600631607): tsc head 158 vs base 162, no file
gained errors; 659 tests, 657 pass, 0 fail; demo smoke PASS for
/api/odte/map (23 strikes, pin and wall labelled, straddle 21.9, zones
null in the demo) and the community watch; UX audit 0 page errors, 0
overflow, 0 overlaps, 0 tap targets under 24 px, worst CLS 0 on every
viewport. The demo Trade Desk screenshot showed "gap: open not available":
the normalized Schwab chain dropped underlying.openPrice; fixed in b037c93
(CI for that commit not yet read).

Next step: owner checks the Trade Desk card during a session (gap, map,
zones) and the ledger after 16:06 ET; on a day with a published map, POST
/api/odte/map/compare to measure agreement.

## 2026-10-14 (evening): fixes after "what else can we fix"

Pick stated at the start of the work (no objective had been chosen): the
bounded user-facing and CI-hygiene fixes below, one commit each, on
quant-fixes after e10b4e8.

1. 861a5db Data-state chips: a 503 whose body says `no_spot`, `empty`,
   `delayed` or `no_data` was shown as "request failed". The client parser
   (`shared/unavailable.ts`) now keeps the body's own state through the
   shared vocabulary (`empty` -> no_data; new alias `delayed` -> stale; a 503
   claiming ok, or an unknown string, fails closed to unavailable). A 500 is
   still a bug and a 503 without a dataState still a failure.
2. b46b097 tsconfig: `target ES2022` (tsc is noEmit; Vite/esbuild build) with
   `useDefineForClassFields: false` so the class-field semantics the bundlers
   derived from the old target do not change. Removes the 50 TS2802 Map/Set
   iteration errors and a few dependent ones; no new error code locally.
3. 98abe93 no-advice-language test also walks shared/ (clean today).
4. 7918eba Snapshot: `getOrBuild` shared one in-flight build with no bound
   (Schwab fetches have no timeout), the iOS "stuck on the skeleton" risk.
   Each waiter now gives up after 20 s (`shared/waitFor.ts`, tested) and takes
   the existing stored-snapshot-within-max-age (stale) or 503 unavailable
   path; the build keeps running for the next request.
5. d13f6be /api/decision-support threw ReferenceError on every call
   (`formatDecisionBlock` was never imported; tsc TS2304 since the initial
   import). Imported; demo smoke now checks the route answers 200.
6. af3f875 Signals GEX chart: "Spot" and "ZERO-Γ FLIP" labels overlapped on
   phones (CI UX audit svgOverlapCount 1). Labels are now row-stacked
   elements clamped inside the plot; the lightning emoji is gone.
7. 1f34669 Demo tape: ten macro ETFs (SHY, IEF, LQD, JNK, USO, UNG, SLV,
   CPER, CORN, WEAT) had hashed prices ("Oil 195.74"); named sample levels
   added, with a test that reads the macro UNIVERSE from source.

Local evidence: full quant suite 663 tests, 662 pass, 1 skipped, 0 fail
(before item 7; demo-market file 15 pass after it). Local tsc (6.0.3, no
node_modules) on the whole project: ES5 12724 vs ES2022 12620 errors, no
new code. npm registry unreachable from the session, so TypeScript 5.6.3
could not be installed locally; the CI per-file gate is the proof.

8. (next commit) Models chart: "NOW $..." label moved from over the y-axis
   ticks to inside the plot with a halo (CI UX audit on 1f34669 found
   "690.00" x "NOW $689.78" on every viewport once the demo anchor sat near a
   round tick). The 0DTE demo smoke check from the previous objective only
   accepted "ok"; after the close the map is correctly "stale_session"
   (session closed), so the check now accepts that too.

CI evidence, run 38647320485 on 1f34669 (steps 1-7): tsc head 53 vs base
162, no file gained errors (the ES2022 target removed 105); quant tests
pass; build pass; route regression pass; demo smoke PASS for snapshot,
thermal, community, decision support (200, 5 lines) and the write gates,
FAIL only on the 0DTE check above (map priced, 36 strikes, pin labelled,
state stale_session at 18:29 ET); UX audit 0 page errors, 0 overflow, 0
overlapping text, 0 tap targets under 24 px, CLS 0 (0.009 wide), Signals
SVG overlap gone, the Models overlap above the only one left. Run 38649141417 on c447dc8 (item 8): all steps green except the UX
audit, tablet-portrait Edge Lab CLS 0.34 (budget 0.1): the briefing's
skeleton-to-content transition landed inside the strict 2.5 s window after
networkidle. Shift sources: the body moved down 27 px (the one-liner and
verdict badges appear in the header) and the panels card below moved out
of the viewport (the four-bar skeleton was ~600 px shorter than the loaded
body on every viewport, the sm:min-h-[740px] floor well under it). Same
tab was 0 on the runs earlier today, so it is timing-dependent, not a
regression from these commits (none touch Edge Lab).
9. (next commit) EdgeBriefing: the skeleton now mirrors the loaded
   sections and grids (levels strip, regime + cross-asset, three playbook
   paths, model cards, week ahead, headlines, footer) so it is about the
   loaded height at every breakpoint, and the one-liner row is reserved
   while loading. If the audit still flags this tab, treat it as a timing
   flake of the measurement (one more diagnosis, no further blind tuning).
Run 38651208710 on ee2e494 (item 9): GREEN. tsc head 53 vs base 162, no
file gained errors; quant tests 664, 662 pass, 0 fail, 2 skipped; build,
route regression pass; demo smoke 13 PASS, 0 FAIL (snapshot, thermal,
community, 0DTE map stale_session after the close, decision support 200,
write gates); UX audit all budgets pass: 0 page errors, 0 overflow, 0
overlapping text, 0 SVG overlaps (Signals and Models fixed), 0 tap
targets under 24 px, Edge Lab CLS 0 on all seven viewports (worst CLS on
the run 0.009, wide).

Later the same evening (owner away, authorized to continue without
questions):
10. 513dbf8 Schwab fetches bounded: 30 s per data attempt
    (SCHWAB_FETCH_TIMEOUT_MS overrides), 15 s token, 10 s self-test probe;
    timeouts say "timed out after N s". Source-guard test.
11. 30f79d7 Demo sample sweeps (docs/DEMO.md) so the whale panel is not
    always empty; flowAlertEngine.gateInputs holds the first-scan premium
    while the ledger lives (a drifting quote could lower it and drop the
    dedup tier). CI 38678412937 GREEN: 667 tests, 665 pass; demo smoke
    "8 whales, e.g. SPX SPXW 261016P06950000 $6.97M premium (volume x mid,
    first scan) / vol/OI 33.1x / AT_ASK last print / 2DTE"; UX budgets pass.
12. d72da0e The remaining 53 tsc errors cleared (head should read 0 vs
    base 162). Two were real defects: the Daily Playbook scenario bands
    filled from the axis floor (function `baseLine` is not a recharts prop;
    now a range area), and the models base-target "charm drift" was always
    0 (field never existed; made explicit, base target = spot).
13. d913fad Pivot projection right-edge labels spread apart
    (shared/labelStack.ts) with connectors; they printed on top of each
    other for levels a few points apart.
14. 2bc4935 Daily Playbook magnet labels spread with connectors (they
    stacked at the same y) and the right margin widened (labels clipped);
    pivot projection gutter 110 -> 150 px (labels clipped once spread).
15. c767112 Chain audit VRP: Schwab's theoreticalVolatility mirrors the IV,
    so every expiry read "+0.0pp Neutral"; rows now say "No model vol" with
    the IVs shown and the panel says why. Sign now market - theoretical as
    the guide says, 2 pp threshold as the guide says (code used 1 pp), and
    the "Sell Vol" / "Buy Vol" badges are "IV rich" / "IV cheap" / "Fair".
16. 9d9fdef no-advice check also catches "sell/buy vol|volatility|gamma";
    the 0DTE contract chart's volume labels read buy-side / sell-side.

CI evidence: run 38679745905 (6ac8d5e, items 12-13) and 38681724045
(2bc4935, item 14) and 38683594295 (9d9fdef, items 15-16), all GREEN:
tsc head 0 vs base 162 (no tsc error left on the branch); 671 tests,
669 pass, 0 fail, 2 skipped; demo smoke 14 PASS, 0 FAIL; UX budgets pass
on all seven viewports. Demo Models screenshot checked by eye: playbook
bands between Lo and Hi, playbook and pivot labels spread, none clipped.

Next step: owner reviews the Signals GEX chart, the Models chart labels and
the Daily Playbook bands live during a session (CI only sees the no-Schwab
and demo renders), then approves merging quant-fixes to main.

Not changed, still open: Schwab fetches themselves have no timeout (the
retry loop can wait up to the undici default); demo whale flow is always
empty; `routes.ts` 5896 `ch.source !== "schwab"` is a type-only `never`
comparison; TS7006/TS2339 in older files.

## 2026-10-18: crypto desk, achievable-exit grading and on-chain facts (feat/crypto-net-expectancy)

Honest assessment that led here: the signal score is hand-set (not fitted),
HIT_5M/DOUBLED graded on the sampled peak (an exit nobody can take), and the
sub-$1M new-pool universe is a negative-expectancy pool before costs. Nothing
on the tab showed what a follower of the desk would have been paid. This
branch adds the bookkeeping; it does not claim an edge.

1. shared/cryptoExpectancy.ts (pure, tested): what a $100 position returned
   under a stated exit rule, net of both legs. `graded` = buy at the signal,
   sell when the grader closed the row (HIT_5M at the first sample at or
   above the target, a limit-sell-at-target and NOT a hold to the horizon;
   RUGGED at rug detection; DOUBLED/DEAD at the 72 h horizon; last_mcap /
   last_liquidity are the values the grader saw then); `peak` = the sampled
   peak, shown only as the ceiling. Reviewer finding: the first draft called
   this "hold to the grading horizon", which the grader does not record;
   renamed everywhere and said in the basis text.
   Constant-product cost on both legs at the liquidity that existed at each
   (entry pool at liquidity_at_signal, exit pool at last_liquidity; the peak
   rule prices the exit at the entry depth because peak liquidity is not
   recorded). A pulled pool or a RUGGED row with no exit liquidity is -100,
   never "unknown". `summarizeExpectancy` gives median, mean, share positive
   with a 95% Wilson interval, worst/best, skipped rows with reasons, and a
   gate: below CRYPTO_SAMPLE_READY_MIN_GRADED (50) the note reads "counts
   only, no claim of edge". shared/memeStructure fee constants exported.
2. server/cryptoEngine.ts getCryptoExpectancy(): first ENTER per coin (same
   identity rule as the sample gate: COALESCE(token_address, pair_address)),
   graded rows only; /api/crypto/signals now carries `expectancy {hold, peak,
   basis}` and each row `netHold`. CryptoPanel shows the ExpectancyCard above
   the sample note and "+N% net" per graded row.
3. server/solanaToken.ts: one on-chain reader (mint/freeze authority, supply,
   top-10 holder share excluding identified pool vaults and burns) shared by
   the scanner's securityTick (behaviour unchanged: one indexed call per
   tick, 5-min cooldown after a 429, concentration non-fatal) and the
   community watch. `concentration` is ok | skipped | unavailable, so a
   cooling-down RPC keeps the last read and a failed read clears it with
   the reason; it never becomes a value.
4. Community watch: entries carry mintAuthorityActive, freezeAuthorityActive,
   top10Pct, top10Method, top10At, onChainState (pending | ok |
   unavailable), onChainAt, onChainError; `refreshOnChain` reads one token
   per minute tick, re-reads a complete read every 6 h and retries after 30
   min when the mint read failed or the concentration was skipped or
   unavailable; a skipped concentration keeps the last value and its own
   timestamp (shown in the tooltip) or is labelled "skipped" when there is
   none; tokens whose pool was not found still get their authorities; deriveEntry now feeds the
   facts to classifyMeme, so a watch token with both read and nothing else
   missing gets a firm (not tentative) structural read. MemeStructure.tsx
   shows "mint authority: revoked / ACTIVE / unread", the same for freeze,
   and "top-10 holders: N% / unavailable / unread". Demo seeds: PLAZA 18.4%,
   QUILL 31.2%, GRIT mint ACTIVE with concentration unavailable.
5. Below the sample minimum the expectancy card has no colour: the
   numbers are counts, and green/red reads as a verdict.
6. Tests: tests/quant/crypto-expectancy.test.ts (5), crypto-community
   applyOnChain case (skipped keeps, unavailable clears, failure stays
   unread). CI demo smoke now checks the on-chain fields on the sample rows
   and the expectancy block (both rules, gate text, netHold on every row).

Not done (deliberately): fitting the score. The 50-coin sample is not
reached; when it is, the expectancy block is the thing to fit against, and
the fit must be reported with its interval, not as a probability.

Wording stays descriptive: returns are "what happened", the peak rule is
labelled a ceiling, and the gate text says no claim of edge.

Evidence: independent reviewer pass (must-fix hold-rule mislabel and all
should-fixes applied in 32b3f04); CI run 39125508361 on d54628f green
(demo smoke: community watch and crypto expectancy PASS). PR #10 into main.

Next step: owner reviews PR #10 (and PR #9, 3D polish) and merges; live
on-chain reads on the personal edition are the part CI cannot see.

## 2026-10-18 (evening): design pass for the end user (feat/ux-design)

Reviewed the CI screenshots of every tab (desktop 1440 and iPhone 15) and
mocked three changes on a Design canvas ("Batcave UX Improvements"):

1. Answer first. The phone first screen showed header, truncated regime
   strip, two status pills, ticker, a collapsed description and the Connect
   Schwab card; the levels were a tab and two scrolls away. New
   client/src/components/TodayCard.tsx at the top of Signals: spot, wall
   above / gamma flip / magnet below from the 0DTE map (same react-query key
   as the Trade Desk card, no second fetch), spot's position between them,
   the straddle range, one sentence on the gamma sign, a link to the Trade
   Desk ladder. Loading, unavailable and no-gex states keep the same height
   (224 px) so the UX audit's CLS budget holds.
2. Chart-level confluence. shared/levelConfluence.ts (pure, 5 tests): a
   reader's chart levels tagged landmark / OI confluence / weak / chart only
   / unavailable against the map, tolerance 0.1% of spot (floor 2 pts),
   "chain" at >= 3% of the map's gross exposure. A missing map tags
   everything unavailable, never chart only. client/src/components/
   ChartLevelsCard.tsx under the 0DTE map on the Trade Desk: levels typed
   once, kept per symbol in localStorage (try/catch, per-viewer convenience),
   each row shows side, distance to the nearest mapped strike, share, and
   whether it is inside the straddle range. Descriptive only.
3. One data-state chip. client/src/components/DataStateChip.tsx already
   exists (11 panels); both new cards use it. Not done: the header strip's
   PARTIAL / DEGRADED / NEUTRAL / SAMPLE / LIVE / CLOSED badges still use
   three styles; converting them touches the header's layout and the UX
   audit, so it is its own objective.

CI: demo smoke now opens Signals and checks the Today card (three
thousand-separated levels, or the no-gex / unavailable state between
Friday's close and Monday's open), then the Trade Desk chart-levels rail
(types three levels, expects three tagged rows, and that tags agree with the
map's state), screenshot demo/16-chart-levels.png.

Not changed: phone bottom nav still Signals / Chart / Models / Desk / More
(seven tabs under More); regrouping into Today / Levels / Flow / Context /
Crypto is a routing change for a later objective.

## 2026-10-20: setup event log, phase 1 (feat/setups)

Direction agreed with the owner: an "A+ setup" is a stated condition met,
logged and graded, never a hand-set score. Phase 1 logs and grades; nothing
a reader sees changes except the log card and the Method panel.

1. shared/setupRules.ts: the versioned rule book (SETUP_RULES_VERSION
   2026.10.20-1). Structure (at-landmark 0.1% of spot, wall share >= 3%),
   flow (>= $2.5M at observed prices, vol/OI >= 15 or new strike, 1-3 DTE,
   at the ask, under 45 min old), vol (one-day implied move <= 2%), regime
   (fade needs long gamma, breakout needs short), events (90 min clear of a
   tier-1 release), session (15 min after the open, 45 before the close),
   outcome (120 min horizon, flip or 0.4% target, 0.2% past the wall
   invalidates, target >= 3x the modelled round-trip cost). describeRules()
   feeds the Method panel. SETUP_GRADE_MIN_SAMPLE = 100 per version.
2. shared/setupDetect.ts (pure, 6 tests): detectSetups returns the kinds
   that fired with every feature, and for the rest the blockers in words;
   gradeSetup replays minute bars with the achievable-exit test (target
   before invalidation = hit; invalidation first or both in one bar = loss;
   neither = expiry at the horizon close; too few bars = ungraded); returns
   are signed by direction and net of the spread modelled at detection.
3. shared/macroCalendar.ts: tier-1 dates (FOMC, CPI, NFP, PCE) through
   2026-12-31 from the agencies' calendars; after that the calendar reports
   itself unknown and the detector records it as a feature, not a gate.
4. server/setupEngine.ts: table setup_events; every minute in the regular
   session, for the flow universe, structure from
   tickerAlpha.gatherPositioningForTicker (per-name dealer gamma, cached 5
   min), the underlying spread as the cost model, the flow engine's pending
   whale prints, the session clock and the calendar -> detector; one open
   row per symbol and kind. Grader every 5 min replays regular-session
   minute bars (getPriceHistory day/2/minute); rows with no bars two days
   on are marked ungraded with the reason. GET /api/setups serves the rule
   book, calendar, counts, per-version summary (Wilson interval, counts
   only below the gate), recent rows and "why not now" per symbol. Demo
   edition stores nothing and serves the rule book.
5. client SetupLogCard on the Trade Desk under the chart-levels rail.

Honest limits recorded in the card and here: the cost model is the
underlying's spread, not an option's; flow confirmation reads the flow
engine's pending prints of the current cycle; structure for SPX comes from
the per-ticker chain read, not the 0DTE map. No grade letter exists in the
code; the first one can appear only after 100 graded setups of one version.

Dark-pool request: Schwab's feed carries no venue code and no time-and-sales
(streamStore L1 fields have no exchange id; no TIMESALE service), so the
next objective is a relative-volume and block-print read, named by what it
measures. daily_bars stores closes only; volume needs a column.

6. Any-ticker scan (server/tickerScan.ts, GET /api/scan?symbol=): five
   reads per symbol, each with its own state: Schwab instrument lookup
   (marketdata/v1/instruments symbol-search, so an unknown symbol says so),
   quote with the spread as the cost model, volume against the 20-session
   average paced to the session, per-name dealer gamma, and the chain's most
   active contracts by volume/OI. Cached 60 s per symbol; at most five
   Schwab calls per scan. TickerScanCard under the Today card on Signals.
7. Volume read (shared/volumeRead.ts, 3 tests): relative volume raw and
   paced; "quiet volume" (>= 1.8x pace with the day's move inside 0.4%);
   block prints from Level-1 updates for the streamed symbols (>= 8x the
   median print and >= 2,000 shares). Named by what it measures: Schwab's
   feed carries no venue code and no time-and-sales, so nothing in the app
   says "dark pool"; the notes say so on the card.

Next step: CI on feat/setups, PR into main after #9/#10/#11; then crypto
items 1-3 (horizon marks, ENTER waits for on-chain facts, social failure
handling) and the volume column on daily_bars.

## 2026-10-20 (later): R-multiple rule and margin-ranked picks (feat/setups-rank)

Rule book 2026.10.20-2: outcome.minRMultiple = 2 (target distance over
invalidation distance; the 7,695-vs-7,700 fixture reads R 1.96 and is now a
named blocker), rank.topN = 10, rank.maxPerSector = 3. Every fired setup
carries its margins (premium, vol/OI, wall share, target/cost, R, calendar
quiet, implied-move room as multiples of the rule) and the detector's
marginScore (mean of log2(margin), each capped at 3) orders the open
setups; rankSetups caps per sector (shared/sectors.ts, a static map for
the scanned universe; unlisted names are their own sector). /api/setups
gains `ranked`; the card shows the list with every margin so the order is
auditable. Ranking is by how comfortably the rules were met, never by
predicted edge; after the gate the per-version summary is what ranks.
Tests: setup-detect 7. Reviewed the owner's attached "AI trading desk"
prompt: principles kept (no invented candidates, logging through risk-off,
coded rejection reasons, four-way validation label), stack not adopted
(paid or keyed services, live swap execution, an LLM judge). Those pieces
are the next crypto objective.

Next step: crypto refinements (risk-off state, coded rejection reasons,
ENTER waits for on-chain facts, horizon marks, validation label).

## 2026-10-20 (crypto): desk discipline (feat/crypto-discipline)

Taken from the owner's attached trading-desk prompt, the pieces that hold
up, built on the existing scanner (which already held ENTER until the mint,
freeze and top-10 reads: an earlier note in this file saying otherwise was
wrong and is corrected here):

1. Persistent desk risk state (crypto_desk_state): BTC against its own 24 h
   Kraken VWAP, off at -5% or worse, unknown when the majors cannot be read.
   Off or unknown holds every candidate at WATCH with codes risk_off /
   risk_unknown; the scanner keeps logging. Survives a restart.
2. Coded verdict reasons (shared/cryptoVerdict.ts VerdictCode, 13 codes,
   each with a meaning): stored in crypto_signals.verdict_code and shown
   on the expanded candidate row. Rejections are countable, not only prose.
3. Horizon marks: a horizon pass prices every row once it crosses the 72 h
   horizon, whatever its outcome (horizon_mcap / horizon_liquidity /
   horizon_at); peak_liquidity is recorded whenever the peak updates. A row
   that cannot be priced a week past the horizon keeps horizon_mcap NULL
   with horizon_at set: tried and unavailable, never zero.
4. Expectancy "hold" rule: exit at the horizon mark, the replicable rule;
   rows without a mark are skipped, never approximated. The peak rule now
   prices the exit at the recorded peak liquidity (entry depth for older
   rows, said in the note). /api/crypto/signals carries expectancy.hold and
   desk; the card shows the hold line and the desk state.
5. Four-way validation label on every summary (PASSES PREDEFINED TESTS /
   MIXED RESULTS / NO DEMONSTRATED EDGE / INSUFFICIENT DATA): under the
   sample gate always INSUFFICIENT DATA; passes needs mean net > 0 and a
   Wilson lower bound over 50%. Passing a historical test does not
   establish future profitability; the text says so.

Not adopted from the prompt: paid or keyed services, live swap execution,
an LLM judge in the decision path. Tests: crypto-expectancy 6,
crypto-verdict 2, crypto-sql-binding, crypto-community, meme-structure.

Next step: CI, PR; then daily chain snapshots for a later equities backtest.

## 2026-10-20 (research): the desk's own history (feat/research-foundation)

Review of the owner's second attachment (a QuantGPT promotion): the
principles are standard and right (point-in-time data, out-of-sample
splits, parameter sweeps, event replay, re-checking as data arrives); the
200-day example compares price-only buy-and-hold against a rule earning
T-bills while out and is gross of costs, so its "same growth" claim is
tilted. The product is end-of-day daily prices with no chain, no gamma, no
flow, no intraday: nothing in it touches this desk's tabs, and it is paid,
keyed and ends in execution at Alpaca, all of which the standing rules
exclude. The one gap it names that applies here is real: the desk had no
history of its own. This branch closes it in-house, keyless:

1. server/researchStore.ts chain_snapshots: once per session after 16:10
   ET, every scanned name's 45-DTE chain ($SPX, the flow priority and
   watchlist) flattened to compact rows and stored gzipped, point-in-time
   as served. One chain call per name per day. GET /api/research/snapshots
   reports days, names, contracts and bytes; readSnapshot() decodes a
   stored chain for the replay engine that comes next. Demo stores none.
2. Event replay: shared/eventReplay.ts (pure, 2 tests) prices each tier-1
   release session from daily bars (close over prior close, opening gap,
   session range, next session) with states ok / partial / no_bar /
   future, and a per-release summary (median |close|, share up, median
   range, largest). GET /api/research/events?symbol= from Schwab's
   one-year daily history, cached 6 h. EventReplayCard on the Trade Desk.
3. shared/macroCalendar.ts now carries all 2026 NFP releases (BLS) and
   FOMC decision days (Federal Reserve) back to January, with a
   MACRO_COVERAGE note: CPI and PCE are loaded from October only, and the
   Nov 25 PCE date is flagged to verify against bea.gov (sources
   disagreed). A release not loaded is absent, never zero.

What this makes possible later, in order: replay the setup rules on stored
chains; sweep thresholds for a plateau rather than a lucky number; a
rolling decay flag per rule version. None of that is claimed yet.

Next step: CI, PR (#15) after #13/#14; then the replay engine over
chain_snapshots once a few weeks of sessions exist.

## 2026-10-20 (public): what a public app needs first (feat/public-hardening)

Owner's direction: everything built must give the end user use and edge,
and the app should be fit for real public use. The honest frame for a
public deployment today: stocks and options are the owner's Schwab login
and cannot be served to strangers (Schwab terms; the sample edition shows
a simulated market and says so); crypto is real, keyless public data and
is the side a public reader gets live. The path to live equities for the
public is per-user Schwab login, which needs multi-user accounts and
Schwab's commercial approval (unchanged from the iOS note).

Added, all tested:
1. server/publicGuard.ts rate limits: three token buckets per client IP.
   General (3,000/min public editions, 6,000 personal) is an abuse ceiling
   only: the first sizing (600) was hit by the CI audit driving seven
   browsers from one address, which degraded the layout and failed the UX
   budget, and an office NAT would do the same. Upstream (120/min public,
   240 personal) covers routes cached per symbol (0DTE map, gamma levels,
   flow preview, event replay, community). Scan (10/min public, 30
   personal) is the tight one: any symbol, up to five Schwab calls per
   uncached scan. The engines' self-calls are exempt. A limited call gets
   429 with Retry-After in the app's error shape (dataState unavailable).
2. Security headers on every response: nosniff, X-Frame-Options DENY,
   strict-origin-when-cross-origin, a permissions policy that turns off
   sensors the app never uses, and HSTS only when the request arrived over
   HTTPS (direct or x-forwarded-proto), so the loopback dev server never
   pins HTTPS. Cross-Origin-Opener-Policy was tried and removed: the UX
   audit's tablet tap-target count went 0 -> 72 with it on (bisected with
   headers off, 0 again) because COOP makes Chromium swap the browsing
   context on navigation and the audit's CDP pointer:coarse emulation does
   not survive the swap; the app opens no cross-origin windows, so the
   header bought nothing. No CSP yet: three.js, fonts and inline styles
   need an audited policy, its own objective.
3. Method and disclosures page (#/method), linked from the header "?" and
   the demo strip: what each tab measures, where every number comes from,
   the data-state glossary, how dealer gamma, flow, setups, cost and
   crypto grading are computed, what the app does not do, and the
   disclosures. The sample edition carries its own note at the top.

Already in place and relied on: the access gate (fail-closed off loopback,
CORS allowlist, slowed repeated wrong keys), the demo read-only guard, the
no-advice test, the UX audit, and the honest data states.

Use and edge, piece by piece (the owner's standard): the Today card and
the scan save the reader leaving the app for the chain; the chart-levels
rail turns their own levels into a fact about open interest; the setup log
and its grades are the only path to a measured edge and are deliberately
empty of claims until measured; the crypto desk's cost, holder and risk
reads keep a reader out of pools that cannot be exited; the chain store and
event replay are infrastructure whose edge arrives when the history exists,
and the state doc says so rather than pretending otherwise.

Still owner actions before a public launch: rotate the credentials named
in the Security blocker section; set BATCAVE_EDITION=demo and the access
settings per docs/DEMO.md; decide whether the public crypto desk runs on
its own host so its API budgets are not shared with the personal server.

Next step: CI, PR (#16); then a CSP audit and the phone nav regrouping.

## 2026-10-21: review pass on the merged log (feat/ci-main-gate)

Independent review of PRs #12-#16 after merge (32 tests passing before,
the reviewer found 25 items). Fixed here:

Must-fix. (1) The horizon pass had no lower bound and priced every
historical row days after its horizon, then called that a 72 h mark; the
"hold" rule would have been built on non-replicable exits. Now:
HORIZON_PASS_SINCE_MS = 2026-10-20, a mark more than 24 h late closes the
row as tried-and-unavailable instead, per-row exponential backoff on fetch
errors, and a one-time repair nulls marks written on rows detected before
the bound. (2) A rugged pool with no horizon mark was dropped from the
hold denominator (survivorship bias on the worst outcomes); RUGGED is -100
under every rule now.

Should-fix. Flow confirmation read only the flow engine's pending hits
(flushed 60 s after firing), so flow.maxAgeMin never applied; confirming
prints now come from the pending hits plus the persisted whale alerts of
the last maxAgeMin minutes. An unknown calendar blocks instead of passing.
A post-release quiet window (events.tier1QuietAfterMin = 60; rule book
2026.10.21-1, pinned). The Wilson interval is withheld below the gate
(counts only means counts only). Daily bars are dated by their noon so a
midnight-UTC bar start cannot shift a release day to the prior session
(shared dailyBarEtDate, used by the event replay and the scan's 20-day
average; demo bars start 01:00 ET so tests could not catch it). The grader
skips a symbol whose minute bars came back stale or unavailable instead of
expiring rows on partial bars. The setup log reads unavailable when no
symbol has a structure read. One quote call per tick for the universe.
Index symbols carry no bid/ask: SPX/NDX/RUT cost is modelled from the
SPY/QQQ/IWM spread and the row's features say so. A process-wide scan
limiter (20 fresh symbols a minute across all readers) on top of the
per-IP one. Research-events symbol validated; both caches evict. Zero
spread blocks ("locked or stale quote"); invalidation breached at
detection blocks. Rank score is a fixed six-margin mean with missing = 0
and the calendar distance shown but not scored. Half-day close from the
exchange calendar. A persisted desk-risk state older than 10 min reads
unknown on restart. CPI coverage text corrected to November onward; a
release dated today is future until 16:10 ET. Copy: puts bought at the ask
confirm a down move (the code was right, the text was not).

CI now also runs on main, and a test pins the rule book's content to its
version string (a threshold change without a version bump fails).

Not done from the review: CSP; a bound on the limiter's bucket map under
sustained distinct-IP floods (sweep-only today); X-RateLimit-Limit header.

## Current objective

Save the credit-conserving resume framework and assess reuse of the existing
GitHub app for iOS. No native implementation or new deployment authorized in
this checkpoint.

## Verified this session

- Repo: `doodlecoder47282/pulse-market-sentiment`.
- Local and remote `main` matched `1e9028809e371b73233ac33680db5b58692264ec` before this documentation change.
- GitHub reports PUBLIC visibility, contrary to older private-repo assumptions.
- Existing stack: React/Vite client, Express/Node server, SQLite/Drizzle.
- No tracked Swift, Xcode project, or Capacitor configuration was found.
- API transport uses the preview-specific `__PORT_5000__` mechanism. It needs an explicit secure backend URL and auth design for a bundled native client.
- Unrelated runtime changes exist in scheduler state and database/session files. They must not be staged with these docs.
- No runtime build, native build, or fresh market-feed validation was performed for this documentation-only task.

## Security blocker

`RAILWAY-DEPLOY.md` contained literal Schwab client ID/secret assignments.
This change replaces those assignments with placeholders in the current file.
Previous commits still contain the values. Treat them as exposed; removing text
does not revoke a credential.

User/account-owner action: revoke/rotate affected credentials and review OAuth
tokens/authorizations. Do not display values. Repository privacy changes and
history rewriting require approval and coordination; neither has been performed.
Do not redistribute an unreviewed full-history archive.

## Product context

- T1/T2 target derivation and audit persistence work are in the repo.
- Crypto includes scanner, momentum, narratives, security, social, grader, and watchdog routines.
- These routines are deterministic software, not independent reasoning agents.
- Earlier successful build/deploy claims apply to that earlier run, not today's runtime.
- Existing crypto implementation is experimental tracking, not proof of positive expected value.

## Known crypto issues from focused source inspection

Do not repeat prior “all green means complete coverage” claims:

- `socialTick` swallows individual source errors, then can assign `socialScore = 0`
  and update `socialCheckedAt` even when collection failed. Fix source-level
  health, timestamps, missing-value handling, and stale-data expiry before trusting social scoring.
- Bluesky queries use cashtags and at most 25 returned posts. Common words/ticker
  collisions, sampling caps, repeated authors, bots, and incomplete pagination
  prevent interpreting these counts as comprehensive token-specific velocity.
- Pump reply count and linked socials are limited attention proxies, not coverage of X or Telegram.
- Holder concentration blindly excludes the largest account as a pool heuristic.
  That account is not verified as a vault; do not describe the remainder as verified ex-pool ownership.
- `calibrated: graded >= 50` is a sample-count flag, not statistical calibration.
- Previously observed 403 responses do not establish a permanent platform-wide ban or prove the cause.

## iOS direction

Capacitor shell over the bundled React UI; data engine stays on the server.
A customer iPhone can only show the sample demo or that customer's own server
until multi-user + Schwab commercial approval. Customer installs need TestFlight
or the App Store (paid Apple Developer Program, user decision) and enough
native value for App Review 4.2 (push alerts, Face ID lock, haptics).

## Next step

Owner: deploy the demo service (docs/DEMO.md), then set repo variable
BATCAVE_DEMO_URL so the app shows Try the demo. Agent, after approval: merge
quant-fixes to main (Railway redeploys the personal server).

2026-10-22: in-app Schwab sign-in for the iOS build (PR #18, feat/ios-schwab-signin).
The phone's Settings → Open Schwab Login now opens Schwab in the in-app
Safari sheet (@capacitor/browser; shares Safari's saved logins) instead of a
WKWebView tab. The app asks /api/schwab/auth-url?return=app, so the state
issued for that link remembers "app"; the automatic callback
(server/index.ts OAUTH_CALLBACK_PATH) consumes the state first, exchanges
the code on the server, and redirects to batcave://schwab?schwab=connected
(or error&reason=...). iOS hands that URL to the app (@capacitor/app
appUrlOpen; scheme in ios/App/App/Info.plist), the sheet closes and the
dialog refreshes status; a sheet dismissed by hand still triggers a status
check. Website behaviour unchanged (returnTo defaults to web; a forged or
reused state always returns to the website). Nothing new reaches the phone:
no token, no client id, no secret. Deps added via the npm-add workflow;
ios-build.yml's `npx cap sync ios` regenerates CapApp-SPM/Package.swift
(hand-updated to match). Not yet exercised on a physical iPhone from here.

2026-10-23: live verification (PR #19, feat/live-verify). GET /api/verify/live
(server/liveVerify.ts; pure checks in shared/liveVerify.ts) runs with Schwab
connected: (1) reach: 24 panel routes called as the UI calls them, each
classified from HTTP status + dataState (pass / stale / unavailable /
skipped on 429 or no_data / fail); (2) arithmetic: quotes fresh in session,
raw $SPX chain sanity (priced share, IV plausibility, age), 0DTE forward
spot vs quote, walls/pin/net exposure re-derived from the served strikes,
Today map landmarks and $/pt and shares re-derived from its rows, SPY
unusual-flow premium = volume x mid x 100 and vol/OI, put/call per ticker
and index aggregate (VIX excluded), snapshot term ratios and inputs vs
quotes (2% tolerance), scan spread and relative volume vs the same daily
bars, setup engine tick state. Single-flight, 60 s cache, on the upstream
rate-limit bucket. Demo: blocked with zero checks (CI asserts). Client:
LiveVerifyCard in Settings (counts, problems first, show-all toggle);
Method page paragraph. Scope stated on the card: plumbing and arithmetic of
the live run, not predictive edge. Cannot be exercised from the workspace
(no Schwab credentials here, by design); the owner's first run after
connecting is the live test.

2026-10-24: live UI on the phone (PR #27, feat/ios-live-ui). capacitor.config
server.url = the owner's Railway server: the native shell loads the terminal
from the server on every launch, so a merge updates the app when Railway
redeploys, with no Xcode step; the bundled webDir is the fallback only.
queryClient.getApiBase prefers the page's own https origin on native
(liveOriginBase) so the connection screen does not appear. ios-build.yml
removes `server` for the simulator check (never reaches the live server from
CI) and restores it for the zip, failing the build if the url is missing.
Xcode is needed only for native changes and the 7-day Personal Team expiry
(Wi-Fi run after the first cable pairing). docs/IOS.md "Live UI" section.

2026-10-23: Trade Desk + Signals audit, pass 1 (PR #22, fix/trade-desk-signals-audit).
Independent formula-by-formula review against Schwab payload semantics.
Fixed (each with a regression test in tests/quant/schwab-semantics.test.ts):
per-ticker gamma (tickerAlpha) rebuilt on the shared re-priced basis
(gexByStrikeFromChain) so Schwab's -999 vendor gamma can never price a
contract; walls/flip/regime now the same basis as the snapshot and 0DTE
forward; regime via gexRegime (noise floor, never "positive" at 0); all
contracts in a strike cell read; pcrOi/pcrVol null without a denominator.
Index symbols reach Schwab as $SPX/$NDX/$RUT/$VIX from the positioning path
(the bare name was sent before: SPX scan structure and SPX setups were
silently unavailable). 0DTE forward carries chainAsOfMs/chainAgeMs/
chainStale/servedFromCache; the map gets dataState "stale" and the Today,
chart-levels and map cards show the chain's age, not compute time (the
ledger does not keep stale maps). Forward totals skip settled AM contracts
and sentinels; pin = largest POSITIVE exposure within 1.5% (same as the
map); straddle needs both legs; mid needs a real bid. Setup engine uses
this tick's fresh quote as spot (positioning snapshot is cached 5 min);
stale/missing quote -> "no_fresh_spot", blocked. Unusual flow: missing
volume/OI skipped and counted (skippedMissingFields), never a "new strike";
greeks via schwabNum; IV stays in percent and the Chart-tab panel no longer
shows it x100; /api/flow/unusual reports dataState "stale" when the chain
was re-served. Snapshot max pain is null (not spot) when no strike has OI;
playbook/composite/daily playbook/trajectory guard it. Scan column
"notional" -> "premium"; setup-log calendar copy matches the detector
(unknown calendar blocks). Not yet done from the review: phone tap targets
and truncation, abbreviations, prediction-flavoured copy (S16/S17), term
sigma label when closed (S4), gamma curve vs flip IV basis (S8), TodayCard
band wording (S5), scan IV/skew labels (S6), client FlowAlertsPanel dedup
(S13), monthly-opex pre-open AM OI (S15). Next tabs: Models, Heatseeker,
Regime, Flow, Crypto.

2026-10-23: audit pass 2 (Models, Heatseeker, Regime, Flow; PR #24,
feat/audit-pass-2, stacked on pass 1). MUST-FIX items fixed, each pinned in
tests/quant/audit-pass-2.test.ts: Killbox used Schwab's vendor gamma
(incl. the -999 sentinel) when no sigma could be solved, poisoning bars,
walls, stability and regime after the close -> vendor gamma only in (0, 1],
unpriced contracts counted, dataState "no_iv" + reason, regime
"indeterminate", client empty state says "cannot be priced", strike readout
shows "not priced" instead of "$0 neutral". Heatseeker call/put wall could
land on a wrong-signed strike (init at +-Infinity) -> init 0, null when no
qualifying strike. Depth-Skew-Flow never counted sells (checked
"sell_inferred"; server emits "sell") and labelled a per-poll increment as
net flow -> "sell", label "(last poll)". GEX cell "from open" arrow was per
browser session and ignored expiry -> keyed by expiry, labelled "since first
view HH:MM ET", bounded map. 13-week cone footer stated a VRP scale and
event bump the server no longer applies -> renders the server's own
methodology string. ML accuracy "7d/14d/30d" were graded ROWS (several per
session) and 0% was shown with zero calls -> windows by session date with
n and sessions, null hit rates, sparkline/trend skip empty windows. Flow
Alerts re-fired WALL/HEAVY/UNUSUAL every 30 s with random ids -> deterministic
ids (shared/flowAlerts.ts), merge-on-poll, "OI is the prior close" copy.
Flow side bars attributed re-tagged whole-day volume as new ask/bid flow ->
side deltas capped at the bucket's new volume, premium deltas clamped and
scaled, bucket marked "re-tagged" in the tooltip. Whale conviction text
claimed "historically lifts hit-rate" with the total n -> "heuristic weight
x1.23 ... n=<in regime> of <total>", shrunk, not a forecast. SHOULD-FIX
items deferred (see the audit report in the PR): unit labels on Net
Vanna/Charm and mixed Y axis, Killbox r/q basis on the IV solve and
contractExposure, 24 px controls, title-only method notes, term-structure
convention named on each screen (three conventions), prediction-flavoured
copy (headline/canary/pivot/playbook), OFI "ACCELERATING" at zero slope,
Mag7 N/7, BreadthCard error branch, RegimeHeadline truncation. Next:
pass 3 = phone UI + copy sweep across all tabs; Crypto tab audit.

2026-10-23: Crypto tab audit (PR #25, feat/audit-crypto, stacked on pass 2).
Fixed, each pinned (tests/quant/crypto-expectancy.test.ts, crypto-verdict
.test.ts, regime-crypto-r2.test.ts): grader labelled a row DOUBLED when the
market cap at signal was missing (peak >= 0 x 2) -> NO_DATA past the
horizon, never DOUBLED/DEAD; persistSignal writes the same marketCap ?? fdv
basis the verdict uses (+ mcapBasis in features). Graded HIT_5M exit was
the grader's later sample (last_mcap) while labelled a limit sell at the
target -> min(peak, target) at the peak-sample depth (targetMcap passed to
summarizeExpectancy). Basis text claimed RUGGED is -100 under every rule;
only hold is -> text now states the three rules (hold -100; graded at rug-
detection depth; peak keeps the pre-rug ceiling). Validation label ignored
survivorship -> summary carries noData / noDataShare / maxNoDataShare
(20%, the desk's sampleGate share) and reads INSUFFICIENT DATA with a
reason when exceeded. Desk risk used a stale venue mid -> venue state read;
stale/failed -> unknown; reason names the venue. Top-10 concentration was
never re-read after a skipped/unavailable indexed call (second candidate
per tick stuck "unread", could never ENTER) -> retried every 30 min while
null; top10Method says "skipped: ..." / "unavailable: ..." so the chip
shows. Desk-risk 10-minute rule applied live (currentDeskRisk) in the
verdict and payload, not only at restart. Missing 24 h volume is no longer
a "dead pool" flag. Deferred: GT/DS field interleave (valueSource),
community quoteAt on failure, parseOhlcv zero volume, hold rule for RUGGED
with a priced horizon mark, CryptoPanel zeros for missing values and
hover-only notes (pass 3 covers the phone items), horizon late-window
label, advice-flavoured copy on the expectancy card.

2026-10-23: audit pass 3, phone + copy sweep (PR #26, feat/audit-pass-3,
stacked on pass 2; 36 files, UI strings and layout only, no calculation
changes). Tap targets >= 44 px on phone (compact above sm/lg) on every
control the reviews listed; truncation removed (ChartLevelsCard, OdteForward,
SetupLogCard, RegimeHeadline wraps and shows VIX/NET GEX meta on phone);
9 px type -> 10 px; swipe hints on the two horizontal tables; canvas/SVG
text 10 -> 11 px. Hover-only method notes became visible footnotes
(ModelsPanel, DailyPlaybookChart, TickerScanCard, OfiHistogram, CanaryStrip).
Units and labels: Net GEX/Vanna/Charm units and scope; "1σ to close"; Trade
Desk gamma tiles in SPY $ vs the $SPX-point map stated; abbreviations
expanded (ORB, EM, R, pp, HVL, RES/SUP/EXT legend); "γ at spot:
large/medium/small" instead of CONF; term ratio formulas named (VIX3M/VIX,
VIX9D/VIX); BEAR/BASE/BULL tagged (RN)/(heur.); MultiDayCone bar date and
σ×blowup; Mag7 N/7 and "difference vs SPY"; scan IV/skew definitions; "95%
CI"; TodayCard band sentence uses band.low/high and labels pin fallbacks;
DepthSkewFlow follows the parent's symbol/expiry and derives DTE; Heatseeker
tracker-window note only for $SPX nearest; Heatseeker and BreadthCard render
the server reason instead of an empty chart; RegimeChip partial state; OFI
"ACCELERATING" only with a non-neutral trend and material slope. Copy:
"Daily Playbook (model)", weight badges, descriptive level boxes; playbook
narrative, regime headlines, canary lines, RegimePanel, heatseeker sticky/
pivot reads, pivotProjection, PositionSizer ("cost model: inputs clear /
do not clear", "modelled outcome, net of cost"), Killbox wording and
dealer-sign line, OdteForward "path end (model shape)" and "model touch
frequency", Flow footnotes, TrackedSignals basis + mark age, FlowAlerts
"fixed thresholds" footer. Still forecast-flavoured (next): EdgeInfo.tsx
dialog copy, TradeDesk tooltip maps and legend row, OdteForward header
chip.

2026-10-27: crypto desk charter (PR #28, feat/crypto-desk-charter). Owner's
standing directive recorded in AGENTS.md and docs/CRYPTO_DESK.md (goal,
sources and retention, rule book, calibration policy, exact math,
verification, review process, roadmap, what is not claimed).
shared/cryptoRules.ts: versioned rule book (CRYPTO_RULES_VERSION
2026.10.27-1) holding every threshold the engine, grader and verdict used;
engine/stats/verdict now import it (tests grep for literals); every signal
row stores rulesVersion; /api/crypto/signals carries rules {version, items};
RuleBookCard on the Crypto tab. shared/cryptoVerify.ts + liveVerify: crypto
section of Verify live data (reach of the four crypto routes; ENTER gates
recomputed per row; sizing and round-trip cost; desk risk vs majors;
expectancy bookkeeping; rule version present), run even when Schwab is not
connected. docs/REVIEWER_BRIEF.md: standing brief for independent review
agents (product, rules, known traps, deliverable shape). Method page updated.
Next (roadmap item 1): replay/backtest of the logged history under the
current rule version, in-sample / out-of-sample, net of cost.
Review of PR #28 (independent agent, docs/REVIEWER_BRIEF.md): 3 MUST-FIX,
6 SHOULD-FIX, all addressed in the same PR under rule version 2026.10.27-2
(no number changed): the book now owns the sustained-flow window (2 of 3),
Jupiter agree/watch bands (5/15), exit-door (3%), mid-rug (-55%) and
honeypot (25 buys / 0 sells) kills, top-10 (45%), LP-lock (50%) and
liq-over-mcap (2x) flags, security retry (30 min), desk-risk age (10 min,
now wired in the engine), and the cost constants (0.25% + 1.0% per leg,
$0.25 priority); dexCross and memeStructure import them. watch.
minScoreWithKill renamed mcapCeiling.watchMinScore (a hard kill is PASS,
never WATCH; charter corrected). Expectancy reports graded rows per rule
version (unversioned rows predate the book and are pooled with the current
version, stated in the basis). Served feed re-applies the desk-risk gate at
read time (no stale ENTER after a desk flip). Verifier gates fail closed on
unread authorities, missing sells, honeypot pattern, exit door, mid-rug,
null score/price; cap ceiling boundary matches the engine (> blocks);
desk-risk check rounds like the engine and uses the desk's clock; the
not-connected verdict is scoped to what ran. Rule-version test now greps
every listed literal and asserts every numeric leaf is read by a module.

2026-10-27: design pass 2 (PR #31, feat/design-pass-2; client/src only, 20
files, no data flow or copy with numbers touched). Card padding scales with
a CSS variable (16 px phone / 24 px from 640); mono numbers tabular
everywhere; horizontal scrollers show edge shadows and a sticky swipe hint
on phones; desktop tab bar scrolls with the active tab in view at
1024-1279; KeyStat definitions tap-to-reveal (hover never opened on touch);
Suspense fallbacks use PanelSkeleton (CLS). Today card tiles stack one per
row on phones in price order; scan stat grids 2/3/6 columns; Composite and
Mag-7 tiles collapse; Chart watchlist becomes a grid under lg; Models rail
is full-width under xl with a two-column flow; Heatseeker/Killbox/
OdteContractChart grids collapse on phones; EventReplay and 0DTE tracker
tables get the shared scroller; Method page rows stack. Reviewed and left
unchanged as already responsive: Regime, News, Cosmos, Take Five, Edge
Lab, Settings, ConnectionGate. Crypto layout utilities touched only
(TokenCard stats, counts grid, MemeStructure zero-edge grid). Noted, not
changed: Heatseeker "Hover GEX cells" copy; chip title-only detail;
ModelsPanel skeleton shorter than content.

2026-10-27: crypto replay (PR #30, feat/crypto-replay; roadmap item 1).
shared/cryptoReplay.ts (pure) + /api/crypto/replay + ReplayCard on the
Crypto tab: the logged record re-read under the current rule book. Four
readouts, first signal per coin: (1) timing, where the sampled peak fell
relative to the signal (at/before = entered after the move); (2) outcomes
by cap at the signal in four bands with Wilson intervals and median net
(graded rule, limit-sell at target); (3) signal-time features, medians for
winners vs losers and win share in top vs bottom third (descriptive, n
shown); (4) re-evaluation: the current rules applied to signal-time fields
only (test pins that outcome/peak/horizon cannot change the answer), gates
not stored at the time listed as unchecked (upper bound), split in-sample /
out-of-sample by detection date, mean/median net, max drawdown of a
$100-per-signal path. Stated limit: no per-coin price series exists, so
peaks are what the ~4-min sampler saw and DOUBLED is a floor. features_json
now also stores score. CI demo smoke asserts the shape. Reach row added to
Verify live data. The owner's observation ("picks a lot, barely any
doubled") maps to readouts 1 and 2; the record decides which hypothesis
holds (late entry vs wrong cap zone vs sampler floor).

2026-10-27: alignment fixes from the Perplexity review (PR #33, feat/news-verdict-honesty).
1) AI news verdict (server/alphaNews.ts, AlphaNewsOverlay.tsx): the prompt told
the model to "return a plausible estimate" of historical stats, shown as a
Historical Analog (N, avg move, hit rate). Removed: analog is never requested
or kept. Scenario prob is a labelled qualitative weighting. The no-LLM
fallback carries basis category_default; its hard-coded weights (55/18/30),
per-category move sizes and R:R 1.8 are hidden or labelled as defaults.
2) Field manual (EdgeInfo.tsx): "The edge" heading and 15 promissory lines
replaced with "What it does and doesn't show"; guard test added.
Not changed, flagged: server/tickerOutlook.ts also asks a model for scenario
prob and target moves (bull/base/bear) and has a deterministic fallback of the
same kind; same treatment is a follow-up. Perplexity's merge/main-plus-local
(602e6b7, Models/Schwab request budget) does not apply cleanly: it sits on two
earlier local commits that conflict with main's removal of the Cboe OI files;
it needs a rebase onto main by its owner (conflicts: oiCapture.ts, oiHold.ts,
schwabFlow.ts, flowAlertEngine.ts, index.ts, schwab.ts). Bybit returns 403 from
a US server (Perplexity's test); OKX answered. PR #32 degrades to partial with
the reason shown and OKX carrying the readout.

2026-10-27: crypto desk funding and open interest (PR #32, feat/crypto-funding).
shared/cryptoFunding.ts + server/sources/cryptoDerivs.ts: Bybit and OKX public
perpetual funding and open interest for BTC/ETH/SOL every 2 min. Descriptive
only: no threshold, no gate, rule book version unchanged (2026.10.27-2). Shown
on the Crypto tab (DerivsStrip), served as feed.derivs, stored compactly in
each new signal's features_json.derivs for the replay to test later. Funding
= exchange decimal rate per interval; per-8h only when the venue states its
interval; open interest only as change between the desk's own reads ~1 h
apart (Bybit docs state no unit for the field); building for the first hour
after a restart. Row states are rebuilt from stored reads at serve time so a
stopped tick ages to stale instead of staying ok (found by the verifier test).
Verify live data gained crypto.derivs (sign, per-8h arithmetic, unit band,
freshness). Not verified live: the build sandbox cannot reach Bybit or OKX and
OKX's response shape is from its public docs; a venue that blocks the server's
region (Bybit blocks some) shows as unavailable with its reason. Tests: 8 new.
Review of PR #32 (independent, REVIEWER_BRIEF): 1 MUST-FIX fixed (verifier
double-rounded and falsely failed correct per-8h figures on 1h/4h intervals;
pinned with 1,600 random rates), SHOULD-FIX taken: tiny-rate direction, badge
is partial whenever a venue is dark, record asOf = oldest read, unit-band claim
reworded (it catches gross errors only; a percent-for-fraction slip is covered
by the parser tests and the live check). Left: OKX open-interest call failure
reads "not reported"; derivs tick throws only when both venues are down.

2026-10-29: crypto contract autopsy + holder-dump stress (feat/crypto-autopsy).
New "Contract autopsy" card on the Crypto tab: paste one Solana mint, the
server reads DexScreener/RugCheck/Jupiter/RPC once (rate-limited 6 s, cached
60 s), scores it with the desk's own scoreCandidate (momentumTick's pair
mapping extracted verbatim into applyDexPair; no behaviour change) and lists
every gate with the rule-book number and pass / fail / unread. Unread is never
pass; liquidity not reported is a kill, as in the engine. Nothing is stored,
tracked or graded; rule book version unchanged (2026.10.27-2). Stress test:
top-10 holders sell 25/50/100% against a constant-product pool (quote side =
liquidity/2); FDV basis with market-cap fallback and a pool-included caveat
labelled. Descriptive arithmetic, not a forecast. Tests: 10 new
(tests/quant/crypto-autopsy.test.ts). Local run: 807 pass; 6 fail only from
packages missing in this sandbox (typescript, node-cron, @anthropic-ai/sdk),
CI has them. Not verified live from the sandbox (outbound hosts blocked).
