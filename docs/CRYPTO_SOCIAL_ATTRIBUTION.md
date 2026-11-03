# Batcave social-data iteration

October 1, 2026. A bounded improvement to usable evidence, not a claim that the
remaining social-market coverage gap is closed. iOS, X and SPY forecast gates
are unchanged. No new credentials, accounts, paid services or model calls.

## Changes

- **Attribution:** one exact Solana contract query plus one optional ticker
  query. Exact contract text or an exact mint segment in a recognized token
  link qualifies as a mention, not proof of the author's intent. Ticker-only
  chatter is disjoint context and is excluded from scoring.
- **Inspection:** up to three source-post receipts from each lane, with
  author-declared timestamp, match basis and a short excerpt. URI author and
  post identity must agree. No linked content, wallet or external script is
  fetched or executed. Rendered excerpts are escaped React text.
- **Activity comparison:** disjoint current/preceding ten-minute bins from
  the bounded one-hour contract sample. Ratios and deltas are withheld for
  truncated/malformed samples, fewer than three previous-window posts, fewer
  than six combined posts or fewer than three sampled authors. These are
  conservative display gates, not statistically validated signal thresholds.
- **Coverage and request economy:** four unique mints per 90-second pass;
  two priority slots plus oldest-first capacity, fresh known market data
  required, mint-level evidence reused across pools. Maximum two Bluesky
  requests per mint, 100 returned posts per query, eight-second request
  deadline and 25-second batch deadline. Backoff remains shared by provider.
  Unsampled candidates remain unknown.
- **Failure behavior:** contract-query failure never becomes zero; a failed
  ticker query retains the contract sample but exposes partial coverage.
  Cached observations older than ten minutes lose displayed counts and pace.
  A pump.fun failure still blocks complete social coverage and social score
  contribution under the existing conservative scoring gate. No reweighting.
- **UI:** social coverage summary and one-tap token inspection in Data
  coverage, plus separate contract/ticker counts, source receipts and pace
  disclosure in the expanded Meme discovery card. Post links are outside the
  card's expand/collapse button.

Contracts: `social-attribution-2026-10-01.1` and research score
`meme-research-2026-10-01.2`. Scores remain research-only, not probabilities;
ENTER remains disabled. No historical outcomes are rewritten.

## Source decisions

The [Bluesky search contract](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/searchPosts.json)
provides time filters and bounded returned posts but does not promise exhaustive
search coverage. The existing `api.bsky.app` AppView responded during the live
probe; the separately probed cached public hostname denied this environment,
so it was not substituted or used as a denial bypass. Both AppView hostnames
are described in the [official rate-limit guidance](https://docs.bsky.app/docs/advanced-guides/rate-limits).

Farcaster was considered, not integrated. The [official cast retrieval guide](https://docs.farcaster.xyz/developers/guides/querying/fetch-casts)
requires read access to a node; the [client API documentation](https://docs.farcaster.xyz/reference/farcaster/api)
offers unauthenticated channel metadata but not a documented global post search.
A public Pinata node probe returned records, but freshness and bounded ordering
were not established, so it was not promoted to a live evidence source. Running
a node or selecting an authorized indexed feed is separate work, not hidden
in this release.

Pump.fun public access remains denied in the existing collector, with explicit
cooldown. X remains disabled at the user's direction. Bluesky is not a replacement
for either audience. No alternate identity, cookies or scraping bypass was added.

## QA inventory

- Unit and engine regression: contract boundaries, link allowlist, ticker
  collisions, invalid identities/timestamps, deduplication, zero versus unknown,
  capped responses, partial failures, rate/author gates, expiry, fairness,
  mint-level request reuse and ticker exclusion from scoring.
- Live: bounded two-query response through the existing AppView, followed by a
  production scheduler pass. Zero returned matches are reported as such, not
  as evidence of zero platform-wide activity.
- Browser: mobile and desktop Data coverage to one-tap token inspection;
  expand/collapse and source links; fixture positive/partial/expired samples;
  no page errors, nested interactive controls or horizontal overflow.
- Existing stock lookup, startup and SPY containment tests remain in the
  regression suite. Same existing-app preview only, no public publication.

## Verification

- 77 focused unit/integration/regression tests passed. Full production build
  passed, followed by a frontend rebuild for the one-tap inspection fix.
  TypeScript still reports the same 59 unrelated diagnostics, none in changed
  files; this is not a clean whole-repository typecheck.
- The live scheduler completed four-mint batches, with per-provider denial
  still exposed. A browser checkpoint had eight current samples among 75
  distinct tracked mints and no exact-contract matches in those samples.
  Counts are point-in-time and will change; sparse results do not establish
  absence of activity on other networks.
- Real-response local browser QA passed Data coverage to token inspection,
  at 390px and 1440px. Isolated fixtures tested populated post receipts,
  open/close, source-link navigation without collapsing the card, escaped
  script-like text, capped/partial results and expiry withdrawal.
- No page errors, nested button/link controls or horizontal overflow were
  observed. Screenshots of positive/partial fixtures and real responses were
  visually inspected. Fixtures were removed after testing.
- Implementation commit `cc7dc02` deployed to the existing Batcave preview.
  Fresh 390px touch QA in an opaque `allow-scripts` iframe passed startup,
  Intel listing search, social coverage and one-tap sample inspection, with
  no page errors or horizontal overflow. A deployed checkpoint showed 16
  current samples among 131 distinct tracked mints, still zero exact-contract
  matches. The correct output was insufficient evidence, not a momentum call.
  QA receipt: `/home/user/workspace/crypto-social-qa.json`.
