# Batcave: GitHub and Railway verification

**Verdict: locally repaired and tested; production acceptance remains incomplete.** Railway is reachable, but this review has not changed its deployment. Latest review performed October 15, 2026 EDT.

## Scope and preserved work

Review begins at `quant-fixes` commit `2dd52b917f208dfc29e256659b0707cfd2a8a032` in a separate worktree. The older private-preview worktree, evidence ledger, and uncommitted ticker-news adapters are preserved, not merged automatically. Vercel publishing remains canceled. Native iOS release work remains paused.

Railway URL: https://pulse-market-sentiment-production.up.railway.app

GitHub branch: https://github.com/doodlecoder47282/pulse-market-sentiment/tree/quant-fixes

## QA inventory

| Claim or flow | Required check | Boundary |
| --- | --- | --- |
| Buildable source | TypeScript, full production build, quant regression suite | Local checkout, not deployed acceptance |
| Clean first connection | No dashboard or protected queries before access check; missing key is not a rejected key | Browser-controlled local fixtures |
| Reconnection | Wrong key, valid key, expired key, malformed health, offline and bounded timeout | No real credentials |
| Storage-blocked browser | Session connection works without reload or persistent storage | Fixture, not a secret-storage security certification |
| Thumb-first gate | 44px controls, keyboard submit, focus visibility, short screen and enlarged text | Chromium emulation |
| Responsive dashboard | All eleven views at phone, tablet, desktop sizes; More to Crypto; desktop/mobile resizing | Clearly labeled isolated sample-data server |
| Mobile zoom | No restrictive maximum-scale directive | Source and rendered metadata |
| Production availability | Public health, root, assets, login gate, no unauthenticated data exposure | Read-only public Railway requests |
| Live brokerage data | Authenticated ticker/options/news/crypto workflows and observation freshness | Blocked: access-key request declined |
| Deployment identity | Railway service branch, deployed SHA, volume and runtime variables | Not visible from public health |

Exploratory cases: offline recovery, blocked storage, expired authorization, narrow/short viewport, 200% root text. No provider/model credentials are copied into the review environment. Sample-data results do not validate financial accuracy.

## Initial findings

- Remote `quant-fixes` is 56 commits ahead of the last shared ancestor with `main`; this does not establish what Railway deployed.
- The old private-preview Trade Brief, evidence ledger and ticker-news modules are absent by filename from this remote branch. Equivalent functionality and migration require a separate reconciliation, not a blind merge.
- Railway health responds with `ok: true`, `authRequired: true`, `locked: false`, `edition: personal`. No deployed revision is exposed.
- The production startup mounts the dashboard under the access overlay. Unauthorized data calls generate an incorrect rejected-key message before any key is entered.
- The viewport currently disallows zoom. The review patch removes that restriction without changing chart calculations.
- Dependency audit findings require triage; package severity alone does not prove exploitability.

## Repairs implemented in the isolated review branch

- **Connection boundary:** the dashboard mounts only after the access check, not behind an overlay. First-time visitors are no longer accused of entering an invalid key.
- **Bounded recovery:** health and authorization checks have ten-second deadlines. Network/server failure is distinct from rejected credentials. An expired authorization unmounts the dashboard.
- **Blocked storage:** a page-session-only fallback carries the connection when browser storage is unavailable. It does not survive closing/reloading the page, does not log secrets, and does not pretend to be durable storage.
- **Mobile entry:** minimum 44px gate controls, password autocomplete, live status, keyboard submission and scrollable short-screen layout. Viewport and table scrollers permit pinch zoom.
- **Development startup:** moved the Crypto lazy initializer below the React import. This fixes the Vite-development blank-screen exception without changing Crypto calculations.
- **Ticker identity:** browser testing reproduced an AAPL request displaying SPY spot/playbook alongside AAPL gamma. The briefing now requires matching returned identities, normalizes SPX aliases, requests SPY models explicitly, and never substitutes SPX/SPY data for unsupported stock models.
- **Verdict containment:** broad-market inputs alone no longer produce a directional verdict for a stock lacking a verified matching-symbol playbook or daily model. Reference data can remain visible; unsupported playbooks, models and scores remain absent.
- **Search clarity:** larger Search/Refresh controls, an accessible ticker label, and explicit “Market headlines” disclosure. These headlines are not claimed to be verified ticker-specific coverage.
- **Compatible dependency updates:** lockfile updates only for nanoid, postcss, proxy-addr, source-map-js and ws. No forced upgrades, new vendors, or paid model calls.

