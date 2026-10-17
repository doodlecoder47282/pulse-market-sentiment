# Batcave: next social-data provider decision

Verdict: keep the current attributed public-social sample, then test an authorized Farcaster feed before buying broader cross-network coverage. No provider below has been connected by this evaluation, no account was created, and no subscription or redistribution right is assumed.

## Shortlist

| Candidate | What is actually supported | Decision |
|---|---|---|
| Neynar / Farcaster | Cast search supports literal queries, chronological ordering, pagination and time filters, with `x-api-key` authentication. Its API rate-limit documentation describes a free tier with 10 million credits/month and 120 search requests/minute, but its public pricing page lists a different free allowance and older paid tiers. Actual account entitlement must resolve that conflict before planning collection ([search documentation](https://docs.neynar.com/reference/search-casts), [API limits](https://docs.neynar.com/reference/what-are-the-rate-limits-on-neynar-apis), [pricing](https://neynar.com/pricing)). | Best bounded free-tier pilot candidate, conditional on entitlement. Query exact contracts and known token links, measure coverage, freshness and duplication. It is not an X replacement. |
| LunarCrush | The pricing page advertises social coverage across X, Reddit, YouTube, TikTok, Instagram and news, with social metrics and API access in paid plans; listed monthly prices start at $90, with larger tiers at $300 and $900. A free account's displayed discovery data should not be treated as a free API license ([pricing](https://lunarcrush.com/pricing)). | Broad paid candidate only after a sample proves token identity, latency and useful incremental coverage, and applicable display rights are checked. No purchase authorized. |
| Stocktwits Firestream | Firestream requires a stream-authorized account using HTTP Basic authentication. Documentation supplies a symbol reference and sentiment endpoints, including five-minute charts, but that is not proof of unrestricted access or a contract-address mapping for meme coins ([Firestream documentation](https://firestream.stocktwits.com/)). | More relevant to stock research first. Confirm entitlement and permitted use before integrating; do not confuse connector access with production redistribution rights. |
| Santiment | SanAPI documents a free plan with 1,000 calls/month, while restricted metrics on Free/Pro can have a 30-day realtime restriction. Access is metric-specific and can be checked with `getAccessRestrictions`; unrestricted metrics are a different case ([plans](https://academy.santiment.net/products-and-plans/sanapi-plans/), [access restrictions](https://academy.santiment.net/sanapi/historical-and-realtime-data-restrictions/)). | Useful evaluation/history candidate, not an assumed free live-social replacement. Check the exact metric and account before using it in a current-velocity score. |

## Acceptance gate before promotion to the crypto desk

- **Identity:** Exact chain and contract mapping. Keep ticker-only matches outside the contract-attributed velocity calculation.
- **Observation time:** Store original post time separately from collection time. Detect pagination gaps, stale pages and replayed responses.
- **Coverage:** Measure the percentage of active tracked contracts with enough distinct authors and non-overlapping observation windows. Silence in a sampled feed is not proof of no activity.
- **Manipulation:** Preserve repeated text, repost and author-concentration diagnostics; do not interpret raw post counts as organic interest.
- **Incremental usefulness:** Compare the candidate with the existing attributed sample using forward observations, not a handful of attractive examples.
- **Rights and operations:** Confirm permitted collection, storage and display; enforce quotas, cache responses and expose degraded states. Do not bypass access controls or reconnect the dismissed X connector.

## Bounded next action

If authorized access is supplied, run a small Neynar pilot against the existing tracked contract list, with a fixed request budget and a saved coverage report. Expand only if it contributes timely, contract-specific observations that the current sample misses; otherwise retain the visible social-data gap rather than inventing velocity.

The stock Trade Brief repair is independent of this provider decision. It does not add X access or automatically improve meme-coin social coverage.
