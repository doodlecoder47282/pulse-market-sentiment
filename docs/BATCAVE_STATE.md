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
