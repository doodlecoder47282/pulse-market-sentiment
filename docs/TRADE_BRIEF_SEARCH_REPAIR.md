# Batcave listing-search repair

September 30, 2026 ET. User screenshot: Intel typed, Find listing does nothing.

## Diagnosis and scope

Reproduced against the deployed app inside an opaque sandbox iframe with
`allow-scripts` but without `allow-forms`. Both button click and Enter sent zero
search requests and left the idle text unchanged. Standalone search did submit,
but Intel returned zero results because the finite curated registry omitted it.

Search now uses explicit button and input-key handlers, not browser-native form
submission. The Search key is advertised on mobile; IME composition Enter does
not trigger a premature request. In-flight clicks are guarded, and loading,
match count, no-match and error feedback are visible near the control.

Intel Corporation / INTC is added to the shared canonical registry used by both
lookup and brief validation. Explicit listing confirmation is still required.
This remains a curated universe, not an all-securities search. No model, pricing,
levels, source-coverage, brokerage, security or native-iOS behavior is expanded.

## QA inventory

- Sandboxed mobile: tap Find listing with Intel, see INTC, select it, Analyze,
  inspect a real validated research response with source limitations preserved.
- Keyboard Enter: search INTC and Alphabet, with explicit share-class choice.
- Repeated taps during a delayed response produce a single request.
- Empty query stays disabled; no-match shows a supported-universe explanation.
- HTTP failure and a stuck response leave a visible error and retryable control.
- Edit during an in-flight response: old results cannot overwrite new query.
- Desktop and 390px opaque iframe: results are readable, no horizontal overflow.
- Confirm the actual deployed update, not just localhost or a standalone fixture.

## Verification

- 35 automated tests pass across lookup, interaction guards, startup reliability
  and SPY projection suites. Production frontend/server build passes.
- TypeScript remains at 59 pre-existing diagnostics, none in changed files.
- Ten local browser scenarios passed: sandboxed touch search; explicit INTC
  selection and real-response analysis; keyboard/share-class lookup; empty and
  unsupported queries; duplicate-tap suppression during a delayed response;
  HTTP failure; retry recovery; in-flight edit supersession; 1440px desktop
  layout; and a 12-second stalled-request timeout followed by successful retry.
- The mobile touch fixture has a 390px viewport and intentionally omits
  `allow-forms`. Screenshots at 390px and 1440px were reviewed; no horizontal
  overflow or page errors were observed. This is browser testing, not a
  physical iPhone/native Xcode build.
- Backend was rebuilt and restarted once to activate the shared INTC registry.
  No new credentials or provider subscriptions were requested.

Updated the existing Batcave artifact after code commit `8021c2a`. Two final
checks passed in the actual deployed opaque iframe (`allow-scripts`, no
`allow-forms`, no `allow-same-origin`, no mocked responses): touch Intel search
followed by INTC confirmation and Analyze, and keyboard Enter search for INTC.
Both search and research requests returned HTTP 200. No page errors or
horizontal overflow at 390px. Twelve browser scenarios total.
Results: `/home/user/workspace/batcave-search-browser-results.json`.
