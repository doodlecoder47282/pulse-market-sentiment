# Batcave iPhone: first build

For the complete first-time Mac walkthrough, device signing, backend boundaries,
and troubleshooting, read [XCODE_GUIDE.md](XCODE_GUIDE.md). This file remains the
short command reference.

Status: Capacitor project generated and web assets tested in a browser.
Not yet compiled, signed, or tested in Xcode or on a physical iPhone.

## On your Mac

Use Node 22+ and Xcode 26+. This branch pins Capacitor core, CLI, and iOS
to 8.5.2; the CLI requires Node 22+ and the iOS platform targets iOS 15+.
[Capacitor iOS documentation](https://capacitorjs.com/docs/ios)

```bash
# If you do not already have the repo:
git clone --branch feat/capacitor-ios https://github.com/doodlecoder47282/pulse-market-sentiment.git
cd pulse-market-sentiment

# If already cloned, save any local work before switching:
# git fetch origin
# git switch feat/capacitor-ios

# If using nvm:
nvm install
nvm use

npm ci
npm run test:mobile
npm run ios:sync
npm run ios:open
```

`ios:sync` builds ONLY the native web bundle and syncs it into the existing
Xcode project. It does not start the backend, call market providers, or
require brokerage credentials. Do not run `cap add ios` again.

This project uses Swift Package Manager, not CocoaPods. The project is
`ios/App/App.xcodeproj`. Let Xcode resolve the pinned packages.

In Xcode:

1. Select the **App** target, then **Signing & Capabilities**.
2. Select your Apple development team and enable automatic signing.
3. If needed, replace `com.batcave.terminal` with a bundle identifier available
   to your team. Keep `appId` in `capacitor.config.ts` and the Xcode identifier
   aligned if you change it.
4. Select an iPhone simulator or your connected iPhone. Run.
5. Expect the **Connect terminal** screen, not live data. No backend credentials
   are bundled. The first native build is read-only.

Apple supports personal-device testing through Xcode with a free Apple Account;
Personal Team provisioning expires after seven days. TestFlight/App Store
distribution is a separate step.
[Apple membership comparison](https://developer.apple.com/support/compare-memberships/)

## Backend connection

The phone requires a permanent HTTPS origin serving this branch's gateway:

- `GET /api/mobile/health`: authenticated gateway handshake.
- `GET /api/mobile/...`: explicitly allowlisted read endpoints, routed internally
  to existing handlers.
- Other methods and brokerage-management endpoints are denied.
- Native origin allowlist: `capacitor://localhost`. CORS is not authentication;
  every data request also needs the bearer token.

On the server, generate a separate random mobile token using a local secret
manager or `openssl rand -hex 32`. Set it as `BATCAVE_MOBILE_TOKEN` in the
server's environment, then restart the backend. Do not commit it, put it in a
`VITE_` variable, paste it into chat, or reuse a Schwab credential.

Enter the HTTPS origin and that mobile token in the iPhone connection screen.
The token remains in process memory only. Disconnecting or restarting the app
clears it. There is no Keychain persistence in this milestone.

No live backend was configured or exposed as part of this build.

### Important deployment boundary

The existing full web server is NOT newly secured by this mobile middleware.
Do not expose the whole origin publicly. A production reverse proxy must expose
only `/api/mobile/` from this server, terminate valid HTTPS, and apply rate limits.
Keep legacy `/api/` routes and administrative access private. Do not assume that
CORS or the read-only phone interface protects the legacy web endpoints.

The gateway's owner token is for a personal prototype, not multi-user identity.
Before public distribution: rotate previously exposed brokerage credentials,
finish an end-to-end server security review, and implement proper user identity,
session expiry/revocation, and per-user authorization.

## What this first build does and does not do

- Reuses the existing terminal and tab order after an authenticated handshake.
- Shows setup, validation, connection-error, session-expiry, and offline states.
- Clears query caches when disconnecting and refreshes queries on foreground return.
- Blocks mobile write requests on both the client and server.
- Does not provide trading, account linking, saved edits, push notifications,
  background market collection, or offline market-data storage.
- Some existing panels use POST for computations or saved actions; those remain
  unavailable in this read-only milestone and may show the explicit read-only error.
- A connected gateway is not proof of fresh market data or a calibrated signal.

## Verification checklist

Automated gateway/session tests cover token validation, backend URL validation,
unauthorized requests, origin restrictions, authenticated routing, read-only
methods, unknown/sensitive endpoints, disabled gateway, and web-route preservation.

Before treating the native app as usable, verify on the Mac/iPhone:

- Xcode compilation, package resolution, automatic signing, and device install.
- Real WKWebView CORS preflight and bearer authentication over HTTPS.
- All required read-only panels with live authenticated data.
- Safe areas, keyboard entry, rotation, external links, foreground return.
- Wi-Fi/cellular loss, expired or revoked tokens, reconnect, and disconnect.

Browser UI tests and generated Xcode source do not replace these device checks.
Repository-wide TypeScript and dependency-audit issues remain tracked separately.