The symbol contamination follows directly from the original aggregator accepting fallback responses without checking their identities; the upstream playbook route supports SPY/SPX and defaults other symbols to SPY, while the model route defaults to SPX. These source paths are in the [reviewed Claude branch](https://github.com/doodlecoder47282/pulse-market-sentiment/tree/quant-fixes/server).

## Verification results

| Check | Result | What it establishes |
| --- | --- | --- |
| TypeScript | Pass, zero diagnostics | Final local source type-checks |
| Production build | Pass | Final client and server compile |
| Quant/regression tests | 684 total, 682 passed, two skipped, zero failed | Includes thirteen new connection/symbol-safety tests; not predictive performance |
| Connection browser fixtures | Eleven scenario groups passed | Missing/invalid/valid key, expiry during use, blocked storage, malformed health, outage recovery, timeout, size/keyboard checks |
| Navigation matrix | 33/33 view transitions | Eleven tabs at 375×667, 820×1180 and 1440×900, with visible controls; no document horizontal overflow, nested buttons or JS page errors |
| Gate sizing | Five viewport/text states | 375×667, 390×844, 820×1180, 1440×900, plus 390×400 with 200% root text |
| Responsive state | Pass | Live page resized mobile → desktop → mobile; theme toggle round trip works |
| Compiled-build stock search | Pass for identity containment | AAPL sample spot comes from AAPL gamma; SPY playbook/model prices and unsupported score withheld |
| Compiled-build Crypto | Loaded | Tablet rendering and exchange-direct panel reachable on the isolated server |
| Railway public checks | HTTP 200 health/root; key gate renders | Reachability, not authenticated data quality or exact deployed revision |

The navigation captures include loading states. They establish navigation and initial geometry, not complete loaded-state acceptance for every chart and control. Additional loaded Crypto, AAPL briefing and representative compiled-build screens were inspected. Chromium emulation is not physical iPhone, iPad, Safari/WebKit, Android, or Xcode acceptance.

All stock values in local browser tests were explicitly labeled sample data. Crypto/public-news adapters may fetch public sources in this demo edition; these probes do not certify provider coverage or real-time freshness. No brokerage/model credentials were supplied to the isolated server.

### Evidence retained locally

- `railway-review-final-typecheck.log`
- `railway-review-final-build.log`
- `railway-review-final-tests.log`
- `railway-review-qa/navigation.json`
- `railway-review-qa/production/connection-gate.json`
- `railway-review-qa/production/aapl-identity.json`
- `railway-review-qa/production/summary.json`
- `railway-review-final-audit.json`

These files live next to the review checkout. The durable regression tests are committed with the code; runtime databases and sample session files are excluded.

## Remaining issues and release gates

| Priority | Issue | Required next action |
| --- | --- | --- |
| Blocker | Exact Railway branch/commit unknown | Inspect the Railway deployment's source branch and commit before promoting anything. The public health endpoint exposes neither. |
| Blocker | Protected live-data workflows untested | Owner-authorized verification of quote/chart/options/news/crypto responses, identity, observation age and explicit unavailable states. The access-key request was declined and will not be repeated. |
| Blocker | Histories are not fully reconciled | Compare older private-preview Trade Brief, evidence ledger/replay/recovery and ticker-news work with current GitHub equivalents. Preserve both histories; no blind merge. |
| High | Six high dependency findings remain in the production dependency tree | Triage the Tailwind/fast-glob/micromatch/chokidar/braces chain and build/runtime reachability; no patched braces version was offered by this audit. Avoid claiming security completion. |
| High | Light-theme contrast is poor on several existing status/banner labels | Fix semantic foreground colors across Crypto, regime and sample-data labels, then measure contrast in loaded states. Theme toggling working does not imply accessible contrast. |
| High | Full loaded-state device coverage incomplete | Test all dense charts, long lists, errors and 200% text after data loads; add Safari/WebKit and real-device checks. |
| High | Stock brief source coverage is still limited | Add verified ticker-attributed news, company event data and symbol-supported models through evidence adapters. General market headlines remain context only. |
| High | Shared-key app is not a multi-tenant brokerage product | Separate account identity, authorization, token ownership, secret rotation, persistence, backups, audit and incident response before other users connect brokerage accounts. |
| Medium | Cold downstream data can exceed the brief deadline | The bounded brief may withhold otherwise available SPY models/playbook on a cold run. Improve cache warmup/observability without extending stale data into apparent live evidence. |
| Medium | Railway durability and variables uninspected | Confirm persistent data volume, callback URL, token encryption configuration, origin policy and restart recovery. |
| Medium | Build/runtime version mismatch | Local Node 20 build passed, quant CI uses Node 22, and Capacitor CLI requires Node 22. Align intentionally before resuming native work. |

### Dependency audit boundary

The production-dependency audit moved from 16 findings (one critical, ten high, three moderate, two low) to eleven (zero critical, six high, three moderate, two low). The targeted proxy-addr update addresses the version flagged by the [IP-spoofing advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), and ws was updated beyond the affected range in the [fragment-exhaustion advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p). Package advisories are not proof of a reachable exploit, and zero critical advisories is not proof that the app is secure.

The remaining dependency chain includes the unresolved [braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No security-standard certification, penetration test, or multi-user isolation acceptance was performed.

## Safe promotion sequence

1. Review the isolated `review/railway-device-verification` branch against `quant-fixes`. Approve the intended remote branch and pull-request destination before pushing.
2. Run the same automated checks on that exact commit in GitHub. The earlier [green Claude CI run](https://github.com/doodlecoder47282/pulse-market-sentiment/actions/runs/38685292677) does not cover these new local patches.
3. Confirm Railway's source branch/commit and persistence settings. Do not deploy an older `main` merely because it is the default branch.
4. Perform owner-authorized live-data acceptance on staging, then promote the exact verified commit with rollback recorded.
5. Reconcile the older private-preview feature lineage separately, with data migration and recovery tests where needed.

No GitHub push, pull request, Vercel publication or Railway deployment was performed by this review. iOS remains paused. These fixes are local until explicitly promoted.
