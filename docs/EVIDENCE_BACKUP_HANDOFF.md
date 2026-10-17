# Evidence ledger: bounded local encrypted recovery

## Scope and ownership

This workstream adds only `server/evidenceBackup.ts`, `scripts/evidence-backup.ts`, `tests/evidence-backup.test.ts`, and this handoff; it does not modify the existing ledger, receipt route, runtime bootstrap, data, live-cache behavior, or provider/AI paths. ([Recovery module](../server/evidenceBackup.ts), [CLI](../scripts/evidence-backup.ts))

Parent integration owns the `evidence:backup` package script, gitignore entries for `data/evidence-recovery/` and `data/evidence-recovery-keys/`, aggregate release/checkpoint notes, and any separately authorized real-ledger drill. This agent ran fixture-only tests in fresh private temporary directories, not against the running ledger. ([Fixture tests](../tests/evidence-backup.test.ts))

## Implemented behavior

- **One explicit command at a time:** initialize a recovery key, create an encrypted local copy, or restore to a new directory. No HTTP endpoints, provider/model calls, network transfers, schedules, automatic pruning, export/share operation, production switch, or server restart is included. No implicit default paths or environment-based key lookup exist. ([CLI](../scripts/evidence-backup.ts), [module](../server/evidenceBackup.ts))
- **SQLite-consistent source capture:** open the source read-only, then use `better-sqlite3`'s SQLite online backup API. Never copy the active database file as a backup. The staged snapshot alone is converted to DELETE journal mode so it is self-contained; the source writer-session metadata is not advanced, and the source is not checkpointed or opened through the ledger writer. Committed WAL contents are included while uncommitted changes are excluded. ([Implementation](../server/evidenceBackup.ts), [WAL/source-unchanged tests](../tests/evidence-backup.test.ts))
- **Two distinct keys:** `receipt.key` is the existing ledger's 64-character ASCII-hex signing secret; it is preserved inside the encrypted package. The recovery key is a separate, newly generated 32-byte random binary file, created only by explicit `init-key`, never overwritten, never included in the package, and never accepted as bytes in argv/environment variables. No key bytes or receipt tokens are printed. ([Key handling and CLI](../server/evidenceBackup.ts), [privacy tests](../tests/evidence-backup.test.ts))
- **Authenticated, bounded format:** version 1 uses AES-256-GCM with a fresh random 12-byte nonce, a 16-byte tag, and an authenticated fixed header. The encrypted content contains a strict versioned JSON manifest, exactly one receipt key, and exactly one SQLite image. SHA-256 hashes cover the database and receipt key; a separate HMAC pairing proof binds the captured receipt key to the database hash. Manifest fields cannot specify extraction paths. There is no archive decompression. ([Format implementation](../server/evidenceBackup.ts))
- **Fail closed:** missing/wrong keys, unsafe paths, existing output names, tamper, unsupported versions/schema objects, oversized inputs, malformed SQLite, and payload/identity/hash failures do not promote a restored directory. All routine failures clean the tool's staging directories. CLI errors are fixed codes, never raw filesystem/SQLite/parser errors or argument echoes. ([Implementation](../server/evidenceBackup.ts), [failure tests](../tests/evidence-backup.test.ts))
- **Verify before promotion:** run SQLite `integrity_check`, require the current exact v1 table/index schema, validate metadata, and run the existing archive decoder/checksum/indexed-identity checks plus receipt-scoped read on **every physical record**, including expired rows and rows beyond the 20-item local listing. Verify manifest counts, hashes, replay counts, and receipt-key pairing before promotion. Replay remains historical; calculation mismatches and unsupported calculation versions are reported distinctly, not repaired or presented as matched. ([Verification](../server/evidenceBackup.ts), [existing decoder](../server/evidenceLedger.ts))
- **No overwrite:** backup publication uses an exclusive hardlink of the complete encrypted file. Restore first requires a nonexistent target, validates in a sibling private staging directory, exclusively reserves the previously absent target with `mkdir`, then renames the verified staging directory over only that newly created empty reservation. Existing files, empty directories, dangling symlinks, and destinations appearing during validation are rejected. No current ledger path is switched. ([Promotion implementation](../server/evidenceBackup.ts), [no-overwrite tests](../tests/evidence-backup.test.ts))

## Limits and path rules

