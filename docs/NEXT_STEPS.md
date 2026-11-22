# Next steps (as of 2026-11-21, after PRs #143 to #150; for whoever picks this up, human or model)

Read `docs/REVIEWER_BRIEF.md` and the last dozen entries of `docs/BATCAVE_STATE.md` first. This file is the
work queue: each item is small, says where to look, and says what "done" means. Delete an item when it ships.

## How work gets shipped here (the parts that are easy to get wrong)

- One bounded change per pull request, from a `feat/*` branch. CI (`.github/workflows/quant-fixes.yml`) runs
  on a PUSH to `main`, `quant-fixes` or `feat/**`; there is no pull-request trigger, so another branch name
  gets no CI. A run takes 15 to 20 minutes.
- Order: independent read-only review (give the reviewer `docs/REVIEWER_BRIEF.md`; it must return a verdict
  and concrete findings) -> fix -> re-review until MERGE-READY -> CI green on the head synced with main ->
  squash-merge -> Railway deploys `main` in about 5 minutes -> look at the LIVE site
  (https://pulse-market-sentiment-pulse.up.railway.app). "Done" means seen live. Do not skip the review
  for a "small" change. The owner said in chat on 2026-11-21 that reviewed, CI-green changes which only improve what exists may be
  merged without asking each time; confirm that with the owner before relying on it in a new session.
- Tests: `node --experimental-transform-types --no-warnings --import ./tests/quant/loader/register.mjs
  --test 'tests/quant/*.test.ts'` (`npm run test:regression` covers only `tests/*.test.ts`). Without
  `node_modules` four files fail to load for a missing package (`alpha-news-honesty`, `connection-gate`,
  `schwab-readiness`, `schwab-semantics`); CI loads them. About two thirds of the test files read SOURCE
  TEXT, so before rewording or moving code, grep all of `tests/` for the old text.
- Open pull requests not to collide with: #37 and #2 (old).
- CI's type gate fails if any file gains a tsc error. Two traps met so far: comparing a union member that
  an aliased condition has already narrowed away (TS2367), and `Record<TabKey, string>` tables when a tab
  is added (`client/src/hooks/use-keyboard-shortcuts.ts`).
- CI's layout audit (`tests/ux/ux-audit.mjs`) opens every tab at six sizes. A new tab must be in its `tabs`
  list AND expose `data-answer-tab="<tab>" data-ready="1"` on its one-line answer once its reads settle.
- Copy rules: describe, never advise; a rate never without its count; no claim about who traded or why; a
  failed read is never shown as an empty or zero result; no emojis.
- Schwab allows 100 requests a minute and the first page load after a deploy already uses most of it. Do
  not add a request to the Signals tab or to app start without measuring what it costs.

## The owner's rule for every screen (said 2026-11-21)

"Every line has to be useful and clear to read." Apply it as a test when touching any tab: a line that
repeats another, hedges without adding a fact, or explains something obvious goes; a caveat is said once
per card, not once per row; a long table opens on the rows that matter with one button for the rest and
says how many are hidden. Trimming must not remove a data state (see `docs/REVIEWER_BRIEF.md` rule 1): the
first trim of the Outlook tab dropped a "strike range read is not complete" warning and the reviewer caught it.

## Waiting on the first live session (Monday 2026-11-23)

1. **Alert bell announcements.** Seen live: the bell, its list, its states. NOT seen: a toast when a new SPX
   or VIX crossing or a rule arm is logged in session. Watch one arrive; confirm it is announced once.
2. **Volume since flagged** (`shared/volumeSince.ts`). Watch a tracked whale position across the open.
   Open question to settle with one live chain read at 09:30 ET: does Schwab still report yesterday's
   `totalVolume` for a strike after it has traded today? If yes, the overcount described in the module
   header is real and needs a fix (none is designed yet).
3. **Outlook tab:** first look at the page with a live chain (seen so far only on a closed market). Check label overlap on a
   phone, that the option-map note appears when the board's map is stale, and that "share of open interest"
   is not n/a in session.
4. **Half day 2026-11-27 (13:00 close).** The regime read, exit timing, hazard walk and the 0DTE alert
   engine's end-of-day window were moved to the real session length. Look at each during that session.

## Decisions only the owner can make

- **Index option fee.** 34 SPX positions are left out of the whale record because no all-in fee per
  contract per side is set (`INDEX_OPTION_FEE_PER_CONTRACT`, `server/feeConfig.ts`). Needs the owner's
  actual Schwab cost.
- **JPM collar strikes.** The strikes on file expired; the collar live to 2026-12-31 was never entered for
  want of a reputable source (`server/jpmCollar.ts`). A friend's chart shows 6,110 / 7,245 / 8,060: not a
  source. Enter only from the fund's filing or reputable reporting; the Outlook then draws it.
- **Schwab streaming.** Off because the developer app lacks the "Accounts and Trading Production" product
  (or the sign-in had expired). Adding it also grants the app account and trading scope. Owner's call.
- **Whale alerts' place.** Record over the last 7 days at the time of writing: 16 of 86 made money after
  costs, average -41%, flagged on 3 days. Whether they stay on the first tab is the owner's call.

## Open work, most valuable first

1. **Startup request burst.** After every deploy the board shows "stale" for a few minutes because the
   first page load spends the whole 100-request minute (flow: about 20 chains; macro: 14 daily reads;
   regime: 10). `server/schwabCacheStore.ts` already restores settled daily bars across restarts; chains
   are not restored. Done when a deploy in session leaves the level board's quotes current within one
   minute. Measure with Settings > "Requests by feature".
2. **Finish the tab-by-tab pass.** Done so far: Signals (wording; whale panel glossary; tracked list).
   Not started: Chart, Models, Heatseeker, Trade Desk (beyond chart levels and the board), Regime, Cosmos,
   News, Take Five, Edge Lab, Crypto. For each tab: (a) read the live page as someone who has never traded
   an option and list every label that is explained nowhere, every tool that shows nothing until something
   is typed, every sentence that could be read as advice or a forecast; (b) fact-check each explanation
   against the code that produces the number, the way `shared/whaleWords.ts` was checked.
3. **Sweeps by class of assumption.** These find real faults faster than reading formulas one by one. Done:
   fixed 390-minute sessions (half days); UTC or server-local "today" on the server (PR #144).
   Found by that sweep's reviewer and NOT fixed yet (each is a confirmed fault, small, and wants its own PR):
   - `server/econWeek.ts` (about lines 102, 160, 171) buckets the week's events by UTC day: an 8 PM New York
     event lands on the next day's row;
   - `client/src/components/Heatseeker.tsx` (about 184-212, 284) builds the expiry quick picks from the
     browser's date, memoises them for the life of the page, and counts weekdays, not sessions;
   - `client/src/components/TradeDesk.tsx` (about 1610-1615) `isOpexToday` uses the browser's date and
     misses an OPEX moved by a holiday (use `shared/exchangeCalendar.ts`);
   - `server/tickerCalendar.ts` `MACRO_2026` ends 2026-07-29, so the per-ticker calendar shows no macro
     event after that date, and two of its dates are wrong (June quad OPEX is listed as 06-20, a Saturday: it was 06-18;
     the June jobs report is listed as 07-03: it was 07-02). Either extend it from official release calendars or drop the table and read the news calendar;
   - the earnings cache in `server/earnings.ts` is not keyed by day, so a list cached before midnight New
     York time is served into the next day until it expires.
   Also new with #144: the Trade Desk "Scheduled releases today" card draws for the first time (its list
   was always empty before). Look at it on the first day with a HIGH-importance release.
   Not done:
   - weekday checks that ignore holidays (`getDay()` / `getUTCDay()` used to mean "is a session");
   - volatility scale mixed between percent and fraction (`iv > 1`, `/ 100` near an IV);
   - a hard-coded contract multiplier of 100 applied to a future or an index product with another one;
   - `|| 0` or `?? 0` turning a missing number into a real zero that is then displayed or averaged;
   - client-side `new Date()` date math in the browser's zone on anything keyed to the session.
4. **Outlook, next steps** (only if the owner wants more): the VIX futures curve (first confirm Schwab
   serves `/VX` quotes; `/ES` and `/NQ` work through `server/schwabFutures.ts`); a longer horizon needs a
   longer chain read and its request cost measured; scenario lines are deliberately absent.
5. **ES and NQ levels.** They show only the quote's own day fields. Prior-day high/low and pivots need
   futures bars; `docs/BATCAVE_STATE.md` explains why none are requested (a refusal cools the price-history
   endpoint for SPX too). A safe version: one guarded attempt per session with a long negative cache.
6. **Push alerts to a closed phone app.** The bell works only while the app is open in a tab. A real push
   needs a push service and, on iOS, the Capacitor push plugin and an APNs key.
7. **News tab.** Fixed: keyword tags (PR #148); quote pages in the feed and the "Market-relevant /
   SPX-relevant" header that claimed a filter the feed does not have. Still open: (a) the feed carries
   advice columns and sports results under OTHER (160 of 200 stories when last seen); hiding OTHER by default
   is a product choice for the owner. (b) The ALPHA card tells the reader to "set ANTHROPIC_API_KEY or
   OPENAI_API_KEY": developer text on a user's screen, and it omits the third key the route accepts.
   (c) `server/routes.ts` still holds a dead `ALPHA_SYSTEM_PROMPT` that asks for "TRADE IMPLICATIONS".
   (d) `QUALIFIERS` in `server/alphaEngine.ts` still adds bearish votes for a bare "crash".
7a. **Edge Lab daily playbook.** PR #151 stopped it drawing a one-day path from a wall that is out of one
   day's range. Still open on the same card: (a) its wording is instruction-style ("Targets", "trigger",
   "cascading sells", "Put wall as last line", BULL/BEAR headers); rewrite as description, as was done for
   the Trade Desk releases card. (b) The walls come from every expiry in the chain read; for a one-day card
   the owner may prefer walls from the nearest expiries only. That changes numbers shown elsewhere, so it is
   a decision, not a fix. (c) The weights are ungraded hand-set tilts; either grade them against outcomes or
   drop the percentages. (d) The Daily Playbook chart may still draw the far wall's target zone as a band.
8. **One source of event dates.** `server/econWeek.ts` still estimates a jobs chip by the first-Friday
   rule (wrong on Jan 1 and Oct 1, 2027); `shared/macroCalendar.ts` and `server/tickerCalendar.ts` (see 3)
   keep their own lists. Point them all at `NFP_DATES`, `CPI_DATES` and `FOMC_DATES` in
   `server/volCalendar.ts` (the last two need exporting first). Separately: the computed CPI and jobs rows there have importance "medium", so
   they do not reach the HIGH-only releases card when the official BLS read fails.
9. **Small leftovers.** The layout audit does not measure `<summary>` elements, so a collapsed section's
   tap target is never checked; crypto funding
   is an "average of 1 venue"; `levels.instruction` in the playbook payload still carries BUY/SELL words
   (not rendered); the fresh-whales groups are not capped like the tracked ones; merged branches are not deleted on
   the remote.
