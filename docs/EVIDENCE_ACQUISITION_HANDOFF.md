# Evidence acquisition handoff

## Final status — optional acquisition adopted; code/schema stable

**Schema stable for peer backup fixture and parent UI:** no further field changes planned. Mutation guard ACQ-1 is addressed in both transport and completed-read cache: local transport fingerprints the parsed response with SHA-256 over Node V8 serialization; metadata-enabled reads compare that original fingerprint and return an isolated parsed-value copy. Mutated or legacy entries retain null receipts; legacy unobserved raw callers keep original reference semantics. Metadata callback values are frozen, and the brief service clones callback metadata immediately and clones tracked source payloads before its completed-read cache takes ownership. Nested-mutation tests cover transport hits, stale fallback, and brief read-cache reuse. ([Transport](../server/schwab.ts), [service](../server/tradeBrief.ts), [tests](../tests/evidence-acquisition.test.ts))

The parent expanded scope to permit narrow Schwab transport instrumentation. That is now implemented: the actual Schwab module is tested in an isolated VM with allowlisted stub storage/token/environment/fetch/timer dependencies, not imported against production storage. Transport success, ordinary cache, cooldown, self-throttle, 403/429/5xx/other errors, exceptions, JSON parse failure, absent authentication, legacy caches, skip-cache, minute-history keys and observer failures are exercised without real credentials or network. ([Transport changes](../server/schwab.ts), [actual-module VM tests](../tests/evidence-acquisition.test.ts))

**Parent/UI contract:** `brief.evidence[i].acquisition` is optional, strict, and absent from old snapshots. Its fields are `schema_version: "evidence-acquisition-v1"`, `read_provenance`, `received_at: string | null`, and `read_at`. `read_provenance` is `transport_response`, `cache_hit`, `stale_cache_fallback`, `unverified_adapter_return`, or `brief_read_cache`. The last variant additionally requires `adapter_read_at` and `adapter_read_provenance` preserving the original adapter path/time. Existing `brief.created_at` remains snapshot assembly; there is no new top-level capture field, no acquisition on derived/context evidence, and no first-seen/known-at field added. ([Schema](../shared/evidenceAcquisition.ts), [optional brief schema](../shared/tradeBrief.ts))

If displaying anything, label `received_at` as **app provider-response receipt**, not provider observation/publication. Label `read_at` as **app adapter/cache read**, preserving the separate cache-path label. On `brief_read_cache`, retain/display the original adapter path separately if needed. Null/absent remains unknown; metadata absence is not proof of network or cache. Existing source `observed_at` and expiry are unchanged. ([Validation/projection](../shared/tradeBriefEvidence.ts), [service boundary](../server/tradeBrief.ts))

**Final verification: acquisition 24/24; full `npm run test:evidence-foundation` 121/121 passed.** The project-configured compiler API found zero diagnostics in all six owned code/test files; full-project `tsc --noEmit --incremental false` still reports 59 preexisting diagnostics, none in owned files. Whitespace/diff checks passed. Edited production files: `server/schwab.ts`, `server/tradeBrief.ts`, `shared/tradeBrief.ts`, `shared/tradeBriefEvidence.ts`; the original hash algorithms, calculation/policy versions, numerical gates, retry/TTL/fallback behavior and ledger implementation are untouched. The new acquisition contract has its own version. ([Implementation](../server/tradeBrief.ts), [tests](../tests/evidence-acquisition.test.ts))

## Independent recovery cross-review — final scoped signoff

Read `server/evidenceBackup.ts`, `scripts/evidence-backup.ts`, and all of `tests/evidence-backup.test.ts`; independently reran recovery plus ledger after annotated recovery was added: **42/42 passed**, followed by the integrated 121-test foundation run. Reviewed the new annotation roundtrip, key-replacement limitation, page truncation, payload/row growth limits and destination-race fixtures as well as the initial 17 recovery tests. WAL consistency, original receipt preservation, retention, bounded authenticated input, wrong-key/tamper rejection, private permissions, no-overwrite and CLI redaction are covered. ([Recovery implementation](../server/evidenceBackup.ts), [CLI](../scripts/evidence-backup.ts), [peer tests](../tests/evidence-backup.test.ts))

