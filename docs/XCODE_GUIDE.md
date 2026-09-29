# Batcave iPhone: first build

This guide takes the existing React terminal into the generated Capacitor iOS
project. The first goal is to run its connection screen on your Mac and iPhone.
Live data requires a separate secured backend; Xcode does not host the Express
server, SQLite database, market collectors, or AI providers inside the phone.

Current evidence: web/server and native web builds and Capacitor sync succeeded.
The project has not yet been compiled or signed in Xcode or tested on an iPhone.
Do not invite other brokerage users during this personal prototype.

## What goes where

```text
iPhone: bundled React UI + Capacitor/WKWebView
    |
    | HTTPS, separate owner access token, read-only allowlisted requests
    v
Private-owner gateway /api/mobile/*
    |
    v
Express backend -> source adapters / models / database
```

The existing web interface is reused rather than rewritten in Swift.
The generated project is `ios/App/App.xcodeproj`, using Swift Package Manager.
Do not create a new blank Xcode project, paste the whole repository into Swift,
run `cap add ios` again, or follow an unrelated CocoaPods installation tutorial.

## Prepare the Mac

### Xcode and iOS platform support

Open Xcode once and finish any license or component-installation prompts.
Use Xcode 26 or later for this Capacitor version; check that your Mac's macOS
supports the Xcode version you install ([Capacitor iOS requirements](https://capacitorjs.com/docs/ios),
[Apple Xcode compatibility](https://developer.apple.com/support/xcode/)).

In Terminal, check:

```bash
xcodebuild -version
xcode-select -p
git --version
```

If the selected developer directory is only Command Line Tools, select your
full Xcode installation. For Xcode in the standard Applications location:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

In Xcode, install an iOS simulator runtime if prompted by the run destination
selector or the Components settings. Menu wording varies by Xcode release;
Apple documents platform support and destination selection in its
[run-on-simulator-or-device guide](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device).

### Node

This branch uses Node 22 or later. Install a supported Node version from the
[official Node download page](https://nodejs.org/en/download), or use an existing
version manager; the repository's `.nvmrc` selects Node 22.

```bash
node --version
npm --version
```

If you already use `nvm`, run `nvm install` and `nvm use` from the repository
folder after cloning. If `nvm` is not found, use the Node installer instead;
you do not need another tool just to complete this guide.

## Get the iPhone branch

For the simplest clean setup, clone into a new folder in your home directory.
This does not overwrite any existing Batcave checkout:

```bash
cd ~
git clone --branch feat/capacitor-ios --single-branch \
  https://github.com/doodlecoder47282/pulse-market-sentiment.git Batcave-iPhone
cd ~/Batcave-iPhone
git branch --show-current
```

The last command should print `feat/capacitor-ios`. If `Batcave-iPhone` already
exists, use a different new folder name or carefully update your existing clone.
Do not delete an existing folder merely to make the command work.

For an existing checkout, inspect `git status` and commit or otherwise preserve
your local work first. Then fetch, switch to `feat/capacitor-ios`, and pull with
`git pull --ff-only`. Stop if Git reports conflicts or divergence; do not use
`reset --hard` to force the instructions through.

The repository has historical credential exposure under remediation. Do not
copy old secrets from documentation, distribute repository history, or assume
that making an app build means those credentials are safe.

## Build and sync the native web assets

From inside the repository folder:

```bash
# Only if you already use nvm:
# nvm install
# nvm use

npm ci
npm run test:mobile
npm run test:calculations
npm run ios:sync
npm run ios:open
```

What these do:

- **`npm ci`:** Installs the lockfile's package versions.
- **Tests:** Run isolated regression checks; they do not require your Schwab login.
- **`ios:sync`:** Builds `dist/native` and copies its assets/plugins into the
  existing iOS project.
- **`ios:open`:** Opens that project in Xcode.

No `.env`, brokerage credentials, mobile token, backend startup, `START-PULSE`,
watchdog, database reseed, or database migration is needed to reach the setup
screen. Do not put secrets into `capacitor.config.ts`, a `VITE_` variable,
the Xcode project, or the generated JavaScript.

If the open command fails but sync succeeded, use:

```bash
open ios/App/App.xcodeproj
```

Let Xcode finish resolving Swift packages. The checked-in configuration uses
bundled files rather than a remote `server.url`; do not replace it with a
Perplexity preview address.

## Run in the simulator first

### Recommended final compiler check

After `npm ci`, run this command on your Mac before opening Xcode:

```bash
npm run ios:verify
```

It checks Node/Xcode versions, runs the nine focused test groups, rebuilds and
syncs the native assets, validates the project structure and plist, resolves
Swift packages, and attempts unsigned **Debug and Release** builds for the iOS
Simulator. No Apple signing team or brokerage secrets are needed for this check.
It does not start the market backend.

Only the message `PASS: Debug and Release compiled for iOS Simulator.` confirms
both native builds succeeded on your Mac. On a non-Mac computer the script exits
with an explicit failure, rather than treating a skipped compile as a pass.
Logs are under `ios/DerivedData/verification-logs/`; if it fails, share the first
relevant error and nearby lines after redacting local identifiers, not the whole
log or any credentials.

Then run `npm run ios:open` and follow the interactive steps below. Compilation
does not replace launching the simulator or physical-device testing.

The latest Linux clean-source check completed a fresh lockfile installation,
native build/sync, all nine tests, and `npm run ios:preflight`. All 36 native
output files matched their Xcode copies; project parsing, shared App scheme,
bundle IDs, SPM version, plist, and opaque 1024px app icon passed structural
checks. Native syntax/CSS now target Safari 15 to match the project's iOS 15
minimum, but oldest-device runtime compatibility is not certified by transpilation.

In Xcode, choose the **App** scheme and an installed iPhone simulator as the run
destination, then choose **Product > Run** or press **Command-R**.
These are the standard scheme/destination steps in
[Apple's run guide](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device).

Expected result: a Batcave **Connect terminal** screen asking for an HTTPS
backend origin and a separate mobile access token. That screen is a successful
first milestone, not evidence that live data is connected.

Do not enter your Schwab username, password, client secret, or refresh token
into either field. You can stop here until the backend is safely prepared.

## Run on your physical iPhone

### Pair and enable development

Connect the iPhone to the Mac, unlock it, and accept the trust/pairing prompts.
Select it in Xcode's device management/run destination controls; Apple's
[device-run guide](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)
describes pairing and deployment.

If required, on the iPhone open **Settings > Privacy & Security > Developer Mode**,
enable it, restart, and confirm after restart. It may not appear until pairing
has been initiated ([Apple Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)).

### Configure signing

In Xcode's Settings, add your Apple Account if needed. Select the project,
the **App** target, then **Signing & Capabilities**; enable automatic signing
and choose your team ([Apple signing/run instructions](https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device)).

The default bundle identifier is `com.batcave.terminal`. If signing requires a
unique identifier, choose one under your control, such as
`com.yourchosennamespace.batcave`, and update both the App target's bundle
identifier and `appId` in `capacitor.config.ts`. Re-run `npm run ios:sync`;
do not assume changing the Capacitor file retroactively edits all native settings.

Select your iPhone as the destination and press **Command-R**. Keep the device
unlocked during installation and inspect Xcode's exact error if installation fails.
A free Personal Team supports personal-device testing, with provisioning that
expires after seven days; ongoing distribution through TestFlight or the App Store
is a separate membership/release process
([Apple membership comparison](https://developer.apple.com/support/compare-memberships/)).

## Connect live data only after the backend gate is met

The mobile gateway source exists, but no persistent, secured live endpoint
was provisioned by this build. The app does not automatically configure hosting,
TLS, brokerage authorization, per-user identity, or source entitlements.

Required owner-side preparation:

1. Rotate the previously exposed brokerage credentials and review related
   authorizations. Do not reuse values from repository history.
2. Deploy the reviewed branch's server to infrastructure you control.
   Keep secrets in its secret manager/environment, not source or the phone.
3. Terminate valid HTTPS at a reverse proxy. Expose only the reviewed
   `/api/mobile/*` surface, with rate limiting. Keep legacy `/api/*` and
   administrative endpoints private; the mobile middleware does not secure them.
4. Generate a separate mobile owner token locally, for example with
   `openssl rand -hex 32`, and save it directly to your secret manager.
   Set `BATCAVE_MOBILE_TOKEN` in the backend environment and restart that backend.
   Never paste the token into chat, Git, screenshots, or a frontend build variable.
5. Verify authentication failure, disallowed paths, preflight, cache headers,
   and rate limits at the real proxy boundary before entering the token on the phone.
6. Verify actual data freshness and source authentication independently.
   Gateway health means the gateway answered, not that market data is current.

On the iPhone, enter the HTTPS **origin only**, such as your actual server's
scheme and hostname. Do not append `/api`, a query string, or credentials.
Enter the separate mobile token and connect. The app calls authenticated
`GET /api/mobile/health` before mounting the existing terminal.

The token lives in app memory, not Keychain, and is cleared by disconnect or
a process restart. Backgrounding is not necessarily a process restart.
Only allowlisted reads work. Broker-management, trading, saved edits, and some
panels whose computations use POST are intentionally unavailable.
No push alerts, background collectors, or offline market-data database are
included in this milestone.

This shared owner token is a personal-prototype mechanism, not multi-user
authentication. Other people must not enter Schwab credentials into this build.
See `../SECURITY.md` for the production release blockers.

## Troubleshooting

| Symptom | Check/action |
|---|---|
| Capacitor rejects Node | `node --version` must be 22+. Open a fresh terminal after installing or select the correct version manager environment. |
| `npm ci` fails on native dependencies | Read the first error. Confirm full Xcode command-line tools and supported Node are selected; do not delete the lockfile to hide a version mismatch. |
| Web assets missing/old UI | Run `npm run ios:sync` from the repo, then rebuild in Xcode. Editing React source alone does not update the installed app. |
| Missing iOS simulator | Install platform/runtime support from Xcode's destination prompt or Components settings. |
| Swift package resolution stalls | Check network access and use Xcode's package-resolution controls. This project does not require `pod install`. |
| Signing team or bundle ID error | Choose your Apple team and an available bundle ID in the App target. Keep the Capacitor app ID aligned. |
| iPhone absent from destinations | Unlock, pair/trust the Mac, check device management, and enable Developer Mode where required. |
| Setup screen appears instead of dashboard | Expected until a valid secured backend and owner token are supplied. |
| Connection rejected before request | Use an HTTPS origin only, not a path or preview URL. |
| HTTP 401 | The supplied mobile token does not match the server's configured owner token. Do not substitute a Schwab token. |
| HTTP 403 | Origin or endpoint is disallowed. Native origin is `capacitor://localhost`; a browser preview has a different origin. Do not broaden CORS to `*`. |
| HTTP 405/read-only message | This action uses a write/non-GET request and is intentionally unavailable. |
| HTTP 429 | Gateway rate limit or capacity limit; wait and inspect polling/proxy configuration. |
| HTTP 503 at mobile gateway | Backend token is missing or invalid, or another upstream service returned 503. Inspect the sanitized response and server configuration. |
| TLS or certificate error | Fix the domain/certificate chain. Do not disable App Transport Security or enable arbitrary cleartext traffic. |
| Mac localhost works, phone fails | On the phone, localhost is the phone. Use the secured reachable HTTPS backend, not the Mac's localhost address. |
| Health succeeds but panels fail | Check allowlist/method, source auth/entitlements, timestamps, and backend errors separately. |

## Update the app after future code changes

Preserve any local signing/app-ID edits before updating. From the feature-branch
repository, use:

```bash
git status
git pull --ff-only
npm ci
npm run test:mobile
npm run test:calculations
npm run ios:sync
npm run ios:open
```

Then rebuild/run in Xcode. Backend changes require a separate reviewed backend
deployment; installing a new phone bundle does not update the server.
Do not run the full backend merely to refresh native assets.

## First-device acceptance checklist

- [ ] Xcode resolves packages and compiles without errors.
- [ ] Simulator shows the connection screen.
- [ ] iPhone installs with your signing team.
- [ ] Controls fit around the notch/home indicator and keyboard.
- [ ] Invalid origin/token fails without exposing secrets.
- [ ] A secured real gateway accepts the WKWebView preflight and bearer request.
- [ ] Required read panels load and display honest timestamps.
- [ ] Disconnect clears the session and displayed private data.
- [ ] Cellular/Wi-Fi loss and foreground return show safe states.
- [ ] Forbidden actions remain blocked.

Stop at the setup-screen milestone if the backend/security conditions are not
met. A successful personal-device build is useful progress, but it is not a
production security approval or evidence that trading outputs are calibrated.
