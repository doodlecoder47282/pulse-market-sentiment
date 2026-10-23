# Batcave on iPhone (Xcode)

The iOS app is the existing React terminal bundled into a native shell with
Capacitor 8. It is a client: the data engine (collectors, scoring, SQLite,
Schwab tokens) stays on your hosted server. No brokerage secrets are in the app.

```text
iPhone app: bundled UI (ios/App/App/public) + saved server URL + access key
                         |
                  HTTPS, x-batcave-key header
                         |
Hosted server (Railway): Express API + collectors + SQLite + Schwab OAuth
```

## Run it on your iPhone or the Simulator

Requirements: a Mac with Xcode 26 or newer. The Simulator needs no Apple
account; your own iPhone works with the free Personal Team (apps signed that
way expire after 7 days and are reinstalled from Xcode).

1. Get `Batcave-iOS-Xcode.zip` (the web UI is already bundled inside, so no
   Node or npm is needed): it is published by `.github/workflows/ios-build.yml`
   to the `ci-reports-ios` branch and as a run artifact. Unzip it.
2. Open `ios/App/App.xcodeproj`. Swift packages resolve on first open.
3. Simulator: pick an iPhone simulator as the run destination, press **Run**.
4. Phone: **App** target → **Signing & Capabilities** → **Team**: your Apple
   Account. If the bundle ID is unavailable, change `com.batcave.terminal` to
   something unique. Plug in the phone, choose it, press **Run**, then trust
   the developer certificate on the phone and enable Developer Mode if asked.
5. First launch shows **Connect to your Batcave server**. Enter the hosted URL
   (e.g. `https://xxxx.up.railway.app`) and the access key if the server sets
   `BATCAVE_ACCESS_KEY`. Both are saved on the device only.

## Private use only (no store, no TestFlight)

The app is for the owner's own phone, talking to the owner's own server.
What keeps it private and what it does not do:

- **Signing.** Sign the App target with your own Apple account (free
  Personal Team: the install expires after 7 days and is re-run from Xcode;
  a paid Developer Program membership gives one-year profiles). Nothing is
  uploaded to Apple; there is no TestFlight build and no App Store listing.
- **Server side.** The hosted server must run with `BATCAVE_ACCESS_KEY` set
  (it fails closed off loopback unless `BATCAVE_ALLOW_OPEN=1`, which a
  personal server must not set) and behind HTTPS (Railway terminates TLS;
  HSTS is sent on HTTPS responses). The app sends the key as
  `x-batcave-key` on every call; wrong keys are slowed down server-side.
- **What the phone stores.** The server URL and the access key, in the
  app's own WKWebView storage: sandboxed to the app and encrypted at rest
  by iOS when the device is locked. It is not the Keychain; for a shared
  or managed device, move it to a Keychain plugin first (an npm add via
  the `npm-add` workflow). No Schwab token, client ID or secret is ever on
  the phone: Schwab login happens in Safari and the tokens stay on the
  server.
- **Rate limits** apply per client; one phone never reaches them.
- **The Xcode zip** is built by CI on the `ci-reports-ios` branch and as a
  run artifact; it contains the web bundle of the commit that triggered
  it. Rebuild by editing `.github/ios-build.txt` on `main`.

## After code changes

```bash
npm install
npm run ios:sync      # vite build + copy into ios/App/App/public
npm run ios:open      # opens Xcode
```

CI (`.github/workflows/ios-build.yml`) runs when `ios/`, `capacitor.config.json`
or `.github/ios-build.txt` changes on `quant-fixes` or `main`: it builds the web
bundle, syncs the Xcode project, compiles it for the iOS Simulator without
signing, takes a simulator screenshot, and publishes the Xcode zip. To rebuild
after UI-only changes, edit `.github/ios-build.txt`. Generated files
(`ios/App/App/public`, `capacitor.config.json` and `config.xml` inside it) are
not committed.

To bake a default server URL into the build, set the repository variable
`BATCAVE_API_BASE` (Settings → Secrets and variables → Actions → Variables).
Never put Schwab or API keys there; the app must not carry server secrets.

## What changed in the app for iOS

- `client/src/lib/queryClient.ts`: API base resolves from the saved server URL,
  then `VITE_API_BASE`, then same origin. Sends `x-batcave-key` when set.
- `client/src/components/ConnectionGate.tsx`: server URL / access key setup.
  On the website it only appears when the server requires a key.
- `server/index.ts`: `/api/health`, CORS for `capacitor://localhost`, optional
  `BATCAVE_ACCESS_KEY` gate, `0.0.0.0` bind on hosted platforms.

## Not done yet

- Not signed, not on TestFlight, not tested on a physical device.
- Schwab "Connect" opens the Schwab login in Safari; the server receives the
  callback and stores the tokens. Tap Refresh in the app afterwards.
- App Store release needs app-specific value beyond a wrapped website
  (Apple guideline 4.2) and an Apple Developer Program membership.
