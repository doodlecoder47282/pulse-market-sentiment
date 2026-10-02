# Batcave: durable evidence-history ledger

Implemented October 1, 2026 ET. This release archives deterministic stock/ETF Trade Brief snapshots on the current backend disk. It does not enable trading, forecasts, native iOS, a global history browser or multi-user brokerage access.

## What is stored

Each newly generated brief is captured once in a dedicated SQLite transaction. The archive preserves the original research output, normalized evidence envelopes, calculation/calendar/evidence-policy versions, input observation times, statuses, dependency IDs and an original-content checksum. Receipt tokens, account objects, OAuth credentials and raw provider responses are not intentionally collected into snapshot payloads.

- **Time semantics:** Captured time remains the brief's original processing time. Recorded time marks the local storage transaction. Missing provider receipt, first-seen and known-at fields remain null. This is not retrospectively point-in-time-safe data.
- **Immutability:** Repeating a snapshot gives the same record/receipt. Reusing a snapshot ID with different content is rejected rather than overwritten.
- **Changes:** Subsequent captures link to the prior retained record for the listing/horizon and disclose changed evidence IDs. Changed values with the same observation timestamp/source are flagged as differences, not certified provider corrections.
- **Continuity:** A new writer session preserves its opening time and prior ledger activity. It does not claim exact downtime, continuous collection or repaired missed observations.
- **Write failure:** Live analysis still returns, with “Not confirmed saved.” A failed insert rolls back its associated retention eviction.

## Reading and replay

Under a generated ticker brief, use **Evidence history → Review saved evidence**. The view is explicitly historical, keeps the original expiry, exposes version stamps and numerical evidence, and cannot invoke AI or place a trade. Closing/reopening the view reuses the already verified result in memory; it does not automatically poll.

The server verifies the stored payload hash and indexed identity/timestamp metadata before returning it. A separate numerical checker recomputes supported classic pivots, true ranges, ATR14 simple mean, price/reference distances, prior20 volume comparisons and matched-date yield spread from the stored normalized inputs. Mismatches, unsupported versions and snapshots without calculations have distinct statuses.

Replay does not re-fetch providers, reconstruct raw OHLC aggregation or options sampling, regenerate prose, prove source truth, validate execution, or establish a predictive edge. An archive read never restores an expired snapshot to the live service/AI cache. Historical decoding preserves older version labels rather than replacing them with today's labels.

## Access and storage boundaries

- **Per-record receipts:** The only HTTP history operation is a receipt-scoped read. It has strict request validation and a bounded request budget; unknown IDs and incorrect receipts produce the same unavailable response. There is no HTTP archive listing, arbitrary write or owner bypass route.
- **Receipt lifetime:** The receipt is retained in this browser tab's memory, not browser storage or a URL. After closing the tab, older records require the local filesystem-owner tool. This is deliberately not a cross-device user-account history system.
- **Logs:** Trade Brief response bodies and malformed-request details are suppressed so receipt tokens are not logged by those handlers.
- **Filesystem:** The dedicated directory has mode 0700; its database and receipt-signing key have mode 0600. Both are gitignored and outside the deployed frontend bundle. Storage is not encrypted at rest, and anyone controlling the backend filesystem/key remains inside the trust boundary.
- **Limits:** Reads are available for at most 30 days, with at most 500 retained records and 48 MiB of payloads. A record is capped at 384 KiB. Expired rows are physically purged on a subsequent successful capture, not while the archive is inactive. Size/count limits can remove records sooner.
- **Durability:** SQLite uses full synchronous commits and rollback journaling. Records survive a process restart on this disk. Loss/replacement of the workspace disk is not covered, and the legacy application backup job does not automatically include this new archive.
- **Recovery:** Preserve the database and receipt key together in an approved private backup workflow. A missing key for an existing database fails closed instead of silently rotating access. No backup was uploaded, exported or shared by this release.

A checksum is an integrity check, not proof against an attacker who can rewrite both database and key. Private receipts are not a replacement for tenant authentication, entitlement enforcement, data-rights review or NIST control evidence. The existing security release gates remain open.

## Local owner commands

Run from the `sentiment-app` repository:

```bash
npm run evidence:history -- list
npm run evidence:history -- inspect <record-uuid>
```

These read-only commands operate on the local archive and do not print the signing key or receipt tokens. The list is limited to the newest 20 retained record summaries. They do not call providers or AI; no web endpoint exposes these owner-only functions.

## Verification

- **74 focused tests passed:** 19 ledger checks plus the previous 55 calendar, stock, enrichment, evidence-policy and AI regressions.
- **Restart proof:** Same-record reading after close/reopen and from a separate process. The separate-process test blocks network fetching and reproduces the record ID, checksum and replay result.
- **Failure checks:** Duplicate/conflicting capture, wrong/cross-record receipts, payload and metadata corruption, numerical mismatch, old version labels, writer-session boundaries, clock regression, time/count/byte bounds, failed-insert rollback, oversized payload, missing key, storage failure and prevention of live-AI revival.
- **Build/types:** Production build passed. Full-repository TypeScript retains the same 59 unrelated diagnostics, with none in the changed files. Existing large-bundle warnings remain.
- **Browser:** Real INTC analysis saved a record and reviewed it successfully; that captured partial-data record had one replayable macro calculation. Tests at 375px touch and 1440px desktop covered review/close/reopen, numeric/audit details, naturally expired output, invalid receipt, unsaved fixture and legacy no-archive payload. No page exceptions or horizontal overflow; 44px controls checked.
- **Privacy/cost checks:** Receipt absent from rendered text and stored snapshot payload; live research logs omit response bodies; directory/key/database permissions and gitignore verified. No automatic history read or actual AI-curation request occurred. Existing AI worker, request caps, iOS and forecast gates remain unchanged.

Verification files: `ledger-tests.log`, `ledger-typecheck.log`, `ledger-build.log`, `ledger-mobile.png`, `ledger-desktop.png` in the workspace. These tests do not certify production security or complete market-data coverage.

## Scope and next gate

Ledger schema: `evidence-ledger-v1`. Existing stock/calendar/evidence-policy versions are preserved. Runtime storage is `data/evidence-ledger/` and must never be committed, bundled into the public frontend, or casually shared.

This package does not archive optional AI selection/order results, migrate crypto adapters, collect raw provider revision streams, provide disaster-recovery backups or certify historical known-at data. Next priorities are a private backup/restore policy and normalized provider acquisition/revision timestamps, followed by a gated crypto migration. Resume from this document and `BATCAVE_STATE.md`, not another broad audit or model council.