| Item | Bound |
| --- | --- |
| Encrypted package | 65 MiB, checked before reading/allocating |
| SQLite image | 64 MiB, checked on source, online-backup progress and restored image |
| Manifest | 16 KiB |
| Records | 500 physical rows |
| Payloads | 48 MiB total; 384 KiB per row |
| SQLite online backup | 15-second elapsed budget checked during progress and after completion; 256-page steps; 1.5-second SQLite busy timeout |
| Format/schema | Backup version 1; `evidence-ledger-v1`; SQLite `user_version = 1`, exact known tables/index |

These are per-operation/package bounds, not a total quota across multiple manually created backup files; there is no automatic retention job. The SQLite transfer budget is not a hard deadline for the entire filesystem/verification operation. ([Constants, progress callback and validation](../server/evidenceBackup.ts))

All CLI paths must be absolute, normalized paths, without `..`, `.` components, trailing slash or symlink components. Existing source/key/package directories and output parents must be owned by the current UID and mode `0700`; files must be regular, single-hardlink, current-UID-owned, mode `0600`. Every ancestor is checked for symlinks and untrusted writability; root-owned sticky ancestors such as `/tmp` are allowed above private directories. Recovery keys and backup packages cannot be inside the source/restored ledger directory. Missing parent directories are not created implicitly. This implementation is POSIX-only and fails closed without UID/no-follow support. ([Filesystem checks](../server/evidenceBackup.ts))

## Exact owner commands

Run from the repository root with existing installed dependencies; do not put secrets in a command line or paste them into a terminal/chat. The examples below are **operator commands, not commands this agent ran against runtime data**. Pick new output names for every copy/drill and keep both private storage directories outside the deployed frontend bundle. ([CLI contract](../scripts/evidence-backup.ts))

```bash
# Parent must first verify these directories are gitignored.
# Explicit creation of private local directories, not a scheduler.
umask 077
ROOT="$(pwd -P)"
install -d -m 700 "$ROOT/data/evidence-recovery" "$ROOT/data/evidence-recovery-keys"

# One-time initialization. Refuses an existing file; never prints the key.
./node_modules/.bin/tsx scripts/evidence-backup.ts init-key \
  --key-file "$ROOT/data/evidence-recovery-keys/recovery.key"

# Approved source directory only. Reads source through SQLite's online-backup API.
./node_modules/.bin/tsx scripts/evidence-backup.ts backup \
  --ledger-dir "$ROOT/data/evidence-ledger" \
  --key-file "$ROOT/data/evidence-recovery-keys/recovery.key" \
  --backup-file "$ROOT/data/evidence-recovery/owner-drill-001.enc"

# Target MUST NOT EXIST. No promotion into the production ledger configuration.
./node_modules/.bin/tsx scripts/evidence-backup.ts restore \
  --backup-file "$ROOT/data/evidence-recovery/owner-drill-001.enc" \
  --key-file "$ROOT/data/evidence-recovery-keys/recovery.key" \
  --restore-dir "$ROOT/data/evidence-recovery/restored-drill-001"
```

After parent script integration, `npm run evidence:backup --` can replace `./node_modules/.bin/tsx scripts/evidence-backup.ts` for the same subcommands/flags. Success returns only a small JSON status with record/payload/database counts and replay status counts; no snapshots, paths, record IDs, hashes, key bytes, or receipt tokens are returned. Failure sets exit status 1 and prints a safe error code. ([CLI](../scripts/evidence-backup.ts), [status type](../server/evidenceBackup.ts))

Typical codes: `path_exists` (choose a genuinely new output), `unsafe_path` (verify ownership, permissions and all path components), `key_unavailable`/`invalid_key` (provide the existing correct local key file; do not rotate), `authentication_failed` (wrong key or package damage), `unsupported_format`/`unsupported_schema`, `integrity_failed`, `size_limit`, `backup_timeout`, or generic `local_operation_failed`. Do not bypass validation to force a restore. A failed command may still leave a fully published result if a subsequent parent-directory fsync fails; never blindly retry over that name. ([Error and publication handling](../server/evidenceBackup.ts))

## Verification completed

```bash
# Fixture tests + existing ledger regression; no live data needed.
node --import tsx --test tests/evidence-backup.test.ts tests/evidence-ledger.test.ts

# Focused strict type check of the new module/CLI and their imported contracts.
./node_modules/.bin/tsc --noEmit --incremental false --target ES2022 \
  --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck \
  --strict --allowImportingTsExtensions --types node \
  server/evidenceBackup.ts scripts/evidence-backup.ts
```

