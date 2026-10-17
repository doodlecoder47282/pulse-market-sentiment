# Batcave: ticker evidence and optional AI curation

## Verdict

The ticker brief now reuses more of the existing calculation and source stack and offers an explicit AI-curation button. It remains research-only: WATCH or INSUFFICIENT DATA, structural references rather than executable entry/stop/target levels, and no claimed predictive edge.

The screenshots showed an incomplete integration rather than another broken search control. News, options, earnings and seasonality had been deliberately excluded because their legacy outputs could not safely meet the brief's evidence requirements. The three-model council diagnosed that boundary; the implementation below connects only guarded inputs.

## What changed

- **Calculations:** Explicit simple-mean ATR14 from 14 true ranges and a prior close; signed USD, percentage and ATR distances from reference levels; cumulative volume divided by the prior 20 completed daily means; same-date 10y-minus-2y Treasury spread. The volume ratio is NOT time-of-day RVOL, and ATR is NOT Wilder-smoothed.
- **News:** Cache-only access to recent, healthy RSS sources with genuine publication-time provenance. Only explicit cashtags or reviewed full-issuer names qualify; inferred ticker tags do not. No per-Analyze RSS/calendar fanout.
- **Earnings:** Exact-ticker, real-only cached Nasdaq records with row provenance. Synthetic, unmarked, stale and wrong-source records are rejected. Calendar dates are not issuer confirmations, and unknown timing remains unknown.
- **Options:** One bounded raw Schwab chain request per symbol, shared/deduplicated with existing reads. Genuine underlying and contract observations must be younger than 60 seconds in either horizon, with identity, standard multiplier, expiry/strike and bid/ask checks. Outputs are sample counts, actual reported sample volume and nearest sampled quotes, not dealer exposure, GEX, OI freshness, unusual-flow intent or probabilities.
- **Presentation:** Calculated findings and reasons for each coverage gap are visible without opening the evidence drawer. Attributed news/events retain source links. Existing mobile navigation and visual design are preserved.
- **Diagnostics:** A resolved null provider response is unavailable, not a successful empty payload. New evidence IDs are semantically checked, and all consumed deadlines shorten the snapshot lifetime.

## AI behavior and request discipline

Use Find listing, confirm the instrument, Analyze, then optionally Curate with AI. Search, Analyze and refresh do not automatically invoke a model.

Claude Sonnet 4.6 receives only a bounded catalog of approved findings, cautions and research checks from an immutable, unexpired server snapshot. It chooses IDs; the application renders the original text. Unknown/repeated IDs and extra fields are rejected. The model cannot supply a price, target, probability, new statement or stronger verdict.

The curator runs separately on loopback port 5002 and is protected by a server-only rotating IPC key. Only that process receives model credentials, so this change does not activate the main dashboard's legacy model integrations. Its persistent attempt ledger limits requests to 6 per rolling hour and 30 per rolling day, with one active worker request, 350 maximum output tokens and zero SDK retries. The main server also deduplicates attempts by snapshot and limits concurrent curation work.

These are request and token controls, not a promise about Computer credit cost. A failed or rejected attempt remains cached for that snapshot. Worker/provider failure, budget exhaustion or expiry leaves deterministic research available and does not initiate another model request.

## Verification

- **Focused tests:** 88 groups passed across the stock brief, enrichment, AI, search interaction, SPY containment and crypto reliability/social/desk/collector suites. This is focused regression coverage, not a full-system certification.
- **Build and types:** Production build passed. Whole-app typecheck still reports 59 pre-existing diagnostics, none in the new or modified feature files; those unrelated errors remain unresolved.
- **Live integration:** Intel lookup returned validated quote, structural calculations and dated macro context. A fresh raw options sample contributed when timestamps qualified; a later stale response was correctly withheld. A real cached earnings row contributed once the existing calendar feature warmed. News had no qualifying exact-attribution item for that tested snapshot; seasonality remained unsupported.
- **Live AI:** Two actual manual curation requests succeeded: one local and one in the deployed opaque iframe. The first selected the cached earnings warning and existing structural/macro observations. Verdict remained WATCH; no generated numeric claim or executable trade plan was added. Unauthenticated direct access to the isolated worker returned 403.
- **Browser checks:** Real Find listing and Enter flows, explicit selection, both horizons, manual Analyze and AI, expiry withdrawal and no-match behavior. Fixture checks exercised fallback, disabled repeat attempt, no automatic AI, horizon withdrawal and a late AI response after a symbol edit. Offline controls recovered after reconnect.
- **Layout:** The brief had no horizontal overflow at 375, 390, 430, 1280 and 1440 pixels. A long dependency-label overflow found during 200% text enlargement was fixed and retested with expanded evidence/methodology at phone width. Phone and desktop screenshots were inspected; no page exceptions were observed in these checks.
- **Deployed check:** The existing Batcave asset was updated in place. Fresh 390-pixel touch QA inside an opaque sandboxed iframe passed startup, Find listing, listing confirmation, Analyze and AI curation with a 200 response and no page exceptions. Implementation commit: `f43a1ff`.

## Remaining limits

- **Feed completeness:** News and earnings depend on existing caches; cold caches are unavailable and headline sampling is not exhaustive. No missing record means “no catalyst.”
- **Calendars and adjustments:** Exchange-holiday completeness, halts and corporate-action adjustments are not validated. The conservative weekday-continuity check can suppress the 20-session volume baseline around a holiday, including the tested Labor Day window.
- **Seasonality and execution:** Asset-specific seasonal validation, time-normalized volume, full-market options flow, reliable execution costs, actionable plan rules and forward performance validation remain unfinished.
- **Identity scope:** Search still covers the curated 29-listing stock/ETF universe, not all securities or crypto.
- **Security and operation:** This release is not NIST certification, a penetration test, a multi-user brokerage-isolation review or guaranteed continuous collection. Separate worker credentials reduce a specific exposure and spending risk; they do not resolve the broader production security gates.
- **Preserved pauses:** iOS/Xcode remains paused. SPY forecasts and crypto ENTER promotion remain disabled. No X reconnection, paid subscription or new social account was performed.

## Low-repetition restart checkpoint

Read this file, `BATCAVE_STATE.md` and `SOCIAL_PROVIDER_EVALUATION.md` before resuming; do not repeat the full council or legacy audit. Calculation version is `stock-brief-2026-10-01.2`. Main server remains `NODE_ENV=production node dist/index.cjs` on port 5000 without the LLM preset; the isolated curator uses `./node_modules/.bin/tsx server/briefAiWorker.ts` on port 5002 with the website LLM preset.

Keep `data/brief-ai/` private and excluded from source commits and frontend bundles. It contains the IPC key and persistent attempt ledger; do not erase it to bypass call limits. Runtime databases, scheduler state and prediction/session files are not part of this code release. Update the existing Batcave preview, never a duplicate.
