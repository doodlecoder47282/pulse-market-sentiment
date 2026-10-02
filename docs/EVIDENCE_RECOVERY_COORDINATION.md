# Batcave: recovery and evidence-timing verification

This is the developer work register for the authorized continuation after the evidence-history ledger. Completion requires implementation, tests, independent peer review, integrated verification and explicit limitations. An agent's completion message alone is not acceptance.

## Ownership and sequence

| Work package | Implementer | Independent reviewer | Acceptance authority |
| --- | --- | --- | --- |
| Encrypted local backup and isolated restore | Recovery agent | Evidence-timing agent | Parent integrated recovery drill |
| Honest acquisition/cache timing contract | Evidence-timing agent | Recovery agent | Parent schema, regression and browser checks |
| Package scripts, ignore rules, UI integration, release and issue notes | Parent | Agents review relevant boundary assumptions | Final integrated tests |

Workers have disjoint file ownership. They do not restart, deploy, commit, access providers, call models inside the application, change live runtime data or overwrite another worker's files. Findings return to the responsible owner; the parent coordinates a single release.

## Verification gates

- **Baseline:** The existing 74 foundation tests passed before this batch. The existing backend returned HTTP 200. Neither result certifies provider availability or market-data quality.
- **Recovery:** Consistent SQLite snapshot paired with receipt key; authenticated encryption; separate recovery key; safe file permissions; bounded input; supported version only; wrong-key and corruption rejection; no live-ledger overwrite; clean failure handling; same original receipt, timestamps, checksum and numerical replay after isolated restore.
- **Timing:** Original market observation time remains separate from application access time. Unknown provider receipt, first-seen and known-at remain unknown. Cache reuse must not make evidence fresh, and historical schemas remain readable.
- **Integration:** Run `npm run test:evidence-foundation`, compare TypeScript diagnostics with the existing baseline, build once, and test any changed mobile/desktop disclosure with normal controls.
- **Timing GUI:** Expand/collapse receipt timing inside source policy and saved history. Check real no-receipt state plus labeled fixture coverage for source response, local source cache, stale fallback and retained brief-cache lineage. Inspect 375px touch and 1440px desktop, 44px controls, 200% text sizing, no overflow/page errors or automatic AI. An archived receipt must not renew observation or expiry timestamps.
- **Cost and access:** No automatic model calls, new provider fanout, paid integrations, X reconnect, public publishing, off-device export or recurring task. No keys, receipt tokens, ledger payloads or backup bundles in deliverables.
- **Cross-review:** Each implementer reviews the peer's final work and records concrete findings, fixes, unresolved issues and a scoped signoff. A failed check blocks that package, not an excuse to silently weaken the check.

## Release-state register

The implementation and review rows below remain pending until evidence is available. Final outcomes belong in this file and the release handoff, not in unverified completion claims.

| Package | Implementation | Peer review | Integrated verification |
| --- | --- | --- | --- |
| Local encrypted recovery | Complete; final 23 recovery tests | Timing agent independently reviewed; 42 recovery/ledger tests passed | Real two-record isolated restore and exact original browser receipt passed |
| Acquisition/cache timing | Complete; 24 acquisition tests | Recovery agent independently reviewed; no blocking findings | Parent aggregate 121/121 passed; real unknown-state and five-path GUI fixtures passed |

## Review findings

- **ACQ-1, fixed and reviewed:** Transport receipt fingerprints are checked against parsed payloads; metadata-enabled delivery and the brief completed-read cache take isolated copies. Nested mutation/stale fallback tests passed. Changed or unverifiable payloads lose their receipt claim; this does not certify every legacy cache consumer.
- **ACQ-2, fixed:** The UI label “Provider cache” implied an upstream cache. It now says “Local source cache”; the parent will verify the rendered label.
- **REC-1, documented boundary:** The preexisting ledger has no independent receipt-key commitment. Backup can authenticate its captured key/database pair, not detect a key replaced before capture; the original-browser-receipt drill separately proved continuity for the tested record.

## Known issues and boundaries

| Priority | Issue | Required next action |
| --- | --- | --- |
| High | Same-disk copies cannot recover from loss of the workspace | Choose an approved private off-device destination and separate key custody before exporting anything |
| High | Multi-user authorization, brokerage isolation and source redistribution rights are not certified | Keep the preview restricted; complete a separately scoped security and rights release gate |
| High | Historical provider known-at/revision metadata is incomplete | Record future provenance honestly; do not backfill invented timestamps or enable forecasts |
| Medium | Crypto snapshots and optional AI selection results are not in the stock ledger | Migrate under explicit schemas, retention and independent tests after recovery gates pass |
| Medium | Calendar coverage is bounded to 2026 | Verify the next year's official schedule before expanding the contract |
| Medium | Full-repository TypeScript has 59 existing diagnostics | Keep new work diagnostic-free; triage existing errors separately rather than hiding them |
| Medium | Live stock quote/options/news coverage can still be partial or unavailable | Preserve source-specific reason codes; the ledger does not repair source entitlements |
| Medium | Existing fixed header/navigation controls clip at 200% text enlargement | Repair the app shell in a separate mobile accessibility ticket; the new disclosure wraps without page overflow |
| Medium | Backup retention is manual and a crash may leave private plaintext staging | Define owner retention/cleanup and off-device key custody; no secure-erasure or crash-cleanup guarantee |

iOS/Xcode stays paused. SPY forecasts, crypto ENTER and executable trade recommendations remain disabled. Do not infer a validated trading edge from an integrity or replay test.

## Integrated evidence

Parent reran `npm run test:evidence-foundation`: 121/121 passed. Production build passed; TypeScript remains at the same 59 preexisting diagnostics with none in changed files. Main backend was rebuilt/restarted once, with the separate AI worker unchanged and no model credentials added to the main server.

The real local drill created an encrypted package and restored 2 records into a new isolated directory: both replay summaries matched. A previously issued browser receipt returned the exact original historical response from the restored copy in a separate process with fetching blocked. No production directory was replaced and no package/key was exported. Files and key remain in ignored private directories with 0700 directory and 0600 file permissions.

GUI checks at 375px and 1440px covered real analysis/save/history with unknown receipt state, disclosure open/close, five clearly synthetic transport/cache-path fixtures, stale fallback warnings and original retained adapter lineage. New controls measured 44px; no page exceptions, document overflow or AI-curation requests occurred. At 200% text sizing the new disclosure wraps, but the existing shell clipping remains listed above. Fixture data was browser-intercepted only, not written to the live ledger.

Saved verification evidence: `recovery-foundation-final.log`, `recovery-typecheck-final.log`, `recovery-build-final.log`, `recovery-mobile-live.png`, `recovery-mobile-timing-fixture.png`, `recovery-desktop-timing.png`, `recovery-mobile-enlarged.png`. Detailed peer decisions and owner commands are in `EVIDENCE_BACKUP_HANDOFF.md` and `EVIDENCE_ACQUISITION_HANDOFF.md`.

## Low-credit continuation rule

Resume from `BATCAVE_STATE.md`, this register and the narrow handoffs. Reuse tests and cached evidence; assign at most two non-overlapping workers for this batch. Stop at the next external approval or unavailable-data dependency rather than launching a broad audit, another council or an unrelated project.
