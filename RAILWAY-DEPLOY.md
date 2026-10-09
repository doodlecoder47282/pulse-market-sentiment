# Deploy Pulse to Railway

This puts Pulse on Railway's infrastructure — runs 24/7, no GCP Akamai block, no PC dependency.

## What this gets you

- Pulse running at a public URL like `pulse-batcave.up.railway.app`
- Schwab connects from Railway's IP (not blocked)
- Server stays up when your PC is off
- Auto-redeploys when you push to GitHub
- ~$5/month after $5 free credit

Market data: Schwab only (quotes, chains, price history, index levels). There
is no CBOE or other fallback; when Schwab is disconnected or refuses a request,
market panels show "unavailable" (or a cached Schwab payload with its age,
within the max ages in `server/schwabDataPolicy.ts`). Check `/api/schwab/diag`
for cooldowns, stale serves and chain request sizes.

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

Also add the token encryption key. Schwab OAuth tokens are stored in
`data.db` encrypted with AES-256-GCM under this key. On a reachable bind
(Railway) without it, token storage is locked: Schwab Connect refuses to
save tokens and Settings shows "Token storage locked" with the reason.

```
BATCAVE_TOKEN_KEY = <exactly 32 random bytes, base64, not hex: openssl rand -base64 32>
```

- The value must be base64, not hex (`openssl rand -hex 32` gives 64 hex
  characters, which is rejected). Keep it out of chat, git and logs, like
  the access key. Losing it means the stored tokens cannot be decrypted:
  Settings says so and one Schwab reconnect stores fresh tokens.
- Rotation: move the old value to `BATCAVE_TOKEN_KEY_PREVIOUS`, set a new
  `BATCAVE_TOKEN_KEY`, restart. The row is re-encrypted on the next read;
  then remove `BATCAVE_TOKEN_KEY_PREVIOUS`.
- Existing plaintext tokens are encrypted in place on first read (the old
  page is zeroed and the WAL truncated). If the server is locked (no key)
  while a plaintext row is still in `data.db`, Settings says "plaintext
  tokens still on disk: set BATCAVE_TOKEN_KEY or disconnect"; Disconnect
  secure-deletes the row.
- Copies made before encryption (`backups/`, any downloaded `data.db`)
  still hold plaintext tokens. A plaintext refresh token in such a copy
  stays usable until it expires (about 7 days after it was issued) unless
  Schwab revokes it; reconnecting here does not revoke it. Treat backups
  as secrets: keep them off shared drives and delete pre-encryption ones.
- Locally (127.0.0.1) without the env key, the server generates a key file
  once at `~/.batcave/token.key` (mode 0600, outside the repo and `data/`,
  path override `BATCAVE_TOKEN_KEY_FILE`) and logs the path, never the key.
  Plaintext storage needs an explicit `BATCAVE_TOKEN_PLAINTEXT_OK=1`
  (loopback only).
- Trust proxy: on Railway/Render/Fly the server trusts exactly one proxy hop
  (`X-Forwarded-For`) so the wrong-key slowdown is counted per client, not
  per proxy. Override with `BATCAVE_TRUST_PROXY_HOPS` (0 disables) only if
  the platform puts more hops in front; see server/index.ts for the
  spoofing trade-off.
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
- Tokens save to `data.db` on the container disk, encrypted with
  `BATCAVE_TOKEN_KEY`. They survive restarts; a redeploy without a Railway
  volume starts with an empty disk and needs one reconnect

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
A promoted model is demoted back to the baseline cone when a later retrain re-scores
it on newer out-of-sample days and it fails the same rule, or when its live 10-90%
coverage is rejected (Kupiec p < 0.01 with at least 20 scored days at any horizon;
the server calls the sidecar's `POST /demote`). There is no historical backfill: the
old CBOE / Alpha Vantage `backfill.py` is removed (Schwab-only market data), so
`PULSE_ML_BACKFILL_ON_BOOT` does nothing but log that.

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
