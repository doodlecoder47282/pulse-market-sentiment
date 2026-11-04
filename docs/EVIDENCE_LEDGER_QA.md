# Durable evidence ledger: verification inventory

## Claims to verify

- **Durability:** Atomic SQLite snapshot and normalized evidence storage survives close/reopen and a separate process. Original versions, observation times, unknown time fields and expired snapshots remain unchanged.
- **Idempotency:** Same snapshot gives one immutable record. Conflicting payload reuse is rejected without overwriting. New captures link to predecessors and flag same-observation differences without claiming an official correction.
- **Integrity:** Changed payload or indexed metadata fails verification. Numerical replay checks supported stored formulas separately from the checksum. Wrong formulas/values or unsupported versions remain explicit.
- **Boundaries:** No provider/model I/O during replay; archives never enter live cache/AI. Receipt-scoped POST retrieval only, non-enumerating failures, no HTTP listing/write routes, no receipt in logs or stored payload. Directory/key/database excluded from commits.
- **Bounds/recovery:** Time/count/byte retention, rollback on failed insert, capture failure without app crash, permissions, missing key fail-closed, clock regression and writer-session continuity disclosure.
- **GUI:** Real Analyze saves and reviews a record. 375/390px touch and 1440px desktop; review/close/reopen, numerical detail and audit toggles, expired record, unavailable receipt and storage failure states. At least44px controls, no overflow or page exceptions.
- **Preserved limits:** Deterministic stock/ETF snapshots only. No crypto migration, AI-selection archive, raw provider backfill, off-device backup, continuous-collection claim, multi-user release, native build or forecast restoration.

## Outcome

74 focused tests passed, including separate-process replay with networking blocked, bounds, privacy, rollback and corruption checks. Production build passed; same 59 unrelated TypeScript errors and none in changed files. Real INTC save/review passed at375px touch and1440px desktop, with natural expiry, review/close/reopen, numeric/audit toggles, invalid receipt, unsaved and legacy payload states. No page exceptions, horizontal overflow, automatic history reads or AI requests; controls checked at44px. Local owner listing, log-body suppression and filesystem permissions verified. Browsers closed. See `EVIDENCE_LEDGER_RELEASE.md` for limitations.
