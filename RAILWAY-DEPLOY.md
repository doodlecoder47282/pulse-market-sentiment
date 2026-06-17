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
SCHWAB_CLIENT_ID = VDMyoxpnxoRMB90ZfvmyAVVIZHAss5oBIL2pdVNhgEIA6SLR
SCHWAB_CLIENT_SECRET = dKNkGWjfa5c2ulDgrqhG8MNZp9dzlZdJUDkcoc4ESH5FjNW9PD8mpLKI7KhmlkWq
SCHWAB_REDIRECT_URI = https://YOUR-RAILWAY-URL/api/schwab/callback
```

You won't know the Railway URL yet — leave the third one as `https://127.0.0.1` for now, we update it in step 6.

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
