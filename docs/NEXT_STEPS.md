# Next steps (written 2026-11-21 for whoever picks this up, human or model)

Read `docs/REVIEWER_BRIEF.md` and the last dozen entries of `docs/BATCAVE_STATE.md` first. This file is the
work queue: each item is small, says where to look, and says what "done" means. Delete an item when it ships.

## How work gets shipped here (the parts that are easy to get wrong)

- One bounded change per pull request, from a `feat/*` branch (CI runs only on `main` and `feat/**`).
- Every change gets an independent read-only review before merge, then CI, then a look at the LIVE site.
  A change is "done" only after it has been seen live. Reviews in this project have found a real fault in
  most first drafts, including in wording. Do not skip them for "small" changes.
- Four test files cannot load without `node_modules` (`alpha-news-honesty`, `connection-gate`,
  `schwab-readiness`, `schwab-semantics`). They pin SOURCE TEXT in `server/schwab.ts`,
  `server/schwabStream.ts`, `client/src/components/SchwabSettings.tsx`, `client/src/pages/dashboard.tsx`
  and a few others. If you move or reword code in those files, grep those four tests for the old text.
- CI's type gate fails if any file gains a tsc error. Two traps met so far: comparing a union member that
  an aliased condition has already narrowed away (TS2367), and `Record<TabKey, string>` tables when a tab
  is added (`client/src/hooks/use-keyboard-shortcuts.ts`).
- CI's layout audit (`tests/ux/ux-audit.mjs`) opens every tab at six sizes. A new tab must be in its `tabs`
  list AND expose `data-answer-tab="<tab>" data-ready="1"` on its one-line answer once its reads settle.
- Copy rules: describe, never advise; a rate never without its count; no claim about who traded or why; a
  failed read is never shown as an empty or zero result; no emojis.
- Schwab allows 100 requests a minute and the first page load after a deploy already uses most of it. Do
  not add a request to the Signals tab or to app start without measuring what it costs.

## Waiting on the first live session (Monday 2026-11-23)

1. **Alert bell announcements.** Seen live: the bell, its list, its states. NOT seen: a toast when a new SPX
   or VIX crossing or a rule arm is logged in session. Watch one arrive; confirm it is announced once.
2. **Volume since flagged** (`shared/volumeSince.ts`). Watch a tracked whale position across the open.
   Open question to settle with one live chain read at 09:30 ET: does Schwab still report yesterday's
   `totalVolume` for a strike after it has traded today? If yes, the documented overcount is real and needs
   the fix sketched in the module header.
3. **Outlook tab** (if merged): first real look at the page with a live chain. Check label overlap on a
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
   against the code that produces the number, the way `shared/whaleWords.ts` was checked (that check found
   thirteen false sentences in a first draft, and one wrong calculation).
3. **Sweeps by class of assumption.** These find real faults faster than reading formulas one by one. Done:
   fixed 390-minute sessions (half days); UTC or server-local "today" (in review at the time of writing).
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
7. **Small leftovers.** The layout audit does not look at `<summary>` elements (24 of them); crypto funding
   is an "average of 1 venue"; `levels.instruction` in the playbook payload still carries BUY/SELL words
   (not rendered); the fresh-whales groups are not capped like the tracked ones; the remote branch
   `fix/today-bar-labels` is a leftover.
