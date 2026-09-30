# Batcave crypto reliability repair

Status: implemented and running in this workspace on 2026-09-29.
Runtime marker: `2026-09-29.1`. iOS work remains paused; no native project or
iOS build changes were made in this repair.

## What changed

- **Discovery:** Validate pool response shape and expose separate new-pool and
  trending-feed attempt/success/error metadata. Partial discovery reports degraded,
  not fully healthy. Both endpoints returned valid responses during verification.
- **Scheduling:** Each engine now rejects overlapping runs and counts skipped
  overlaps. Successful recovery updates health immediately; reads calculate
  current status rather than waiting for a watchdog repaint.
- **Freshness:** Candidates with missing or over-five-minute market observations
  fail closed to PASS, including when the UI reads an older cached candidate.
- **Grading fairness:** Oldest unchecked/least-recently checked records come first.
  Failed requests advance in the queue too. Batches are capped at 60 signals
  and four concurrent observations.
- **Observation integrity:** Provider pair identity is validated. Observed zero
  liquidity is no longer converted to missing. Missing market cap is not replaced
  with FDV for outcome comparisons. Stored peak timestamps are preserved.
- **Expired windows:** Missing closing coverage becomes UNOBSERVABLE, excluded
  from graded success/failure counts. A new price fetched after the 72-hour window
  cannot retroactively establish its outcome.
- **UI:** Explicit health text, an unobserved count, and tracking-only language.
  Graded counts exclude unknown outcomes. Mobile layout wraps the extra labels.
- **Earlier fixes activated:** The running service now includes full-table counts
  and honest social pending/partial/unavailable/stale handling from the prior review.

## Evidence after restart

The first repaired grading batch selected 60 records, observed one active record,
and closed 59 expired coverage gaps as UNOBSERVABLE. This does not represent 59
new losses or erase known wins; it identifies history that cannot support a
win/loss judgment from the available observations.

The verification snapshot showed 102 total signals: 16 OPEN, 59 UNOBSERVABLE,
20 RUGGED, 5 DEAD, 1 DOUBLED, and 1 HIT_5M. Graded outcomes remain 27 and
`calibrated` remains false. Counts can change as discovery and grading continue.

Scanner, momentum, narratives, grader, and security routines reported healthy
at the check; social correctly reported degraded/partial coverage.
An engine heartbeat indicates routine completion, not proof that every candidate
has complete source coverage or that a trading strategy is validated.

Six new reliability test groups pass, plus six calculation/source-health groups
and three gateway groups. Whole-repo TypeScript still has the previously tracked
59 diagnostics; no new diagnostics were reported for the changed crypto files.
The production build passes. Browser QA exercised Crypto feed/signal-log switching,
health labels and unobserved totals at desktop and 375px widths without page errors
or horizontal overflow. Unrelated API calls were isolated during that UI test.

## Runtime and rollback boundary

The existing workspace terminal process was restarted with the new production
bundle, using its existing startup configuration. No new paid data source,
AI polling loop, provider account, or external notification was intentionally
created. Existing terminal schedulers remain part of that process.

Before migration, a crypto-only JSON snapshot of all 101 then-existing signals
was saved locally at `backups/crypto-before-reliability-2026-09-29.json`.
It contains no brokerage tables and is excluded from Git.
New grade metadata columns are additive. A rollback should stop writers and
review the snapshot rather than overwrite a running database or discard new rows.

## Remaining limits

- This sandbox is not verified always-on infrastructure. Suspension interrupts
  observations; a heartbeat after resume cannot reconstruct that missing interval.
- Social sampling, holder-identity heuristics, on-chain coverage, and execution
  assumptions still need validation. No stakeable edge or security certification.
- The scheduler remains a bounded ten-minute grader, not continuous tick capture.
  Sampled peaks can miss moves between observations.
- The memory candidate list repopulates after restart; the audit database persists.
- Other production deployments are not automatically updated by this workspace restart.
- Schwab status currently reports disconnected/reauthentication required.
  That is a separate stock/macro data blocker, not a key requirement for crypto.

Resume only the next approved objective; do not repeat the full audit.
