# Exchange-calendar verification inventory

## Intended claims and checks

- **Published schedule:** Compare the versioned 2026 core-equity closures and early closes against NYSE and Nasdaq, preserving both source URLs and review time. No live status or PIT claim.
- **Date math:** Test DST transitions, ET midnight, all holidays, observed Independence Day, Good Friday, weekends, early-close boundaries and unknown years.
- **History:** Test recovered Labor Day windows, prior-session and four-session holiday-week pivots, genuine missing bars, holiday-dated provider bars, today’s incomplete candle and shortened-session volume suppression.
- **Compatibility:** Existing stock/enrichment/AI/evidence tests; old session objects without schedule remain readable. Forecasts, orders, SPY, crypto ENTER and native iOS remain gated.
- **UI:** Phone 375/390px and desktop1440px. Search, select and Analyze through real controls, open/close calendar details, inspect source URLs and 44px targets. Fixture early-close and unsupported-year states; no overflow or page exceptions.
- **Cost/runtime:** No calendar polling, paid adapter, model call or credential request. One production build/restart after focused tests, same app deployment. No runtime database files in commits.

## Outcome

55 focused tests and production build passed. The full typecheck retains the same 59 unrelated errors and none in changed files. Real INTC lookup/Analyze and calendar toggles passed at 375px touch and 1440px desktop, with no page exceptions or horizontal overflow. Source links and targets were inspected. Fixture early-close, unsupported-year and legacy-no-schedule displays passed. No actual AI requests occurred; browser resources were closed. See `EXCHANGE_CALENDAR_RELEASE.md` for limits and exact scope.
