# Batcave startup reliability

Date: September 30, 2026 (ET). Scope: blank screen/spinner repair only.
Native iOS remains paused. SPY forecasts remain disabled.

## Reproduced failure

The deployed app became completely blank when the launch-animation chunk was
blocked. The root had no children while `__APP_BOOTED__` was already true.
An automatic one-shot reload had added `wdbust`, but the second failure had
no recovery UI. This is a reproduced failure path, not proof of the exact
network/device condition on the user's phone.

## Changes

- HTML recovery surface works without React, fonts or application JS. After
  12 seconds it explains a boot delay. Manual reload replaces the cache-buster;
  no automatic reload loop or browser storage is used.
- Fonts load without blocking first paint. A head watchdog makes still-pending
  stylesheets nonblocking after 8 seconds, restoring normal media when they load.
  This avoids trapping the body recovery script behind a hung stylesheet.
  The application then shows BC-STYLE recovery instead of an unstyled dashboard.
- Boot is marked complete only after a React screen commits. A root error
  boundary contains rendering and lazy-load failures with a reload control.
- Optional animation has a visible loading/error fallback and a stable skip
  control. Skipping preserves the daily pre-market acknowledgment.
- Dashboard is lazy-loaded only after the gates. Hidden background dashboard
  requests no longer start while a user is on the animation or checklist.
- The web snapshot GET has a 15-second deadline covering headers and JSON body,
  propagates cancellation, and aborts the request. Missing/malformed data is
  never substituted with a fabricated snapshot.
- Snapshot retry uses GET, not the expensive POST data-refresh operation.
  Recovery messages show BC-BOOT, BC-INTRO, BC-DASHBOARD, BC-RENDER or
  BC-SNAPSHOT instead of upstream response bodies.

## QA inventory and release gate

- Normal desktop/mobile: skip animation, scroll and acknowledge the checklist,
  reach real snapshot, navigate Models and Crypto, verify SPY remains gated.
- Missing entry/vendor chunk: readable static recovery, delayed message,
  working manual cache-busted retry, including a second failure.
- Missing/stalled animation: no blank screen, continue without animation.
- Missing/stalled dashboard chunk: reload recovery, no hidden-only content.
- Snapshot timeout/HTTP error: stop loading, display BC-SNAPSHOT, GET retry
  recovers without POST refresh.
- Offline initial data read: visible reconnect instructions.
- Malformed snapshot render: root recovery instead of a blank screen.
- Sandboxed iframe and phone viewport: visible controls, no horizontal overflow.
- Separate visual review of mobile boot/recovery and desktop loaded dashboard.

## Verification

- 32 focused automated tests pass: startup deadline/recovery guards plus the
  existing SPY projection and stock-brief suites.
- Frontend production build passes. Backend code and running process were
  not changed or restarted, avoiding an unnecessary provider warm-up burst.
- TypeScript still reports 59 pre-existing diagnostics, none in these changed
  client files or the new tests. This is not a whole-repository clean-type claim.
- Twelve Chromium scenarios passed locally: real mobile startup; missing
  animation; missing dashboard; entry failure including cache-busted retry;
  safe HTTP 503; snapshot timeout and successful GET retry without POST;
  malformed snapshot render; indefinitely stalled animation; offline event;
  indefinitely stalled dashboard; real desktop/Models navigation; and a
  stalled stylesheet with successful reload recovery.
- Visual review passed for 390px recovery states/mobile terminal and 1440px
  desktop terminal. No horizontal overflow in normal tested layouts.
- Full user-device reproduction remains unavailable. The original fault was
  reproduced by blocking the animation chunk, not observed on the user's device.

No application feature calculations, provider adapters, model training, native
build artifacts or account/security settings were changed. Legacy panels other
than the repaired SPY projection are not newly validated by this startup work.
