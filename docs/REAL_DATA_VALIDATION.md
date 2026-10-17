# Batcave: real-data validation and Schwab handoff

## Current verdict

Live Schwab output accuracy is **not yet established**. The private preview remains demo edition. The Railway health endpoint reports a running protected personal deployment, but that does not reveal feed entitlement, data quality, deployed revision or account connection status.

The previous Settings self-test incorrectly treated HTTP 200 as success even for empty response bodies; demo mode also returned a successful-looking connected test. Both behaviors have been removed.

## Implemented checks

The existing `/api/schwab/selftest` route now runs a bounded, versioned input-validation report. It uses direct authenticated Schwab requests, never simulated payloads or the adapter's stale-cache fallback. Raw access tokens, developer credentials, account IDs and streaming identifiers are not returned.

- **Quotes:** Exact SPY, SPX and VIX identities, finite positive price, real-time entitlement flag, both trade and quote provider timestamps, clock-skew rejection and regular-session freshness. A fresh bid/ask update cannot refresh an old last-trade price. Closed-market observations are qualified rather than called live.
- **History:** SPY identity, nonempty OHLCV, finite prices, consistent high/low, nonnegative integral volume, strict ordering, duplicate rejection and verified exchange-calendar continuity. Current incomplete daily candles are not treated as completed sessions.
- **Options:** A bounded near-term SPY sample, exact OCC/expiry/strike/side matching, standard multiplier, nonstandard-contract rejection, fresh underlying and contract quotes, noncrossed bid/ask, usable IV/Greek values and OI/volume field checks.
- **Streaming:** Configuration availability is reported separately. A returned configuration does not pass a live socket or feed test.
- **Demo/disconnected:** Explicitly blocked without any Schwab probe. No green sample-data pass.
- **Resource bounds:** Shared concurrent checks, a short immutable-copy report cache, bounded token lookup and provider/body reads, no automatic provider retry, and original observation times retained. Expiry follows the oldest passing contract/underlying quote, not just the most recent underlying quote. Results that become stale while other probes complete cannot pass.
- **UI:** “Validate real market data” shows pass/partial/fail/blocked by category, observation times and a scope statement. Reports expire; old HTTP-only response contracts are rejected, and request failures withdraw the previous report.
- **Recovery:** Settings and navigation stay mounted during a cold snapshot load/failure. The old whole-shell skeleton could prevent connection recovery when shared snapshot queries retried; it is replaced with a nonblocking loading notice.

These checks are necessary but insufficient to validate every displayed number. They do not verify exchange-wide option-chain completeness, OI publication age, corporate-action adjustments, executable liquidity, fees, slippage, model calibration or predictive edge. A diagnostic pass does not automatically authorize orders or promote models.

## Schwab user flow

The private preview's Settings handoff is preconfigured with the owner's Railway origin during the frontend build. Its Connect Schwab action opens the personal server, with `?connect=schwab` requesting Settings on the reviewed build. The public origin is not a credential.

Developer app secrets and token-encryption keys remain in the backend environment. No new developer-key input has been added to the browser. The existing access gate remains intact; the preview cannot silently borrow an authenticated Railway browser session.

The old Railway build may not support the Settings deep link or the new validation contract until this code is promoted. In that case, open Settings manually and do not interpret its legacy HTTP-only self-test as quality validation. If an embedded browser interferes with OAuth, open the personal server directly in Safari or Chrome.

Previously exposed credentials are not made safe merely by moving them to the backend. Their rotation remains unconfirmed. No old secret was read, reused or copied during this work.

## Verification and acceptance boundary

The full regression run passed **718 tests, with two skipped and zero failures**. TypeScript and the production build passed. Fourteen focused input/recovery tests cover identity, malformed or empty HTTP-200 data, stale and future timestamps, calendar continuity, contract identity, cache-copy isolation, demo/disconnected refusal, expiry and loading-shell recovery. The two skips were the native SQLite crypto-driver test under the alternate test Node runtime and the Python ML-sidecar dependency test. Neither is counted as a pass.

Six browser acceptance groups passed on Chromium using the actual isolated demo endpoint plus explicitly synthetic failure/expiry fixtures. Coverage includes 375/390/820/1440px layouts, 200% text, cold snapshot failures, legacy report rejection, expiry, a keyboard-activated HTTPS handoff, invalid-address rejection, and a stalled callback with no blind retry. A visual review additionally found and corrected an enlarged validation-button label that needed wrapping. These checks do not establish native iOS, physical-device Safari or successful real Schwab consent.

The isolated demo runtime returned `connected:false`, `realDataChecked:false`, `marketInputsValid:false`, with a blocked validation result. Its Schwab token table and five real-data/ML tables remained empty. No live Schwab observation has been retrieved in this repair, and no synthetic fixture is represented as real-data acceptance.

The final style delta was followed by another successful type check, production build, **38/38 focused tests** and actual-demo browser rerun. The enlarged button was re-inspected visually and remains within its own bounds.

Local evidence: `real-data-validation-full-tests.log`, `real-data-validation-tests.log`, `real-data-validation-check.log`, `real-data-validation-build.log`, `real-data-validation-qa/`, and `real-data-validation-handoff-qa/` in the workspace.

## Private preview release

Implementation commit: `f1a53b1` on the local `review/railway-device-verification` branch. The existing Batcave private preview was updated in place; the isolated demo backend remains on port 5090. No source credentials or databases were included in the frontend release.

Hosted opaque-iframe testing confirmed that Settings opens, the new validation endpoint returns an explicit demo-blocked result, the Railway origin is prefilled, and the modal fits phone and desktop widths without horizontal overflow. No preview page errors were observed.

The Connect link navigated to the exact configured Railway origin with `?connect=schwab` and no opener reference. A popup inheriting a restrictive sandbox remained blank. Opening Railway as a standalone page showed its existing **Access key required** screen; no key was entered and no brokerage sign-in was performed. The existing Settings copy-address/direct-browser fallback remains necessary when an embedded browser blocks the remote application. This is not a successful end-to-end OAuth acceptance.

The Railway access key protects the app itself and is distinct from Schwab developer credentials. No authentication gate was removed. The currently deployed Railway build has not been updated with these local changes.

## Next gate: validate actual outputs, not merely inputs

1. **Establish the deployment:** Confirm the actual Railway source branch/revision and promote the reviewed changes without overwriting concurrent work. Keep developer credentials and encryption keys in server configuration. Rotate previously exposed credentials before live acceptance.
2. **Run authenticated collection:** Sign in at Schwab through the protected personal server. During a regular session, run the new checker and retain the original observations, retrieval time, instrument/contract identity and source privately. A closed-market or missing-entitlement result must remain qualified.
3. **Reconcile calculations:** From the same timestamped snapshot, independently recompute the displayed ATR, prior-session levels, option aggregates and selected GEX/3D-surface cells. Record formulas, units, multipliers, expiry assumptions, selected/excluded rows and differences before setting justified numeric tolerances. Do not compare differently timed inputs as though they were one snapshot.
4. **Test coverage and failure:** Establish full-chain selection/completeness, OI publication age, corporate-action treatment, feed reconnect behavior and stale-data withdrawal. A small option sample does not prove those properties.
5. **Gate curated output:** Only validated observations and independently reconciled calculations may support claims of accurate market output. Forecast calibration and trading edge require separate real-observation, out-of-sample evaluation; software tests do not establish either. News, crypto and macro provider acceptance are not supplied by this Schwab-specific check.

No GitHub push or Railway deployment is implied by the private preview release. The Railway deployment branch and authorized promotion path remain unconfirmed.
