# Batcave: stock research and Crypto navigation repair

Prepared October 2, 2026. This release addresses the reported inaccessible Crypto workspace, repetitive stock-search surface and missing usable historical context. It is not a certification of all providers, financial accuracy, security or production availability.

## Root causes and fixes

- **Crypto appeared not to open:** Stock research was mounted above every workspace. Selecting Crypto could leave its actual content below the visible screen. Stock research is now scoped to Stocks/Signals, with its state retained while hidden. Changing workspaces scrolls to the selected workspace in both directions.
- **Hidden mobile navigation:** The eleven-item horizontal navigation made Crypto difficult to discover. The mobile dock now always shows Stocks, Crypto, Chart and More. More exposes all eleven workspaces, supports enlarged-text reflow, returns keyboard focus on close and has a 44px close target. Desktop navigation and canonical workspace keys are retained.
- **Excessively long research output:** The default result now shows a timestamped price, completed-session context, at most three sourced findings and the next verification step. The search form collapses after successful analysis. Saved evidence, optional AI and the full technical record remain available through disclosures.
- **Collector starvation:** Background collectors could consume the shared Schwab request budget before manual research ran. Background requests now stop at 85 requests within the existing rolling 100-per-minute application cap. Interactive stock research can use the remaining capacity. Every transport retry rechecks the cap. This does not increase provider entitlement or override authorization, 403/429 cooldowns or freshness rules.
- **History unnecessarily depended on a live quote:** Real, validated prior-session OHLC/volume and completed-session ATR14 now remain available even if a current quote is stale. The exact scheduled prior session is required. They remain dated historical context, not executable entry/stop/target levels.
- **Narrow headline attribution:** Reviewed, distinctive issuer names may qualify only in financial-context headlines from the existing allowed publisher/feed path. Case sensitivity, original publication date and feed health still matter. Ambiguous names and inferred ticker tags remain excluded.

## Evidence and calculation boundaries

Historical ATR14 remains the simple mean of fourteen true ranges across fifteen scheduled daily bars. It is not Wilder smoothing. Corporate-action adjustment remains unverified. Price-relative ATR and distances still require a separately usable current quote.

Missing, malformed, synthetic, future, wrong-listing or missing-prior-session history does not create historical context. Zero observed volume is preserved. Last observed price is explicitly labeled not live when the quote does not pass freshness checks.

Calculation version `stock-brief-2026-10-02.2` is supported by numerical replay. Existing historical versions remain supported, and old snapshots were not rewritten. Optional AI is also disabled for insufficient-data briefs; ordinary research and navigation do not invoke it.

## Verification performed

- **TypeScript:** `npm run check` passed with no diagnostics.
- **Regression:** `npm run test:regression` passed 232 of 232 tests. Added checks cover historical/live separation, exact-session validation, numerical replay, issuer attribution, navigation structure, capacity reservation and retry caps.
- **Build:** Full production build passed. The final menu-only delta was rebuilt with Vite. The existing large vendor-chunk warning remains.
- **Actual provider response:** An INTC lookup returned dated last-trade evidence, four completed-session fields and historical ATR. The stale quote and delayed options were not promoted to usable live data. This is a bounded successful request, not a throughput or market-open reliability certification.
- **Saved history:** The actual browser receipt retrieved its record, verified the stored checksum and matched sixteen calculations during numerical replay.
- **Navigation:** One-tap Crypto put actual Crypto content in view and hid the stock brief. Returning to Stocks preserved the brief. All eleven More entries were present. Escape closed the menu and returned focus. BTC/ETH, news/macro and meme-discovery surfaces loaded.
- **Browser layout:** Chromium checks at 375, 390, 430 and 1440px, normal and doubled root text, recorded zero document horizontal overflow. At enlarged mobile text, the shell moves out of sticky mode as designed. The More menu reflows to one column. No page exceptions or AI curation requests were observed.

Logs and screenshots are retained in the workspace as `research-cleanup-*.log`, `research-cleanup-browser-results.json` and `research-final-*.png`. They are development evidence, not public market-data sources. Browser emulation is not a physical iPhone/Safari acceptance test.

## Remaining limitations and release gates

- **News:** A bounded cache with strict attribution can have no qualifying recent issuer headline. This does not mean there are no catalysts. Cold feeds, attribution gaps and publisher availability remain visible.
- **Options and live quotes:** Off-hours, entitlement and timestamp gates can still withhold live conclusions. Reserved capacity cannot overcome an upstream outage, expired authorization, provider throttling or exhausted interactive capacity.
- **Crypto:** Existing market/context sources loaded. Broad X coverage, complete current mint/security coverage and calibrated grading are not established by this navigation repair. Research rankings remain WATCH/PASS-only, with ENTER disabled.
- **Other financial modules:** This was not a fresh validation of every legacy chart, model or dashboard label. SPY ML forecasts remain disabled. No actionable entry/stop/target, sizing or claimed predictive edge was enabled.
- **Operations and security:** The private preview depends on the running sandbox backend. This is not always-on production, off-device disaster recovery, a NIST assessment or approval for multi-user brokerage credentials.
- **Scope:** No new accounts, providers, credentials, model requests, public publishing, iOS work or automatic trade execution were added.

## Release record

The changes are ready for in-place deployment after the recorded checks. The final deployed iframe acceptance result will be appended below; a local build alone is not deployed acceptance.