Result before acquisition integration: the initial **40/40 tests passed**, and the parent independently reran **41/41 passing** after the added key-replacement regression (22 recovery checks, 19 existing ledger checks); the focused module/CLI type check passed. Recovery tests block `fetch`, TCP socket connect, HTTP(S) request and datagram creation; CLI and separate-process receipt replay run under the same blockers. These are code-path blockers, not an OS network namespace/firewall. ([Recovery tests](../tests/evidence-backup.test.ts), [ledger regression](../tests/evidence-ledger.test.ts))

A further project-configured TypeScript compiler-API check including `tests/evidence-backup.test.ts` reported zero owned-file or dependency diagnostics; the saved result is `/home/user/workspace/evidence-backup-owned-types-20261002.log`. The explicit regression for preexisting receipt-key replacement also passed independently in `/home/user/workspace/evidence-backup-key-boundary-20261002.log`, and is included in the parent's 41-test rerun. ([Recovery fixture and key-continuity limitation](../tests/evidence-backup.test.ts))

The recovery suite covers: exact pre-backup receipt survival and exact original snapshot/checksum/replay in a separate process; unchanged source bytes/key; WAL committed/uncommitted consistency; empty ledger; 23 physical rows including retention-hidden rows; wrong/missing/malformed keys; encrypted-body/header/tag/nonce/version/truncation/append tamper; resealed invalid manifests and key pairing; unsupported SQLite versions/objects; invalid payload/index metadata; truncated SQLite pages; row/byte/progress limits; oversize sparse files; existing/racing destinations; unsafe permissions/symlinks/hardlinks; nested key/output rejection; CLI safe output; and routine partial-staging cleanup. ([Tests](../tests/evidence-backup.test.ts))

Saved execution logs outside the repo: `/home/user/workspace/evidence-backup-ledger-tests-20261002.log` and `/home/user/workspace/evidence-backup-typecheck-final-20261002.log`. No build, restart, deployment, commit, paid call, real-ledger capture, or live restore was performed by this workstream. ([Test commands and fixtures](../tests/evidence-backup.test.ts))

### Parent-reported isolated local drill

The parent reported a successful actual local CLI `init-key` → `backup` → `restore` drill: **2 records, 46,129 payload bytes, 73,728 database bytes, 2 matched replays and 0 mismatches**. The restored directory was isolated; the source was unchanged and no app restart or production switch occurred. These runtime results are the parent's report, not a separate live-data operation by this recovery agent.

Crucially, the parent retained an **original browser receipt from before backup** and used it in a separate Node process with `fetch` blocked to read the restored ledger. The entire historical response deep-equaled the source response, with `actionable: false` and `point_in_time_safe: false`; no keys or tokens were printed. This independently retained receipt verifies continuity for that checked record, without claiming a preexisting v1 key commitment or continuity for unknown receipts.

## Honest security and recovery boundary

1. **This is a same-host encrypted recovery copy, not off-device/disaster recovery.** Disk/workspace loss can destroy the source, packages and recovery key together. There is no off-host custody, upload, export, escrow, schedule, rotation or tested disaster-recovery service here. Losing the recovery key makes these packages unrecoverable. ([Local-only implementation](../server/evidenceBackup.ts))
2. **The live and restored ledgers remain plaintext.** Backup and restore temporarily use private `0700` plaintext staging directories with `0600` database/key files; they are removed on normal success/caught failure. Process kill, crash, filesystem failure or power loss can leave private staging or the tool's empty reservation behind. No automatic restart cleanup or secure deletion is claimed; inspect locally without publishing contents. Memory/file deletion is not guaranteed secure erasure, and filesystem snapshots/page cache/swap are outside this tool's controls. ([Staging and cleanup](../server/evidenceBackup.ts))
3. **The filesystem owner/root is trusted.** Permissions, no-follow opens, ancestor checks and exclusive outputs defend against accidental unsafe placement and other users, not a hostile process with the same UID/root able to replace paths between checks, inspect memory, read keys or rewrite content. A same-host key and ciphertext do not protect against host compromise; the mode checks are not multi-user authorization or NIST certification. ([Path and crypto implementation](../server/evidenceBackup.ts))
4. **Pairing is captured-bundle consistency, not retroactive source-key authenticity.** The preexisting ledger stores no independent commitment to its receipt key. This tool captures the adjacent key, checks it has not changed during backup, binds that key/database pair inside authenticated ciphertext, and verifies it again at restore. It cannot detect a key that was already replaced before backup or prove an unknown user's old receipt still works without that receipt. The fixture test separately proves that a known original receipt survives genuine backup/restore, without printing it. ([Existing ledger signing](../server/evidenceLedger.ts), [pairing checks](../server/evidenceBackup.ts), [receipt-survival test](../tests/evidence-backup.test.ts))
5. **No historical truth or live eligibility is created.** Integrity confirms saved bytes and schema/identity consistency, not provider truth or resistance to an owner who controls both keys. Acquisition/version labels are preserved, not upgraded. Backup includes expired-but-not-yet-pruned physical rows; ordinary restored reads still enforce the original 30-day age limit using the actual clock. Copies can retain sensitive bytes after source pruning, so their separate operator retention policy is still needed. Numerical mismatch/unsupported results remain visible in status counts. No record reenters the live AI cache, trading, forecast or signal path. ([Verification](../server/evidenceBackup.ts), [unchanged historical/retention decoder](../server/evidenceLedger.ts))

