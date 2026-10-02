# Batcave: Stage A source and evidence foundation

Implemented October 1, 2026 ET. This is the first bounded package from the saved framework, not completion of all Stage A governance or the wider roadmap.

## Delivered

- **Source register:** 27 selected source/product records distinguish stock-brief enforcement, inventory-only crypto adapters and disabled access. Stable IDs, endpoints, upstream lineage, local timing/cadence rules and limitations are explicit. All rights remain unverified; no entry is a provider-health or licensing certificate. X remains disabled.
- **Shared contracts:** Listed-security and chain/mint/pool research identities, numeric/text units, observation precision, time roles, source lineage, calculation dependencies and expiry are validated. Unknown receipt, first-seen and known-at timestamps remain null. Processing time is not substituted for any of them.
- **AI admission:** The existing stock builder attaches a versioned review. Optional AI recomputes admission at request time, excluding unregistered sources, incompatible units/identity/time, stale or delayed evidence, unauthorized citation locations and invalid dependencies. Rejected parents suppress dependent claims; cycles and duplicate IDs fail closed. Empty eligible claims cause deterministic fallback before any model call.
- **Cached news:** Only registered publisher/feed names with allowed citation hosts reach the existing stock news context. The Reuters-via-Google path is identified as a proxy lineage, not a new independent source. Existing attribution, feed-health and publication-time gates remain.
- **Interface:** A collapsed “Source policy & AI eligibility” section reports evidence counts, source limitations, reasons for exclusions and unverified rights. Counts are not confidence or independent-source counts. Expiry replaces current eligibility with an explicit expired state. Controls retain at least a 44px target.

## Verification

- **41 focused tests passed:** New policy tests plus stock brief, enrichment and optional AI regressions. Fixture calculations still produce the expected ATR, structure, volume and macro results.
- **Production build passed:** Existing large-bundle warnings remain. Full-repository typecheck still reports 59 pre-existing diagnostics, none in this package's changed files.
- **Browser checks passed:** Actual Intel search, explicit INTC selection and backend Analyze response; 375px touch and 1440px desktop; source disclosure and exclusion disclosure open/close; expiry; a fixture HTTP 503; and legacy payload compatibility. No page exceptions or horizontal page overflow were observed in the checked states. Reviewed both screenshots.
- **No actual model requests:** Browser request tracking recorded zero AI-curation POSTs. Tests used injected stubs. No council, new provider research, subscription, credential request or new polling loop was introduced.
- **Runtime:** Main server rebuilt/restarted once on port 5000 without model credentials. Existing schedulers are unchanged. The isolated optional curator on port 5002 was not restarted.

Local evidence: `stage-a-tests.log`, `stage-a-typecheck.log`, `stage-a-build.log`, `stage-a-mobile.png`, `stage-a-desktop.png` in the workspace. These are engineering checks, not proof of provider coverage, alpha, future accuracy or production security.

## Explicit limits

- **Scope of enforcement:** New contracts gate stock AI selection and stock news admission. Existing stock numeric displays retain their prior validated adapters; the review does not rewrite their calculations. Older evidence without source IDs may display but is not selectable by AI.
- **Crypto migration:** Crypto source records are inventory only. This release neither fills the social-data gap nor replaces existing crypto security/grading adapters.
- **Historical proof:** This is a core envelope, not a complete ledger. Exchange calendars, session/adjustment contracts, release-vintage history, event/block IDs, payload hashes, correction replay and durable recovery remain later work. No first-seen/known-at times were invented.
- **Security and rights:** The public/multi-user scope is rejected by this evidence-policy function. That is not an application-wide authorization firewall. Credential exposure closure, token isolation, tenant authorization, legal data-use review and NIST control evidence remain unresolved release gates.
- **Forecasts and trading:** No SPY forecast, crypto ENTER, automated order, entry/stop/target, sizing or edge claim is enabled. iOS/Xcode remains paused.

## Resume without repeating work

Read `BATCAVE_STATE.md`, this release and `BATCAVE_EVIDENCE_AND_EXPERIENCE_FRAMEWORK.pplx.md`. Policy version: `evidence-policy-2026-10-01.1`. Stock calculation/output version: `stock-brief-2026-10-01.3`.

Next bounded package: a verified exchange-session calendar contract and point-in-time history design, then a small fixture-tested integration. Do not introduce another model council, broad provider hunt or paid adapter unless separately needed and authorized. Retain existing manual AI triggering, caching and request caps.

Only commit code/tests/docs from this package. Do not stage runtime databases, scheduler state, prediction/session files or `data/brief-ai/`. Reuse the existing Batcave preview rather than creating a new app.
