# Stage A verification inventory

This is a bounded source-policy and evidence-contract release, not a provider expansion or production certification. Existing calculations and research-only gates must remain unchanged.

## Checks

- **Source inventory:** Stable IDs, shared upstream lineage, unverified rights, disabled X/Pump.fun and inventory-only crypto are explicit. No source registration is reported as healthy or licensed.
- **Contracts:** Reject unknown sources, incompatible identities/units/precision, future/expired observations, invalid citation URLs, duplicate IDs and tainted or cyclic dependencies. Preserve zero and unknown timestamps.
- **Integration:** New stock snapshots expose a versioned review; AI recomputes it using request time. Legacy evidence without source IDs cannot enter AI. No new provider or actual AI calls in tests.
- **Calculated regressions:** Existing quote, pivot, ATR, volume, macro, cached news, earnings and option tests remain passing. Unknown news publishers/URLs are excluded before display.
- **UI:** Find listing, select and Analyze; open/close source-policy disclosure at 375px touch and 1440px desktop. Read counts, unverified rights and excluded reasons. Verify 44px disclosure target, no clipping/page overflow and no automatic AI POST.
- **Negative UI scenarios:** Expired snapshot withdraws current eligibility; source failure leaves visible reasons instead of spinner or blank screen. Older payload without a review remains readable.
- **Limits:** No crypto adapter migration, calendar implementation, persistent evidence ledger, legal rights audit, credential closure, NIST certification, public deployment or iOS work.

## Outcome

41 focused tests passed; production build passed. Full typecheck retains the same 59 unrelated diagnostics, with none in changed files. Real-response Intel lookup/Analyze, source and exclusion toggles, 375px touch and 1440px desktop fit, natural expiry, fixture HTTP 503 and legacy response compatibility passed. No page exceptions, horizontal overflow or automatic AI requests were observed. Both screenshots were reviewed and browser resources were closed. See `STAGE_A_EVIDENCE_RELEASE.md` for scope and limitations.
