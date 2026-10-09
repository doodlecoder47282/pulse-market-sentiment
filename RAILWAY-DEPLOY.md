# Deploy Pulse to Railway

This puts Pulse on Railway's infrastructure — runs 24/7, no GCP Akamai block, no PC dependency.

## What this gets you

- Pulse running at a public URL like `pulse-batcave.up.railway.app`
- Schwab connects from Railway's IP (not blocked)
- Server stays up when your PC is off
- Auto-redeploys when you push to GitHub
- ~$5/month after $5 free credit

## Steps

### 1. Sign up
- Go to [railway.app](https://railway.app)
- Click "Login" top-right
- Choose "Login with GitHub"
- Authorize Railway to read your repos

### 2. Create the project
- Click "New Project" (purple button)
- Pick "Deploy from GitHub repo"
- Search and select `doodlecoder47282/pulse-market-sentiment`
- Railway auto-detects the build (it'll see railway.json)

### 3. Wait for first build (~3 min)
- Railway runs: `npm install && npm run build`
- Then: `npm start`
- Watch the Build Logs tab — should end with "serving on port..."
- If it fails: copy the error and paste back here

### 4. Add environment variables
- Click your service → "Variables" tab
- Click "+ New Variable" three times, paste:

```
SCHWAB_CLIENT_ID = YOUR_SCHWAB_CLIENT_ID
SCHWAB_CLIENT_SECRET = YOUR_SCHWAB_CLIENT_SECRET
SCHWAB_REDIRECT_URI = https://YOUR-RAILWAY-URL/api/schwab/callback
```

You won't know the Railway URL yet — leave the third one as `https://127.0.0.1` for now, we update it in step 6.

Also add the access key. On Railway the server binds 0.0.0.0, so without a
key it fails closed: every `/api` call except `/api/health` returns 503.

```
BATCAVE_ACCESS_KEY = <a long random value, 32+ characters, e.g. from: openssl rand -hex 32>
```

The web app asks for this key once per browser. Never paste the key into
chat or commit it. `BATCAVE_ALLOW_OPEN=1` runs the server with no key on
purpose (anyone with the URL can use it); do not set it on Railway.
Discord cards are optional: set `PULSE_DISCORD_WEBHOOK` (and the
`PULSE_DISCORD_*_WEBHOOK` variants listed in `.env.local.example`) to
`https://discord.com/api/webhooks/...` URLs; unset or malformed values
disable that card.

### 5. Generate public URL
- Click "Settings" tab → "Networking" → "Generate Domain"
- Railway creates something like `pulse-batcave-production.up.railway.app`
- Copy that URL

### 6. Update Schwab redirect_uri
- Update Railway env var `SCHWAB_REDIRECT_URI` to: `https://YOUR-RAILWAY-URL.up.railway.app`
- Go to [developer.schwab.com](https://developer.schwab.com) → your app → Edit
- Change the Callback URL to the EXACT same Railway URL
- Save. Schwab may take a few min to propagate the change.

### 7. First reauth (the moment of truth)
- Open `https://YOUR-RAILWAY-URL.up.railway.app` in any browser
- Hit Schwab Connect button
- Login + approve
- Schwab redirects to Railway → Railway calls Schwab from its IP → ✅ works
- Tokens save to Railway's environment, persist across restarts

## After this point

Schwab reauth happens once a week via the Connect button in the app, from any device. No curl. No Shortcut. No code pasting. No PC required.

When you push code to GitHub, Railway auto-rebuilds and redeploys in ~2 min.

## ML sidecar (Projected Path model): optional, not installed by default

The Railway build above is Node only (`railway.json`: `npm install && npm run build`).
It does not install Python or the packages in `ml_service/requirements.txt`, so the
FastAPI sidecar (`ml_service/app.py`, normally spawned by `server/mlServiceManager.ts`)
cannot start there. That is a supported state, and the server says so instead of
failing silently:

- `GET /api/ml/health` returns 503 with `"error": "ML sidecar not installed"` and the
  missing piece (`python not runnable`, or `missing Python packages: ...`).
- The Projected Path panel draws the baseline volatility cone (computed in Node, no
  sidecar needed), labeled with that reason.
- Feature and band logging and the live 10-90% coverage table keep running (Node and
  SQLite only).
- The weekly retrain logs `[ml:retrain:skipped] ML sidecar not installed: ...`.
- Set `PULSE_ML_AUTOSTART=0` to stop the spawn attempts; set `PULSE_ML_DATALOG=0` to
  stop the logger.

Persistence matters more than the sidecar. The logger writes `ml_feature_log`,
`spx_minute_bars` and `ml_forecast_log` into `data.db` in the working directory.
Schwab serves only about 10 days of minute history, so these rows are the only real
training set. A Railway container's filesystem is replaced on every deploy: without a
Railway volume holding `data.db` (and `ml_service/models/` if you retrain there), the
collected days are lost on each redeploy and the 60-session training gate is never met.

To run the sidecar on Railway (not verified on Railway; changes the build, so decide
before doing it): add a `nixpacks.toml` next to `railway.json` that keeps the Node
plan and adds Python and a virtualenv where `mlServiceManager.ts` looks for it
(`ml_service/.venv/bin/python`):

```toml
[phases.setup]
nixPkgs = ['...', 'python311']

[phases.install]
cmds = ['...', 'python3 -m venv ml_service/.venv', 'ml_service/.venv/bin/pip install -r ml_service/requirements.txt']
```

(`'...'` keeps the generated Node steps; syntax per https://nixpacks.com/docs/configuration/file.)
LightGBM's wheel needs the OpenMP runtime (`libgomp.so.1`); if the sidecar log shows it
missing, add it to the image. Then check `GET /api/ml/health` returns `ok: true`.
Alternatively run the sidecar elsewhere and point the server at it with
`PULSE_ML_URL=https://...` and `PULSE_ML_AUTOSTART=0`.

A retrain writes a new quantile model only after 60 qualifying real sessions, and the
panel draws it only if it beats the baseline cone out of sample (promotion gate in
`ml_service/forecast_eval.py`). Until then the baseline cone is what you see.

## Troubleshooting

**Build fails on "npm run build":**
- Check Logs tab for the actual error
- Most common: a missing `npm install` dep — Railway should handle it, but if not, paste the error here

**App loads but Schwab Connect 500s:**
- Almost always: SCHWAB_REDIRECT_URI in Railway env doesn't EXACTLY match the one in developer.schwab.com
- Both must be `https://` (not http), both must be the same casing

**Schwab "invalid_client" error:**
- Re-paste CLIENT_ID and CLIENT_SECRET in Railway, no spaces, no quotes

**Build runs forever:**
- Railway free tier has memory limits — if build hangs, contact me, we'll add a `nixpacks.toml` to throttle

## Cost watch

Free $5 of credit on signup. Pulse uses ~$3–5/mo at idle. Watch the "Usage" tab. If it gets expensive (rare unless we add heavy data feeds), tell me and we tighten things up.
