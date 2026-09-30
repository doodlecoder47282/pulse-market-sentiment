# Stock Trade Brief and SPY projection guard — parent integration

Status: code stable; route integration completed after explicit parent permission,
and parent reports the dashboard mount completed. Ready for one coordinated
build/restart/acceptance run. Not deployed or production validated by the stock
agent. Native iOS remains paused.

## Exact integration (completed; retain for review)

The stock agent completed steps 1–3 in `server/routes.ts`, preserving the parent's
`getCryptoContext` import and `/api/crypto/context` endpoint. The parent completed
the dashboard mount in step 4. Do not repeat registration or add a second route.

1. In `server/routes.ts`, add:

   ```ts
   import { registerTradeBriefRoutes } from "./tradeBrief";
   import { spyProjectionRoute } from "./spyProjection";
   ```

2. Inside `registerRoutes(httpServer, app)`, under the existing restricted web API
   boundary, call once:

   ```ts
   registerTradeBriefRoutes(app);
   ```

3. **Replace** the entire old inline
   `app.get("/api/ml/projection-spy", async (_req, res) => { ... });`
   handler (originally around lines 6139–6378, between the SPY endpoint comment and
   the ML-service-health comment) with:

   ```ts
   app.get("/api/ml/projection-spy", spyProjectionRoute);
   ```

   Do not keep the old route first, append a shadow route, or preserve its GBM,
   snapshot-fallback, fixed-divisor dealer-level and mixed-instrument model calls.
   No changes to `/api/ml/projection-spx` or other consumers were made.

4. In `client/src/pages/dashboard.tsx`, add:

   ```tsx
   import TradeBriefSearch from "@/components/TradeBriefSearch";
   ```

   Mount once near the main tabs, outside individual `TabsContent` panels, e.g.
   immediately before `<Tabs ...>`:

   ```tsx
   <TradeBriefSearch className="mb-5" />
   ```

   The component manages its own search, explicit selection, horizon, requests and
   response races. No props, new providers, global CSS or query hooks are needed.
   Parent may choose a collapsible persistent wrapper to reduce initial page height.

5. `MLProjectionPanel.tsx` remains the same default export and existing Models
   mount. It now consumes the guarded response and rejects legacy/synthetic
   payloads, so an old backend yields explicit UNAVAILABLE, not the old chart.

## Owned files

- New `shared/tradeBrief.ts`, `server/tradeBrief.ts`,
  `client/src/components/TradeBriefSearch.tsx`.
- New `shared/spyProjection.ts`, `server/spyProjection.ts`.
- Replaced `client/src/components/MLProjectionPanel.tsx` unsafe rendering surface.
- Narrowly edited `server/routes.ts` after parent permission: two imports, one
  registrar call, and replacement/removal of the complete old inline SPY handler.
- New `tests/trade-brief.test.ts`, `tests/spy-projection.test.ts`.
- This handoff and `docs/SPY_PROJECTION_REVIEW.md`.

No edits by this agent to dashboard, global CSS, crypto modules, provider
credentials, native code, runtime data, package manifests or lockfiles.

## Implemented stock slice

Finite canonical US stock/ETF registry; ticker/name lookup never silently picks a
listing or share class. Default swing context uses prior-week completed OHLC;
deliberately selected intraday uses the prior weekday. Every brief enumerates
quote, levels, news, options, volume, earnings, macro and seasonality applicability,
source health, contribution, timestamps, dependencies and missing prerequisites.

Reuses the configured Schwab `schwabFetch` transport, existing `classicPivots`,
DST-aware ET conversion and read-only cached `getFredSnapshot`. The raw quote
adapter retains provider last-trade time and explicit real-time entitlement
because the existing normalized helper drops them. Old cooldown-cache data
cannot receive a new observation timestamp. No Yahoo prices or CBOE delayed-cache
fallback. No AI/model helper is invoked.

Fresh quote and compatible completed bars produce only research/WATCH with
versioned classic S1/pivot/R1 reference levels. They are not invented entries,
stops or targets. Quote missing/stale/delayed/unknown time or entitlement yields
INSUFFICIENT DATA and no current price/levels. Company earnings are unverified,
never generated from the synthetic baseline; corporate earnings are not
applicable to ETFs, with holdings/fund-event risk still explicit.

News/options/seasonality are unsupported adapters with named reasons, not
fabricated coverage. Volume is cumulative timestamped provider volume, not RVOL
or directional flow. Macro is a bounded subset of cached dated FRED observations;
stale observations do not contribute. No fake “no news,” “not halted,” “no earnings
risk,” probability, account sizing, orders or options P&L.

GET-only endpoints:

- `/api/trade-brief/search?q=Alphabet` — max query length 64, max eight choices.
- `/api/trade-brief?instrument_id=US%3ASTOCK%3AAAPL&horizon=swing`.
- Strict parameter schemas and exact finite-registry identity; no arbitrary URLs.
- 45-second immutable brief cache, keyed by identity/horizon/calculation version;
  expiry shortened to the earliest consumed quote/volume age limit.
- Source reads deduplicated across horizons. At most four in-flight reads,
  eight-second response deadlines. Existing Schwab helper cannot abort a read, so
  its slot is retained until settlement instead of spawning replacement reads.
- Conservative process-wide 120 searches / 30 brief requests per minute.
- No response exception detail, credentials, raw provider JSON or account data.
  This does not fix existing app-wide logging/auth architecture.

## Tests/status

`npx tsx --test tests/trade-brief.test.ts tests/spy-projection.test.ts`:
19 focused groups passed. Log:
`/home/user/workspace/stock_brief_projection_focused_tests.log`.

One TypeScript check was run before the later parent coordination message:
no diagnostics in these owned files. Concurrent tree reported 64 (59 baseline plus
five concurrent crypto-context/engine diagnostics); parent owns their resolution.
No subsequent general typecheck or full build was run by this agent.
Log: `/home/user/workspace/stock_brief_projection_typecheck.log`.

Isolated fixture Chromium UI QA passed at 375/390/430/1280/1440 widths, with no
horizontal overflow or page errors. Covered explicit Alphabet share-class choice,
keyboard search, all eight coverage categories, evidence/methodology expansion,
horizon supersession, delayed-result rejection after editing, no-match and
missing-price states, expiry withdrawal, offline refresh disablement and legacy
synthetic projection rejection. At 200% text enlargement the page did not overflow.
Dark desktop/mobile screenshots were visually inspected; light expanded
screenshots were captured, with the same overflow checks.
Details: `/home/user/workspace/stock_brief_qa/browser-results.json` and adjacent
screenshots/inventory. Fixtures are not live market observations.

No production restart, deploy, commit, upstream feed probe or credential request
was performed. The only bundle/CSS compilation was an isolated two-component QA
harness, not the app's full build.

## Known blockers and one next step

Existing configured Schwab authorization/entitlement may be unavailable; that
becomes explicit missing/unavailable, not a new authentication request. Live feed
freshness was not verified. Holiday weeks conservatively suppress weekly structure
when any weekday is absent. Actionable entry/stop/target/risk requires reviewed
horizon-specific rules, corporate-action provenance, true session calendar,
issuer/fund events and execution-cost inputs. Optional AI is deliberately not
implemented; explanation is honestly labeled deterministic.

SPY projection remains disabled even with usable observations until the model/
feature and forward-validation blockers in the separate review are resolved.

**Next step:** parent performs one coordinated build/restart/real-response and
responsive-browser acceptance run on the integrated app.
