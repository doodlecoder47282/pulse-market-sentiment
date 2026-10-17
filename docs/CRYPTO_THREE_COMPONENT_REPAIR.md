# Batcave crypto collector repair

October 1, 2026. Scope: security, social and outcome-grading reliability.
This is not a wallet-security audit, model validation or production-readiness
certificate. iOS stays paused; X stays disabled; ENTER stays disabled.

## Verified causes

- Security: the existing parser rejected every Token-2022 mint, including
  immutable self-referenced metadata-only mints; two reads per tick limited
  coverage. Most tracked records had not been checked.
- Social: pump.fun denied the public request with HTTP 403. The old curl
  workaround hid failures and retried repeatedly. Bluesky used a 25-post
  all-time search with no lexical verification. A live bounded-hour probe
  returned 93 posts but none contained the requested exact cashtag, so they
  correctly contribute zero matched mentions under the repaired contract.
- Grading: four older exact pools were absent from the primary provider.
  Partial observations were not counted as a coverage gap; historical continuity
  was not recorded, so a recent closing observation could conceal a long gap.

## Implemented

- **Mint checks:** up to eight unique mints in one ordered RPC batch per 45 seconds.
  Two priority slots plus oldest-first capacity prevent starvation. Pool records
  sharing a mint reuse only mint-level evidence. Malformed batches fail closed.
- **Token-2022 scope:** original SPL plus a narrowly reviewed Token-2022 subset:
  unextended base mint, or complete immutable metadata-pointer/token-metadata
  pairs that self-reference the requested mint. Unknown, mutable, duplicate or
  transfer-changing extensions remain unsupported. CHECKED means the stated
  mint fields were parsed, not that a token or its exit route is safe.
- **Social sampling:** last-hour search, at most two 100-post pages, deduplicated
  posts and authors, exact cashtag filtering, and exact-mint text for unusable
  cashtags. Timestamp errors, query caps, provider gaps and zero matches differ.
  This remains a bounded sample, not exhaustive social coverage or organic-demand proof.
- **Provider denial:** removed the curl transport workaround. Public-access
  denial pauses that provider for 30 minutes; throttling and other failures have
  bounded backoff. No credentials, proxies, new accounts or access bypasses.
  Each candidate and source register expose the provider reason.
- **Grading:** exact pool and mint validation, up to four fallback reads per
  batch, same-pool GeckoTerminal fallback, no alternative-pool/FDV/zero
  substitution, per-batch deduplication, durable retry backoff and provenance.
  Partial observations remain partial; repeated sample timestamps do not
  inflate observation count.
- **Coverage:** new additive SQLite fields record first/last complete samples
  and largest observed gap. A 72-hour full-window outcome requires documented
  start, closing and intermediate sampled coverage. Old rows without that
  evidence become UNOBSERVABLE at expiry, not fabricated wins/losses. Existing
  closed historical rows are not rewritten. A directly observed threshold
  event retains its existing sampled-outcome semantics, not realized P&L.
- **UI:** collector coverage counts, concrete blockers, provider retry eligibility,
  and grading-batch partial/unavailable/deferred counts. A routine with no due
  work is idle, not falsely healthy. No all-green relabeling.

Reliability contract: `2026-10-01.1`. Mint parser:
`mint-fields-2026-10-01.1`. Research score version:
`meme-research-2026-10-01.1` (the eligibility/input contract changed; no calibrated
probability or permission to trade).

## Provider documentation used

- Ordered account batching is documented by [Solana getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts).
- Metadata self-reference and extension risks are documented in the [Token-2022 extension guide](https://www.solana-program.com/docs/token-2022/extensions).
- Bluesky search parameters and its non-exhaustive cursor semantics are defined in the [official searchPosts lexicon](https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/app/bsky/feed/searchPosts.json).
- Public endpoint access can depend on the service implementation, as noted in the [Bluesky API documentation](https://docs.bsky.app/docs/api/app-bsky-feed-search-posts).

## QA inventory

- Unit/regression: accepted/rejected extension sets, batch order/length/fairness,
  source denial/backoff, bounded pages and collisions, missing versus zero,
  exact fallback identity/budget, partial/duplicate samples, fair retries,
  historical-gap exclusion and pre-existing scoring gates.
- Live: one startup cycle for all three collectors; compare real health,
  coverage reasons and new parser evidence, without promoting unavailable data.
- Browser: mobile/desktop Crypto Data coverage and Outcomes, token expansion,
  provider-reason readability, no overflow, Intel search/startup regression.
- Same-app deployment only. No new host, paid services, forecast or native build.

## Verification

- 66 focused tests pass across collector, scoring, stock lookup, startup and SPY
  guard suites. Engine-integration tests additionally exercise real scheduler
  wrappers with isolated provider fixtures: batching, idle status, 403 denial
  and suppression of repeated pump.fun requests during cooldown.
- Full production client/server build passes. TypeScript retains 59 unrelated
  diagnostics, none in the changed files. No claim of a clean whole-repo typecheck.
- A consistent pre-migration SQLite backup is stored outside the deployed
  bundle at `/home/user/workspace/crypto-before-three-repair.db`.
- Initial live security cycle accepted six reviewed Token-2022 mints. Subsequent
  cycles increased checked coverage; mutable/unreviewed mints remain blocked.
- Live Bluesky sampling responded successfully. A real pump.fun 403 was exposed
  on one candidate, and the next candidate showed cooldown without another
  denied request. Social remains partial for affected mints.
- The exact-pool fallback recovered reserve observations for all four formerly
  missing pools. Their reported reserves met the existing liquidity-collapse
  threshold, recorded with provider, receipt time and partial-cap disclosure.
  The historical `RUGGED` enum is a sampled threshold label, not proof of fraud
  or realized trading loss. No absent value was converted to zero.
- Desktop and 390px browser checks covered the data-coverage panel, outcomes,
  token expansion and provider retry reasons. No page errors or horizontal
  overflow were observed. Screenshots were inspected.

Final build and restart completed after idle-state and range-validation
regressions passed. Implementation commit: `84bb9f6`. The existing Batcave
preview was updated in place, with no independent copy or public publication.

Deployed verification passed at 390px and 1440px in a fresh Chromium context.
The mobile test used touch input and an opaque `sandbox="allow-scripts"`
iframe, including startup acknowledgment, Intel listing search, crypto
coverage and outcomes. No page exceptions or horizontal overflow occurred.
The final runtime showed eight usable mint checks, then idle while no checks
were due; the grader recorded 17 complete current observations, zero partial,
zero unavailable and zero awaiting retry. Social correctly remained degraded
for the public-access denial. Counts are point-in-time checks, not uptime or
future completeness guarantees. Local QA receipt:
`/home/user/workspace/crypto-three-deployed-qa.json`.

Public RPC throttling, unsupported
contracts, unavailable cap fields and unofficial-provider restrictions remain
explicit; they cannot be solved by relabeling status.
