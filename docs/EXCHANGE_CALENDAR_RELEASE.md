# Batcave: exchange-calendar implementation

Implemented October 1, 2026 ET. This closes the bounded ticker-brief calendar gap; it does not complete the entire evidence, security or historical-data roadmap.

## What changed

The stock/ETF brief now uses a versioned 2026 cash-equity core-session schedule instead of assuming every weekday is a trading day. The ten full-day closures, two early closes and regular core hours were cross-checked against the [NYSE calendar](https://www.nyse.com/trade/hours-calendars) and [Nasdaq calendar](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule).

- **Prior-session structure:** Intraday references use the prior scheduled session. The session after a holiday no longer demands a nonexistent holiday bar.
- **Holiday-week structure:** Swing references require all scheduled sessions in the previous calendar week, rather than exactly five weekdays. A missing genuine session still suppresses the result; older bars are not silently substituted.
- **ATR:** The exact preceding 15 scheduled bars supply 14 true ranges. Published holidays no longer create false continuity gaps. Shortened-session ranges remain actual observations and are explicitly disclosed when present.
- **Volume:** The existing cumulative/full-day comparison still is NOT time-of-day RVOL. It requires the exact preceding 20 scheduled-session volumes. The comparison is withheld if today or a baseline session is shortened, closed or unsupported; this release does not invent a duration adjustment.
- **Expiry:** Snapshots expire at the next scheduled core open, core close, early close or ET date transition if that boundary precedes their existing freshness deadline. DST uses the existing Eastern Time conversion helper.
- **Impossible bars:** A daily bar dated on a published holiday or weekend is rejected as inconsistent. A surprise missing session remains a data gap, not an inferred closure.
- **Interface:** “Session calendar · published schedule” expands to show the date, session type, scheduled duration, coverage, review time and official source links. Phone controls and links have at least 44px tap targets.

## Deliberate limits

The official schedule lists 2026 early closes at 1:00 p.m. ET on November 27 and December 24; this is cash-equity core-session logic, not an options or extended-hours calendar ([NYSE](https://www.nyse.com/trade/hours-calendars), [Nasdaq](https://www.nasdaq.com/market-activity/stock-market-holiday-schedule)).

- **Coverage:** January 1 through December 31, 2026 only. Unsupported years or a lookback crossing the coverage boundary suppress dependent calculations. A verified expansion, not a weekday fallback, is required for 2027.
- **Live status:** Scheduled hours do not establish actual venue availability, unscheduled closures or individual instrument halt status. The legacy broad `calendar_verified` flag remains false; the separate schedule contract describes exactly what is covered.
- **Point-in-time history:** Review time is not historical known-at time. `point_in_time_safe=false` remains explicit. Calendar versions, provider revisions and adjustment history need a durable ledger before replay or forecast validation can be approved.
- **Scope:** Integrated into the ticker Trade Brief only. Existing legacy alert/scheduler calendars elsewhere in Batcave were not migrated or re-audited.
- **Price availability:** Calendar repair does not restore unavailable authorization, delayed/stale quotes, missing option timestamps or incomplete history. The live after-hours INTC check reported quote/history/options unavailable, and withheld price-dependent output rather than substituting values.
- **Other gates:** No change to public/multi-user rights approval, security isolation, SPY forecast disablement, crypto ENTER disablement or paused iOS/Xcode work.

## Verification

- **55 focused tests passed:** 14 calendar tests plus the existing 41 stock, enrichment, evidence-policy and optional AI checks.
- **Cases covered:** All published closures and early closes; DST in both directions; ET date rollover; observed holidays; weekends; prior-session selection; four-session holiday weeks; restored Labor Day ATR/volume windows; actual missing sessions; holiday-dated erroneous bars; unknown years; exact open/early-close expiry; and exclusion of today’s still-unfinalized bar.
- **Build:** Production frontend and server build passed. Existing large-bundle warnings remain. Full-repo TypeScript retains 59 unrelated diagnostics, none in changed files.
- **Browser:** Real INTC search, selection and Analyze; 375px touch and 1440px desktop; calendar open/close; source-link metadata and tap sizes; fixture early-close and unsupported-year displays; and legacy payloads without schedule metadata. No page exceptions or horizontal overflow in checked states. Both screenshots were reviewed.
- **Cost discipline:** No actual AI-curation request, new model worker, provider subscription, account, credential request or background calendar polling. The main server was rebuilt/restarted once; its existing schedulers and isolated AI worker were left otherwise unchanged.

Logs and screenshots are saved as `calendar-tests.log`, `calendar-typecheck.log`, `calendar-build.log`, `calendar-mobile.png` and `calendar-desktop.png` in the workspace. Tests and fixtures do not certify market-data accuracy, predictive performance or production security.

## Continuation

Calendar version: `us-core-schedule-2026-10-02.1`. Stock output: `stock-brief-2026-10-02.1`. Evidence-policy version: `evidence-policy-2026-10-02.1`; the register now includes two reference-only calendar records in addition to the prior 27 source/product records.

The next foundational gap is durable point-in-time evidence: preserve authorized decision snapshots, acquisition time, revisions, calculation/calendar versions and restart gaps without claiming unknown historical timestamps. Start with a bounded local implementation and replay fixtures; data rights and production security remain independent release gates. Reuse the saved framework rather than repeating council/provider research.
