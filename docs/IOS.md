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

## Run it on your iPhone

Requirements: a Mac with Xcode 26 or newer and your Apple Account. The free
Personal Team works for your own phone; apps signed that way expire after 7
days and are reinstalled from Xcode.

1. Get the project, either way:
   - `git clone -b ios-capacitor https://github.com/doodlecoder47282/pulse-market-sentiment`
   - or download `Batcave-iOS-Xcode.zip` from the latest "Batcave build" run
     under the repo's Actions tab (Artifacts section) and unzip it.
2. Open `ios/App/App.xcodeproj` in Xcode. Swift packages resolve on first open.
3. Select the **App** target → **Signing & Capabilities** → **Team**: your
   Apple Account. If Xcode says the bundle ID is unavailable, change
   `com.batcave.terminal` to something unique (e.g. `com.yourname.batcave`).
4. Plug in the iPhone, choose it as the run destination, press **Run**.
   On the phone: Settings → General → VPN & Device Management → trust your
   developer certificate, and enable Developer Mode if prompted.
5. First launch shows **Connect to your Batcave server**. Enter the hosted URL
   (e.g. `https://xxxx.up.railway.app`) and the access key if the server sets
   `BATCAVE_ACCESS_KEY`. Both are saved on the phone.

## After code changes

```bash
npm install
npm run ios:sync      # vite build + copy into ios/App/App/public
npm run ios:open      # opens Xcode
```

CI (`.github/workflows/batcave-build.yml`) does this on every push to
`ios-capacitor`: it builds the web bundle, syncs the Xcode project, compiles it
for the iOS Simulator without signing, commits the synced project back, and
publishes the Xcode zip as a build artifact.

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
- Schwab "Connect" inside the app uses the existing paste-the-redirect-URL flow;
  connecting from the website once is simpler (tokens live on the server).
- App Store release needs app-specific value beyond a wrapped website
  (Apple guideline 4.2) and an Apple Developer Program membership.