## Final scoped cross-review and integration gate

**Final independent acquisition cross-review: no unresolved blocking finding within this package's documented scope.** Reviewed the settled transport, completed-read cache, acquisition contract, optional live/archive schema, evidence projection, mutation fixtures and timing-disclosure wording; independently ran acquisition **24/24 passing**. Log: `/home/user/workspace/evidence-acquisition-recovery-peer-final-20261002.log`. The acquisition peer independently reran recovery plus ledger **42/42 passing** after the annotation fixture was added. Parent owns aggregate build/runtime/browser verification, type-baseline comparison and release integration; no production-ledger switch is part of this package. ([Reviewed acquisition tests](../tests/evidence-acquisition.test.ts), [recovery fixtures](../tests/evidence-backup.test.ts), [peer verification](EVIDENCE_ACQUISITION_HANDOFF.md))

### Acquisition cross-review issue register — resolved

- **ACQ-1 / closed after fix and independent test run:** the transport fingerprints the originally parsed payload, compares that fingerprint before retaining its original receipt, and gives metadata-enabled readers an isolated value copy. Nested mutation by raw legacy callers makes later ordinary/stale-fallback receipts null rather than restamping them; existing non-opt-in reference semantics remain. The brief service copies metadata at callback arrival and clones tracked payloads before its completed-read cache takes ownership. Fixtures prove later nested dependency mutation cannot refresh observations, rewrite prior snapshots or promote an expired quote, including originally stale-fallback provenance. These fingerprints are process-local parsed-value checks, not raw wire signatures or authentication against a dishonest trusted producer. ([Transport fix](../server/schwab.ts), [service fix](../server/tradeBrief.ts), [independently rerun mutation fixtures](../tests/evidence-acquisition.test.ts))
- **UI-1 / parent ACQ-2 / closed and verified:** `cache_hit` initially rendered as “Provider cache,” but the instrumented branch is this app's local Schwab-adapter cache, not proof of an upstream provider-owned cache. The final component uses “Local source cache”; the same map supplies the retained-adapter label. Other reviewed timing copy correctly separates snapshot assembly, original app receipt, application read, stale fallback and unknown first-seen/known-at, without a fresh-data or point-in-time claim. Review was static wording/behavior review, not a new browser certification. ([Timing disclosure](../client/src/components/EvidenceTiming.tsx), [actual cache location](../server/schwab.ts))
- **Compatibility checks complete:** optional metadata is context-validated only on the selected Schwab source rows, not inherited by calculated/mixed-source rows; original observation/expiry gates remain ahead of annotation; historical decoding checks acquisition against the original capture time; unknown old snapshots remain undecorated. The independently passing 24 acquisition tests cover actual-module transport branches, old schemas/hashes, optional annotated snapshots, cache provenance and non-promotion. ([Builder](../server/tradeBrief.ts), [schemas](../shared/tradeBrief.ts), [projection](../shared/tradeBriefEvidence.ts), [tests](../tests/evidence-acquisition.test.ts))
- **Annotated recovery integration fixture passed:** a saved snapshot containing both direct transport-response and brief-service-cache acquisition metadata roundtripped with the original receipt and exact historical response intact. Stored snapshot metadata was unchanged, the projected original receipt survived, first-seen/known-at stayed null, and unannotated/calculated rows did not acquire receipt times. Named-test log: `/home/user/workspace/evidence-backup-annotated-roundtrip-20261002.log`; the final peer recovery/ledger run includes all 23 recovery tests plus 19 ledger regressions. ([Annotated recovery fixture](../tests/evidence-backup.test.ts), [peer final rerun](EVIDENCE_ACQUISITION_HANDOFF.md))
