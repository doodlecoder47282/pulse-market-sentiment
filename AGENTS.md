# Batcave: resume here

User default: conserve Computer credits without skipping necessary correctness or security checks.

## Start

1. Read this file and `docs/BATCAVE_STATE.md`. Do not reread the entire chat.
2. Run `git status --short` and inspect the latest relevant commit. Check the remote head before changing shared code.
3. Follow the newest user request. Verify only the facts needed for that request; a checkpoint is not proof of live health.
4. Search specific symbols and read bounded file ranges. Load older discussions only to resolve a concrete missing decision.

## Work within bounds

- One small, reviewable objective at a time. No full audit, rewrite, model council, background AI loop, or subagent by default.
- Use deterministic scripts for polling, calculations, source health, and data validation. Do not ask an LLM to supervise every normal poll.
- Reuse verified work and cached evidence. Recheck time-sensitive claims when they affect today's decision.
- Stop repeated attempts after two failures of the same approach. Diagnose once, then report a blocker or propose a different approach.
- Run focused tests first. Build once per meaningful code milestone; repeat only after a relevant change or failure.
- Documentation-only changes do not require a build, server restart, or app deployment.
- Ask before expanding scope, incurring a new paid service, enabling recurring AI work, publishing, or destructive history changes.
- No exact credit promises: these are work limits, not a billing meter or enforceable credit cap.

## Preserve the product

- Name: Batcave. No emojis. Be concise, explain the verdict, risk, and next action.
- Preserve tabs: Signals, Chart, Models, Heatseeker, Trade Desk, Regime, Cosmos, News, Take Five, Edge Lab, Crypto.
- Equities: Schwab primary, explicitly delayed CBOE fallback; no Yahoo.
- Crypto: public keyless data unless the user separately approves a keyed service.
- Missing, stale, blocked, partial, and observed-zero data are different states. Never label failed collection as zero activity or healthy coverage.
- Scores are heuristics, not calibrated probabilities. Fifty graded observations alone do not prove tradable edge.
- Never embed brokerage secrets in browser or iOS code. Never request that the user paste keys into chat; use a secure credential workflow.
- Do not stage runtime database files, WAL/SHM files, token files, logs, or unrelated work. Stage explicit paths and inspect the staged diff.
- Verify repository visibility; do not assume it is private. A clean working tree does not mean history contains no secrets.
- Before mobile distribution or additional brokerage users, read `SECURITY.md`.
  Shared-account architecture is not multi-user-safe; never claim full security or NIST conformance from a successful build.

## Stop and save

Update `docs/BATCAVE_STATE.md` with: completed objective, evidence, tests, blockers, known risks, and exactly one next step.
Commit the scoped change and push only within the user's existing backup authorization.
Report what changed, what was actually verified, and what remains unverified. Stop when the objective is complete.

## Resume prompt

“Read AGENTS.md and docs/BATCAVE_STATE.md, compare the current repo state,
and continue only the next approved objective. Conserve credits; do not repeat
the full audit or start background AI monitoring.”
