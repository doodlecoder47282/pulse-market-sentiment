# Batcave: new-feature and Schwab acceptance

## Scope and QA inventory

Review checkout: `review/railway-device-verification`, based on `quant-fixes` at `2dd52b9`. Original private-preview source and runtime are preserved separately. No Railway configuration, real brokerage tokens or provider authorization are changed by fixture tests.

- Schwab manual connection: paste alone does not submit; rapid taps send once; rejected callbacks leave an inline recovery message; fresh-link action resets input; successful authorization refreshes data without claiming entitlements.
- Schwab automatic return: no manual-code prompt; check-connection action and polling; copy-link guidance matches configured mode.
- Callback safety: configured URL matching, current issued state, expiry and single-use consumption; safe error messages with no callback/code echo. This remains a single-owner app, not multi-tenant OAuth.
- Thermal grid and 3D: all five Greek selections, rotate/tilt, scale round trip, tap values, grid/3D round trip, resizing and keyboard controls.
- Missing thermal data: missing IV and empty payloads withhold charts, not flat zero surfaces. Refresh failure must not leave a current-looking cached plot.
- Calculations: run the complete existing quantitative suite, including independent first-principles thermal tests, geometry, expiry clocks and settlement accounting. Passing fixtures is not empirical predictive validation.
- Device matrix: Chromium desktop, tablet and touch-phone layouts; light/dark; 200% text. Physical iPhone/Safari remains a separate acceptance gate.
- Deployment: no claim of live feeds without authenticated provider results. Existing credential exposure/rotation, Railway deployed SHA and durable token volume remain release checks.

## Reproduction

Before editing, an isolated browser fixture pasted a synthetic callback and clicked Connect before the 250 ms auto-submit timer expired. The browser issued **two POSTs** to `/api/schwab/callback`. No real code or provider request was used.

## Results

### Repaired

- Removed the 250 ms automatic callback submission. A ref-based in-flight guard protects explicit taps; the manual server route consumes issued state before awaiting a token exchange.
- Manual callbacks are checked against the configured callback origin/path and current sign-in state. Automatic-return installations no longer show manual-code instructions.
- Errors do not echo provider error payloads or callback secrets. Authorization success is not labeled live-feed acceptance. A successful connection refreshes market queries.
- Near-expiry implied-volatility inversion now accepts the same rate/dividend assumptions used by the thermal map and shared GEX repricing. A new independent BSM-price fixture verifies both calls and puts.
- All five 3D Greek modes have correct signed-exposure wording. Dealer inventory is explicitly modeled, not observed; rate/dividend values are assumptions, not live curves.
- Missing-IV/empty responses withhold plots. Missing-only cells are omitted instead of becoming zero-height surface nodes; partial coverage is explicit. An error hides the cached plot.
- Added a keyboard/screen-reader-accessible exact-value table, 44 px mode controls, pressed states, light/dark-aware text, and phone-safe wall labels. Enlarged connection buttons wrap within the dialog.
- Private preview gets a dedicated HTML backend bootstrap and page-lifetime browser-preference facade. The normal Railway build remains separate.
- Demo write permission no longer trusts a loopback socket alone. Internal writes require a per-process proof; brokerage connection/disconnection routes explicitly refuse demo calls.

### Verification evidence

- TypeScript check and production build pass.
- Complete suite using Node 22 and the repository loader: **695 total, 693 passed, two skipped, zero failed**. Final log: `new-feature-final-tests.log`.
- Skipped: one crypto SQL case using the native `better-sqlite3` driver in the Node 22 runner; the Python ML-sidecar suite because its scientific packages are not installed. Neither is certified by the passing TypeScript suite.
- The first run used Node 20/tsx rather than the CI runtime/loader and had 14 failures. It is retained as a failed, non-equivalent run, not silently reclassified as a pass.
- Production-browser handoff fixtures passed six scenario groups: real external-link activation, no submit on paste, single submission on double tap, safe inline errors, fresh-link recovery, automatic return without a code field.
- Thermal browser fixtures passed: five Greek modes, grid/3D and scale round trips, keyboard angle limits, exact-value table, touch selection, responsive resizing, missing-IV, empty and provider-error withholding.
- Phone/tablet/desktop widths: 375, 390, 820 and 1440 px. The login dialog was also checked at 200% root text, including its own scroll bounds rather than only document overflow. Screenshots were inspected and defects repaired.
- Browser fixture APIs are synthetic and isolated from Schwab. Unrelated endpoints intentionally return unavailable in those fixtures, which may show an unrelated quote-error toast in screenshots.
- Evidence files: `new-feature-qa/schwab-results.json`, `new-feature-qa/thermal-results.json`, and the accompanying screenshots outside the repository.

### Release boundary

The user answered **“No or not sure”** when asked whether previously exposed Schwab developer credentials had been regenerated. **Do not reuse the old credentials.** Live brokerage acceptance remains blocked; the prepared private preview runs the explicitly labeled sample-data edition with sign-in disabled. This does not repair or deploy Railway's backend, whose deployed SHA and authenticated configuration remain unverified.

The original `sentiment-app` checkout, private historical ledger and original running backend are preserved. New repairs are in the review worktree only until deliberately promoted. No GitHub push, Railway configuration change, Vercel release, trading action or real Schwab authorization was performed.

### Still required for live use

- Regenerate the exposed Schwab developer credentials and revoke old authorizations as appropriate in Schwab. Remove exposed copies/backups through a separately reviewed cleanup; untracking files is not revocation.
- Install the rotated app configuration only in the protected server environment, never in source or the browser bundle.
- Set and retain independent `BATCAVE_ACCESS_KEY` and `BATCAVE_TOKEN_KEY`, with persistent token storage on the hosting volume. Never remove the access gate to make sign-in appear to work.
- For an automatic Railway return, register the exact callback `https://pulse-market-sentiment-production.up.railway.app/api/schwab/oauth/callback` in Schwab and use that same value server-side. This is a proposed configuration, not a claim that it is currently registered.
- Use a single server instance while OAuth state is process-local, or implement shared state before adding replicas. Restarting during sign-in invalidates outstanding state.
- Promote the reviewed commit deliberately, verify the deployed SHA, then complete a fresh Schwab sign-in. Verify real quotes, chains, entitlements, timestamps, refresh, restart survival and disconnect independently.
- Test physical iPhone/Safari before claiming all-device acceptance. Native iOS remains paused.
- Complete empirical out-of-sample validation before claiming predictive edge or institutional readiness. This review validates bounded implementation behavior, not forecast profitability or NIST certification.

### Known carry-forward gaps

Broader light-theme polish, complete live-source coverage, the separate old Trade Brief/evidence-ledger lineage, unresolved dependency-audit findings, tenant isolation, and the disabled/unaccepted ML sidecar are not closed by this repair. A working 3D visualization is not a validated prediction model.
