# Batcave public demo (sample data)

A public link anyone can open before subscriptions exist. It runs the full app
on a **simulated market** (`server/demoMarket.ts`): every price, option chain,
flow alert and score is sample data, and every screen says so.

| | Demo | Your own deployment |
|---|---|---|
| Market data | Simulated (deterministic, follows the real exchange calendar) | Your Schwab account |
| Schwab sign-in | Refused | Yes |
| Access key | Not needed (read-only) | Required on a public URL |
| Trade setups, Discord cards | Off (investor-edition limits) | Personal edition only |
| News, calendar, crypto | Live public sources | Live public sources |

## What visitors see

- A strip at the top of every screen: **SAMPLE DATA · simulated market, not
  real prices**. It sits in the sticky header, so it never scrolls away.
- The status pill reads **SAMPLE DATA**; freshness chips credit "Sample", not
  Schwab; live badges read **SAMPLE**.
- Settings explains the demo and has no Schwab sign-in.
- The whale-flow panel shows a few **sample sweeps** a day (`demoSweeps` in
  `server/demoMarket.ts`): 1-3 DTE blocks of $4M-$10M lifted at the ask on
  thin strikes at a fixed session minute, one to three on SPX/SPY/QQQ and up
  to two on a single name when it has a 1-3 DTE expiry. They are the only
  contracts whose volume exceeds open interest by the whale gate's 15x; the
  rest of the chain trades its formula volume. Nothing is shown before the
  open or in the first 15 minutes of the session.

## Safety rules the code enforces

- `BATCAVE_EDITION=demo` makes `server/schwab.ts` answer from the simulator:
  Schwab is never called, stored tokens are ignored, sign-in and the OAuth
  callback are refused, the streamer stays off.
- `/api` is read-only for visitors (`makeDemoReadOnly` in
  `server/accessGate.ts`): only GET plus four pure calculations
  (position sizer, Heatseeker levels, edge survival, snapshot refresh). The
  server's own schedulers (loopback) still run.
- No access key is needed (`gateMode` = `open-demo`); setting
  `BATCAVE_ACCESS_KEY` makes it a private demo instead.

## Deploy it (a second Railway service, separate from your real one)

Never set `BATCAVE_EDITION=demo` on your real deployment, and never point the
demo at your real data volume: simulated alerts would mix with real ones.

1. Railway → your project → **New** → **GitHub Repo** →
   `pulse-market-sentiment`, branch `main`. This creates a second service.
2. Variables on the new service, and only these:
   ```text
   BATCAVE_EDITION = demo
   PULSE_ML_AUTOSTART = 0
   ```
   Do not add Schwab, Discord, Anthropic, FRED or token variables. The demo
   needs none, and a public demo must not be able to spend on keyed services.
3. Settings → Networking → **Generate Domain**. That URL is the public link.
4. Optional: attach a small volume at `/app/data` so the demo's sample alert
   history survives redeploys. Without it the history restarts on each deploy.

Cost: the second service counts against your Railway usage. Check
Railway → Usage after a day.

## Check it

- `https://<demo-domain>/api/health` shows `"edition":"demo"`.
- The site opens with no access key and shows the SAMPLE DATA strip.
- `https://<demo-domain>/api/schwab/auth-url` answers 403.
- iPhone app: type the demo URL into "Connect to your Batcave server".

## Put a "Try the demo" button in the iPhone app

GitHub → repo Settings → Secrets and variables → Actions → **Variables** →
New variable `BATCAVE_DEMO_URL` = the demo's https address (not a secret).
Then edit `.github/ios-build.txt` (any change) so CI rebuilds the Xcode zip;
the app's first screen then offers **Try the demo**, and the demo's Settings
offers **Use my own Batcave server** to switch back.
