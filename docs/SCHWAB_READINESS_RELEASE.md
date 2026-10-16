# Batcave: secure Schwab readiness

## Scope and acceptance checklist

This is a single-owner readiness repair, not live Schwab acceptance, a full penetration test, NIST certification or proof of predictive calibration. Previously exposed developer credentials must not be reused. Railway and GitHub remain unchanged unless separately released.

- Settings must distinguish authorization from confirmed feed freshness.
- The web demo must provide a safe handoff to the owner's server without collecting passwords, developer secrets, or callback codes.
- HTTPS-origin validation must reject userinfo, paths, query strings and fragments.
- Settings JSON requests and default query reads must have bounded transport and body parsing, cancellation, and no automatic mutation retries.
- Demo must never populate real-price ML training/scoring tables or start retraining.
- Retraining must require explicit opt-in, serialize boot/weekly runs, bound requests and terminate on failure.
- Runtime databases, caches and session files must be separate from source and other editions. Unknown existing data must not be silently adopted.
- Browser checks: 375/390/820/1440 px, 200% text, keyboard and touch; safe link activation, invalid URL rejection, failed/slow callback, repeated tap, and no misleading live badge.

## Deployment design

Use `npm run build`, then `npm run start:isolated` with `BATCAVE_RUNTIME_DIR` set to an absolute directory on a durable volume outside the source tree and `BATCAVE_EDITION=personal`. On first run the directory must be empty. The launcher writes an edition marker and refuses mismatched editions, unmarked nonempty directories and dotenv files. It does not migrate or delete historical data.

This launcher is opt-in; existing `npm start` behavior is preserved for compatibility. Do not switch a legacy installation to the launcher without auditing its history and planning an explicit migration. The marker prevents accidental mixing, not malicious modification by someone with filesystem access. Use one process/replica per SQLite runtime.

For demo, the launcher strips Schwab environment settings and disables ML startup, logging and retraining. The current private preview uses a fresh demo runtime, not the prior review checkout's sample database. No old records are copied.

Local ML packages and trained artifacts are intentionally not copied into the isolated runtime. ML remains unavailable until an independently provisioned sidecar, matching real-data history and validated model artifacts are verified. Retraining additionally requires `PULSE_ML_RETRAIN_ENABLED=1`; this flag does not certify sufficient data or predictive quality.

## Required owner configuration before live sign-in

1. Regenerate previously exposed Schwab developer credentials and review old authorization revocation. Do not paste secrets into chat or source files.
2. Install the new `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` and exact `SCHWAB_REDIRECT_URI` in the protected server environment.
3. Retain separate `BATCAVE_ACCESS_KEY` and `BATCAVE_TOKEN_KEY`, with durable storage. The access key protects Batcave; it is not a Schwab password or authorization code.
4. Register the same callback in Schwab and server configuration. For this owner's Railway service, the proposed automatic route is `https://pulse-market-sentiment-production.up.railway.app/api/schwab/oauth/callback`. Registration is not verified.
5. Release the reviewed backend to the intended host, verify its revision, then use its Settings sign-in flow. Use a fresh login link, never a saved callback code.
6. Independently verify quote/chain entitlement, provider timestamps, streaming freshness, token refresh, restart survival and disconnect. A valid token alone proves none of these.

The demo Settings handoff opens the supplied personal-server HTTPS origin directly. It never transfers the demo's cache or credentials, does not bypass CORS, and does not update Railway. Native iOS remains paused.

## Verification

- TypeScript check and production frontend/backend build pass. Full Node 22 regression suite: **706 tests, 704 passed, two skipped, zero failed**. The skips remain the native-driver crypto SQL fixture and uninstalled Python scientific ML stack; neither is certified by this release.
- Runtime inspection caught an additional writer: hazard backfill inserted 51,480 simulated minute bars into the calibration table in the first isolated demo drill. The backfill, direct writer and reader now exclude demo. That test directory is preserved, not promoted or migrated.
- The final clean runtime has **zero rows** in `schwab_tokens`, `spx_minute_bars`, `ml_feature_log`, `ml_forecast_log`, `ml_coverage_daily`, and `ml_tick_rv_log`. Startup confirms no retraining; the hazard backfill no longer starts. Other demo-only analytical histories may still be generated, but stay in the edition-owned directory.
- Real local demo responses: health 200; thermal 200 with 3,600 finite-exposure cells; auth-link GET, callback POST and disconnect POST each refuse with 403.
- Browser fixtures: six existing manual/automatic authorization scenario groups passed, including no auto-submit, repeated input sending once, safe recovery and fresh-link reset. The double-input harness was corrected to send native double input without locator retries after the first click disables the button.
- Three new browser groups passed: validated HTTPS handoff with no opener or secret forwarding; 375/390/820/1440 px resize round trip and 200% text without page/dialog overflow; stalled callback recovery with one POST and an unlocked button after timeout.
- Four thermal browser groups passed: five Greeks, grid/3D/scale round trips, keyboard controls, exact-value table, touch selection, responsive resizing, missing-data and provider-error withholding.
- The browser fixtures use synthetic local responses, not real Schwab credentials. Physical iPhone Safari/WebKit, real entitlements, token refresh and restart persistence remain unverified.
- Evidence: `schwab-readiness-full-tests.log`, `schwab-readiness-typecheck.log`, `schwab-readiness-build.log`, `schwab-readiness-qa/*-results.json`, screenshots, and `schwab-isolated-runtime-final.log`, outside source control.

## Remaining boundaries

No financial coefficients, targets or model weights were tuned to make sample outputs look better. Numerical regression success is distinct from empirical calibration, statistical validation or an established edge. The unprovisioned ML sidecar remains unavailable.

This pass improves bounded request behavior and removes unnecessary demo training/backfill work. It does not constitute a production load test or a complete audit of the large legacy codebase. Earlier dependency-audit findings, tenant isolation and historical branch reconciliation remain open.

No GitHub push, Railway deployment, real Schwab authorization, exposed-credential reuse, or native iOS change was performed. The existing private preview alone is being redeployed with the separate demo runtime.

## Private-preview acceptance

Local implementation commit: `35bfd39`. The existing Batcave asset was updated in place using its original static-output folder; the backend now runs on port 5090 from `batcave-demo-runtime-20261016-clean`. The previous demo process on 5089 was stopped after successful deployment. The original legacy backend and its data were not changed.

Hosted checks passed: mobile Settings, validated handoff activated against an isolated destination fixture, 3D canvas, no document overflow/page exceptions in the tested states, reload, and the actual Refresh button (`POST /api/snapshot/refresh`, HTTP 200). A probe of the nonexistent/unapproved `/api/refresh` path returned 403 as expected from the demo gate; it is not the button's endpoint. Brokerage callback remains 403.

Settings also rendered inside a legacy opaque-origin iframe with browser storage blocked. The new panel's measured light-theme text/control contrast ratios ranged from 5.74:1 to 17.93:1. This is scoped contrast verification, not an app-wide WCAG certification.

For live authorization, open the protected personal server directly in Safari or Chrome. Embedded hosts can restrict new tabs or pass their sandbox restrictions to popups; the handoff is not a claim that an embedded preview can complete brokerage OAuth. Do not use the old Railway build with unrotated credentials. Evidence: `schwab-readiness-qa/hosted-results.json` and hosted screenshots.
