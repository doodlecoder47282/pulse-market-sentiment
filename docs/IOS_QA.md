# iPhone milestone QA

## Scope

New native connection shell, API transport, read-only gateway, Xcode project,
and separate native build. Existing market strategies are not being re-audited.

## Checks

- Empty/invalid origin and token: actionable validation; no dashboard/API polling.
- Insecure origin and preview origin: rejected before transmitting the token.
- Unreachable or unauthorized backend: stays on connection screen.
- Fixture handshake: opens existing terminal and shows read-only status.
- Disconnect: returns to setup and clears token and query cache.
- Offline: connect disabled; connected state warns about stale data.
- Widths 375 and 1280: no horizontal overflow; connect button and labels usable.
- Backend tests: authentication, CORS, read allowlist, writes denied, web unchanged.
- Native bundle/config: no token default and no server.url or cleartext exception.
- Xcode/device: NOT VERIFIED in Linux; required on user's Mac.

Browser handshake fixtures are synthetic test responses, not live market data.

## Results: 2026-09-28

- Native frontend build: PASS. Capacitor iOS SPM generation and sync: PASS.
- Web frontend build: PASS (no production-server restart).
- Three automated test groups: PASS, including 181-request rate-limit test.
- Browser Chromium at 375x812 and 1280x900: PASS for connection form, required
  inputs, insecure-origin rejection, 401, fixture connection, disconnect, offline,
  and recovery from offline. No page errors or horizontal overflow observed.
- Native/Capacitor config typecheck: PASS.
- Whole-repo typecheck: FAIL, 182 errors outside the changed mobile files.
- Dependency audit: 15 findings, including 5 high; requires triage before release.
- Native Swift compilation, WKWebView behavior, real authenticated feeds, and
  physical-device signing/install: NOT TESTED. Use the Mac checklist.
- Multi-user security and NIST conformance: NOT ESTABLISHED; see `SECURITY.md`.