**Concrete limitation requiring disclosure/test, not a broad ledger rewrite:** the current `pairing_proof` authenticates the key/database pair selected *at backup time*, not the historically original receipt key. `verifyDirectory` generates a receipt using the supplied key and asks a ledger opened with that same key to verify it, so that check is self-consistent even if the source key was mistakenly replaced **before** backup. In an independent isolated fixture, replacing `receipt.key` with a different valid-format random test key before backup yielded `backup_created` and `restored_to_new_directory`, but the original retained receipt was rejected; the historical row remained present. The source-key comparison only detects a change during the backup window. No real ledger was accessed or modified. ([Verification/token generation](../server/evidenceBackup.ts#L207-L220), [source-key check](../server/evidenceBackup.ts#L255-L276), [ledger receipt validation](../server/evidenceLedger.ts#L184-L189))

**Resolved as an explicit boundary:** the peer added a preexisting-key-replacement fixture and disclosure. Operators still need an independently retained original receipt for a post-restore continuity check before claiming old receipt access survives. A trusted key commitment would require a separate versioned ledger change, not retroactive invention. This does not weaken authenticated package integrity; it bounds what “pairing” establishes. ([Peer limitation and fixture](EVIDENCE_BACKUP_HANDOFF.md), [roundtrip tests](../tests/evidence-backup.test.ts))

A second operational limitation—process termination/power loss can leave owner-only plaintext staging—has also been explicitly acknowledged in the peer handoff. Tests establish routine success/exception cleanup, not encrypted staging, secure erasure or crash-proof cleanup. ([Peer recovery boundary](EVIDENCE_BACKUP_HANDOFF.md), [staging/finally](../server/evidenceBackup.ts))

Scoped signoff: **no unresolved blocking defect identified for the documented local-owner recovery boundary with an intact source key**; annotated snapshots retain receipt/read/observation/capture fields and historical-only behavior. No peer files edited. This is not an external security certification, disaster-recovery approval or proof of market-data truth. ([Peer annotated recovery test](../tests/evidence-backup.test.ts), [recovery boundary](EVIDENCE_BACKUP_HANDOFF.md))

## Exact acquisition behavior

- `shared/evidenceAcquisition.ts`: pure Zod contract and context validation; no I/O, implicit wall clock, provider imports, or automatic data stamping. ([Implementation](../shared/evidenceAcquisition.ts))
- `tests/evidence-acquisition.test.ts`: synthetic transport/observation fixtures and existing pure-builder/injected-service compatibility checks; no actual provider/model calls. ([Tests](../tests/evidence-acquisition.test.ts))

`EvidenceAcquisitionSchema` is strict and versioned `evidence-acquisition-v1`; common fields are `schema_version`, `read_provenance`, `received_at`, and `read_at`, with the two retained adapter fields required only for `brief_read_cache`. Local timestamps are canonical UTC millisecond strings. Unknown properties—including first-seen/known-at claims, tokens and cache expiry—are rejected, not used as substitutes. ([Implementation](../shared/evidenceAcquisition.ts))

| `read_provenance` | Meaning | `received_at` |
| --- | --- | --- |
| `transport_response` | Instrumented successful provider response-body receipt | Required original measured timestamp |
| `cache_hit` | Confirmed local transport-cache read | Original measured receipt only if the parsed-payload fingerprint matches; otherwise null |
| `stale_cache_fallback` | Confirmed stale/error fallback | Original measured receipt only if the parsed-payload fingerprint matches; otherwise null |
| `unverified_adapter_return` | Legacy helper returned, but delivery path is hidden | Must be null |
| `brief_read_cache` | Brief service reused its completed-read cache | Retained original receipt or null; original adapter path/time also retained |

Receipt is measured only after successful provider body parsing, never from HTTP Date, source `tradeTime`, expiry, helper completion, or later cache access. The transport stores that receipt and an ephemeral parsed-value fingerprint alongside the cache entry. The fingerprint is process-local protection against mutable legacy references, not the persistent ledger hash or a wire-byte signature. Opt-in metadata readers receive isolated values; non-opt-in callers keep bare raw return/reference behavior. No additional request, refresh, retry or polling is introduced. ([Schwab transport](../server/schwab.ts))

Stock quote/history/options dependencies alone opt in. Legacy injected adapters can honestly record their completion as `unverified_adapter_return` with null receipt. A completed-read cache hit gets a new app read time and `brief_read_cache` path while retaining original adapter time/path and original receipt. The service owns a cloned payload; later mutation by a dependency cannot rewrite that cache. Clone/validation failures produce no acquisition claim, not substitute data or new timestamps. Pending concurrent reads still share existing work, and immutable snapshot hits return the original snapshot unchanged. ([Brief service](../server/tradeBrief.ts), [mutation/cache tests](../tests/evidence-acquisition.test.ts))

These meanings are a trusted producer contract, **not external proof of provider truth**: the shared validator cannot detect a fabricated callback from a dishonest injected dependency. The actual default transport is separately instrumented/tested at its response/cache branches. ([Contract](../shared/evidenceAcquisition.ts), [actual-module fixtures](../tests/evidence-acquisition.test.ts))

`reviewEvidenceAcquisition(raw, context)` receives original `observed_at`, `time_precision`, snapshot `captured_at`, and explicit numeric `now`. It returns `accepted`, `absent`, or `rejected`, null-safe timing/provenance fields and fixed issue codes. Undefined alone is absent. Receipt must precede/equal original adapter read, then service read, then snapshot capture; future timestamps and observations later than receipt/read/capture are rejected. Date/period observations compare days only, not fabricated release instants. Rejected annotations never supply receipt/read fields. A parseable capture can remain visible with rejected status; callers must check status. Validation is per datum: a receipt too early for a newer quote can still be valid for older historical inputs. ([Implementation](../shared/evidenceAcquisition.ts), [per-datum tests](../tests/evidence-acquisition.test.ts))

`accepted` means internal contract/clock consistency, not accurate data, source health, verified rights, tradability, contemporaneous historical availability, vintage coverage, or point-in-time completeness. The helper never decides freshness or changes a brief's verdict, expiry, levels, risk, model status, or policy eligibility. ([Implementation](../shared/evidenceAcquisition.ts), [non-promotion tests](../tests/evidence-acquisition.test.ts))

## Compatibility, hashes and remaining boundaries

Only direct Schwab quote/history/options evidence may carry accepted acquisition; calculated, mixed-source and context evidence does not inherit a receipt. The policy envelope keeps its existing shape: validated optional acquisition supplies `received_at`, while `captured_at` stays `brief.created_at` and first-seen/known-at remain null. Invalid annotations are omitted by the builder and rejected if injected into either strict live/archive snapshot decoder. Original observation fields and all freshness/eligibility/numerical gates remain unchanged. ([Builder](../server/tradeBrief.ts), [schemas](../shared/tradeBrief.ts), [projection](../shared/tradeBriefEvidence.ts))

Old snapshots decode without annotations or backfilled times, preserving old calendar/policy version labels and original IDs. New snapshot metadata enters the existing deterministic hash and ledger checksum naturally; changing valid acquisition changes the new snapshot ID without changing prices, expiry, verdict, levels or policy results. No hash algorithm is changed, cached snapshots are never mutated, and annotated backup/replay stays historical-only rather than repopulating live AI caches. ([Compatibility/hash tests](../tests/evidence-acquisition.test.ts), [annotated recovery test](../tests/evidence-backup.test.ts))

Unknown legacy/mutated-cache receipt remains null. Actual receipts establish this app's response-body acquisition, not earliest availability, market freshness, publication/release vintage, corrections, uninterrupted collection, legal rights or point-in-time completeness. No forecasting, probability, executable recommendation, or model-call gate is promoted. Source clocks are not reconciled; conflicting/future timestamps lose the annotation rather than gain a fabricated replacement. ([Contract and validation](../shared/evidenceAcquisition.ts), [non-promotion tests](../tests/evidence-acquisition.test.ts))

`stale_cache_fallback` names the local transport path, not a new market-data status. A local TTL hit likewise does not prove a fresh market observation. `skipCache` still cannot bypass cooldown/throttle/error fallback. No live provider availability/entitlement was exercised or certified by these fixture tests. ([Transport](../server/schwab.ts), [unchanged observation gates](../server/tradeBrief.ts))

## Reproducible checks and safe logs

```bash
./node_modules/.bin/tsx --test tests/evidence-acquisition.test.ts
./node_modules/.bin/tsx --test tests/evidence-backup.test.ts tests/evidence-ledger.test.ts
npm run test:evidence-foundation
./node_modules/.bin/tsc --noEmit --incremental false --pretty false
```

Results are 24/24, 42/42 and 121/121 tests respectively; full-project type output retains the 59-diagnostic baseline, with zero owned-file diagnostics including the acquisition test under the project-configured compiler API. Tests exercise actual transport control flow in a sealed VM, not copied function logic or text-matching assertions. ([Owned tests](../tests/evidence-acquisition.test.ts), [peer tests](../tests/evidence-backup.test.ts))

Safe logs saved outside the repository (no keys, receipt tokens, raw provider data, or ledger payloads):

- `/home/user/workspace/evidence-acquisition-final-results.tap`
- `/home/user/workspace/evidence-acquisition-foundation-final.tap`
- `/home/user/workspace/evidence-acquisition-owned-types.log`
- `/home/user/workspace/evidence-acquisition-project-types-final.log`
- `/home/user/workspace/evidence-backup-crossreview-final.tap`
- `/home/user/workspace/evidence-backup-crossreview-pairing.json`

## Ownership / exclusions

Owned additions: `shared/evidenceAcquisition.ts`, `tests/evidence-acquisition.test.ts`, and this requested technical handoff. Authorized edits: `shared/tradeBrief.ts`, `shared/tradeBriefEvidence.ts`, `server/tradeBrief.ts`, and (after explicit scope expansion) `server/schwab.ts`. No real credentials, provider/model calls, builds, restarts, deployment, commits, UI, routes, package edits, ledger edits, live data changes, or peer-file edits were performed. Parent owns final integration/release and any real local recovery drill.
