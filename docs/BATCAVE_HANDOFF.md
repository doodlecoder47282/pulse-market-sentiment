# Batcave: low-credit continuity and iPhone path

The recommendation is to preserve the existing app, use short repository
checkpoints, and make the phone a client of the same backend. Do not pay for
repeated rediscovery or a second implementation of the trading engine.

## Credit-conserving operating framework

- **Durable instructions:** `AGENTS.md` defines the resume and stop rules.
- **Compact state:** `docs/BATCAVE_STATE.md` records verified facts, uncertainties,
  blockers, and the next approved action. Update it at each completed milestone.
- **Small task contract:** agree on one objective and acceptance check. Expand
  only if necessary to solve it, and ask before a materially larger workstream.
- **Selective reading:** read the checkpoint and relevant diff first. Do not load
  the entire conversation or audit the entire repository on each turn.
- **Software before AI:** let existing polling and calculation code collect data.
  Invoke AI for a requested analysis or unresolved decision, not every heartbeat.
- **Bounded retries:** after two failed attempts of one approach, diagnose and
  surface the blocker rather than cycling through providers indefinitely.
- **Targeted verification:** run the checks appropriate to the change. Skip
  build/restart/deploy for documentation-only work, never for untested code.
- **Honest limits:** this framework reduces unnecessary work; it does not set a
  billing cap. Computer cannot predict or guarantee a credit total.

No new AI schedules or monitoring loops were created. Repository files provide
portable instructions, but another agent must actually read them; they cannot
guarantee that every future tool remembers every chat message.

### Copyable resume instruction

> Read AGENTS.md and docs/BATCAVE_STATE.md, compare the current repo state, and
> continue only the next approved objective. Conserve credits. Do not reread the
> entire chat, repeat the full audit, spawn agents, or start recurring AI work.
> Save a verified checkpoint when done.

## iPhone recommendation

Use Capacitor to reuse the React web interface in an iOS project rather than
starting with a Swift rewrite. Capacitor supports adding native platforms to an
existing web project and copying its built assets into the native project.
[Capacitor installation](https://capacitorjs.com/docs/getting-started)

The recommended split is:

```text
iPhone: bundled interface + native integrations + user session
                    |
             authenticated HTTPS
                    |
Server: Express APIs + market collectors + scoring + SQLite + brokerage secrets
```

The current repo is web source, not an existing Xcode project. Keep the backend
off the phone; the proposed first native milestone is a read-only client with
login, visible source freshness, and honest unavailable/offline states.

### Preparation and build sequence

1. Resolve credential exposure and choose a persistent HTTPS backend with
   authentication. Avoid putting server secrets or temporary preview URLs in the app.
2. Add Capacitor on a feature branch, configure `webDir` to this app's
   `dist/public`, and adapt API URLs, authentication, OAuth redirects, and CORS.
3. Build the web assets, sync the iOS project, then open it with
   `npx cap open ios`. These are documented Capacitor operations, not proof that
   this repo is already configured.
   [Capacitor iOS workflow](https://capacitorjs.com/docs/ios)
4. Compile, sign, and test through Xcode on a Mac. Device behavior, safe areas,
   navigation, external links, background/foreground refresh, and network failures
   require real iOS testing before calling it ready.
   [Capacitor iOS requirements](https://capacitorjs.com/docs/ios)
5. Start with personal-device testing. Apple permits on-device Xcode testing
   using an Apple Account; free Personal Team provisioning expires after seven
   days and requires rebuilding/reinstalling. Distribution is a separate decision.
   [Apple membership comparison](https://developer.apple.com/support/compare-memberships/)

An App Store release is not automatic approval for a repackaged website. Plan
app-specific utility and review Apple's minimum-functionality requirements
before committing to public distribution.
[Apple App Review Guidelines, section 4.2](https://developer.apple.com/app-store/review/guidelines/)

## What still needs attention

- **Exposed credentials:** the GitHub repository reports public visibility and a
  tracked deployment guide contained literal Schwab credentials. Current-file
  redaction does not remove historical copies or invalidate credentials. Rotate
  them before distribution; approve history cleanup separately.
- **Social health:** current code can turn failed source collection into a zero
  score with a fresh timestamp. Treat unavailable social data as unknown, not no interest.
- **Token matching:** cashtag search alone is not reliable token identity;
  require contract-address evidence or explicitly lower-confidence matching.
- **Model validation:** a sample-size threshold is not evidence of calibration,
  profitable execution, or safe liquidity. Keep research outputs non-stakeable
  until the actual validation and execution checks support them.

These are prioritized findings from the inspected code, not a new full-system
audit. No iOS app has been built or signed in this step.

## Next decision

Do you have access to a Mac with Xcode, and is the first goal personal use on
your iPhone or TestFlight/App Store distribution?
