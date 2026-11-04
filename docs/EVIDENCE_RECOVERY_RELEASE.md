# Batcave: verified recovery and data-timing handoff

Implemented October 2, 2026 ET as two bounded work packages with separate implementers, mutual cross-review and parent integration. This release improves recoverability and timestamp honesty; it does not certify the whole application, restore forecasts, expand brokerage access or complete the data roadmap.

## Delivered

- **Encrypted local recovery:** A filesystem-owner CLI creates a consistent SQLite backup, preserves the ledger's receipt key inside an authenticated AES-256-GCM package, and uses a separate recovery-key file. Restore verifies the package, database and every physical record before promoting it into a new directory. Existing destinations are refused; there is no automatic live-directory switch.
- **Honest acquisition metadata:** The Schwab quote/history/options path now distinguishes a successful parsed source response, local source-cache hit, stale-cache fallback and later brief-service cache read. Original observation, app receipt, application read and snapshot assembly remain separate. Legacy or unverifiable receipts remain unknown.
- **Mutation protection:** Receipt fingerprints track parsed payloads, not wire bytes. Metadata-enabled transport reads and the brief-service cache take isolated copies. A changed or unprovable payload cannot inherit a proven original receipt. Legacy raw callers retain their existing behavior, not a new blanket integrity guarantee.
- **Readable disclosure:** Open “Receipt & cache timing” inside a current brief's source-policy section or within saved evidence history. Cache reads never renew the source observation or the brief's expiry, and first-seen/historical known-at remain unknown.
- **Developer handoff:** `EVIDENCE_RECOVERY_COORDINATION.md` records ownership, acceptance gates, fixed findings and outstanding issues. Each agent reviewed the other's final code and tests, rather than self-certifying its own output.

## Verification and review

The parent independently reran **121 focused tests**, all passing. This includes the existing ledger/calendar/stock/policy/AI regressions, 23 recovery tests and 24 acquisition tests. Production build passed; the existing 59 full-repository TypeScript diagnostics remain, with none in changed files. Large-bundle warnings also remain.

Code commit `60e0fd1` was deployed in place to the existing Batcave private preview. The final 390px opaque-iframe check passed real Intel listing search, analysis, saved-record retrieval and both timing disclosures. A real Schwab source-response receipt appeared and remained identical in the historical view, with checksum verification, no page errors, no horizontal overflow and no AI-curation request. The brief still withheld a usable current price; a newly received response was not mislabeled as fresh market observation. An older browser receipt also returned HTTP 200 with a matched historical replay after the backend restart.

The live recovery drill backed up and restored **two actual ledger records** into an isolated private directory. Both numerical replay summaries matched. A receipt issued earlier to the browser returned the exact same historical response from source and restored copy, including original timestamps, checksum and research-only restrictions. No production directory was overwritten, no recovery material was shared, and no provider/model fetch was needed for that comparison.

Transport tests execute the actual Schwab module in an isolated VM with controlled dependencies. They cover success, cache, cooldown, throttle, retry/error fallback, absent authentication, parser failure, observer failure, nested payload mutation and brief-cache reuse. They do not claim live provider entitlement or complete source coverage.

Phone/desktop checks at 375px and 1440px exercised real analysis, saving and historical review plus browser-only fixtures for all five timing paths. The new disclosure opens/closes, uses 44px controls, wraps at enlarged text sizes and causes no page errors, document overflow or automatic AI request. The existing fixed app shell still clips some controls at 200% text size; this is recorded as a separate repair, not hidden by the successful component checks.

### Findings closed by cross-review

- **Cache mutation:** Extended protection to both the transport cache and the completed-read cache; added nested-mutation and stale-fallback regressions.
- **Misleading cache label:** Replaced “Provider cache” with “Local source cache,” because the cache belongs to the app.
- **Annotated recovery:** Added a roundtrip test proving new receipt metadata survives with the original historical record and without restamping calculated/unannotated evidence.
- **Key authenticity limitation:** Documented and tested that a source receipt key replaced before backup cannot be retroactively authenticated by the backup itself. The real original-browser-receipt drill separately established continuity for the tested record.

## Operator usage

Commands run locally from the repository with installed dependencies:

```bash
npm run test:evidence-foundation
npm run evidence:history -- list
npm run evidence:backup -- init-key --key-file <absolute-new-private-key-file>
npm run evidence:backup -- backup \
  --ledger-dir <absolute-private-ledger-directory> \
  --key-file <absolute-existing-recovery-key-file> \
  --backup-file <absolute-new-encrypted-package>
npm run evidence:backup -- restore \
  --backup-file <absolute-existing-encrypted-package> \
  --key-file <absolute-existing-recovery-key-file> \
  --restore-dir <absolute-new-directory>
```

Parent directories must already exist, be owned by the operator and have mode 0700; input files require mode 0600. Paths must be absolute, normalized and free of symlink components. Do not paste key bytes into commands, chat or logs. The detailed runbook is `EVIDENCE_BACKUP_HANDOFF.md`; actual packages, keys and restored data are gitignored and must not be attached to developer notes or bundled into the frontend.

## Remaining issues and next gates

| Priority | Issue | Required next action |
| --- | --- | --- |
| High | Recovery material is still on the same host | Approve a private off-device destination and separate recovery-key custody; then perform an isolated retrieval/restore drill |
| High | Multi-user authentication, brokerage isolation and redistribution rights are not certified | Keep restricted research scope; complete an independent security/rights release gate before enabling other people's accounts |
| High | Historical known-at, release vintages and revision completeness remain unknown | Instrument additional sources prospectively; do not invent missing historical receipt/revision times |
| Medium | Crypto and optional AI-selection history are not migrated | Add bounded contracts and replay tests as separate packages; do not promote crypto ENTER |
| Medium | Existing enlarged-text app-shell clipping | Repair fixed header/navigation behavior at 200% text sizing |
| Medium | Manual backup retention and possible crash-left plaintext staging | Establish owner retention, cleanup and key-loss procedures; no secure erasure is promised |
| Medium | Existing type errors, 2026-only calendar and partial source availability | Triage separately with explicit exit tests rather than weakening current gates |

The live and restored databases remain plaintext inside owner-only directories. Backups use temporary private plaintext staging; routine completion/failures clean it, but a crash can leave it behind. Same-host encryption is not protection against an attacker controlling that host, off-device disaster recovery, a schedule, tenant isolation or NIST certification.

No new paid source, X reconnect, recurring agent job, automatic AI request, public publishing or native iOS work was added. iOS remains paused; SPY forecasts, crypto ENTER and executable trade recommendations remain disabled. Continue from the saved checkpoint and narrow issue register, not another broad audit or model council.
