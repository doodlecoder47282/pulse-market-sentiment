BATCAVE / Pulse — Self-Heal Spec
Operational spec for keeping the Pulse instance healthy without third-party infrastructure. Local Node server on port 5000, Schwab primary + CBOE fallback, internal cron and restore script. No Railway, no tunnels, no external hosts.
---
1. Healthcheck Endpoints
Three endpoints on the Node backend. All shapes are contracts — clients depend on them.
GET /api/health
Primary target for cron and the self-heal dashboard.
{
"serverUp": true,
"schwab": {
"connected": true,
"needsReauth": false,
"expiresIn": 1781,
"lastRefreshError": null
},
"backups": {
"envPresent": true,
"envMode": "600",
"envSize": 412
},
"build": {
"gitSha": "76b9b47",
"builtAt": "2026-07-08T20:24:00Z"
}
}
GET /api/schwab/status
Existing endpoint, guaranteed shape:
{
"connected": true,
"needsReauth": false,
"expiresIn": 1781,
"lastRefreshError": null
}
Maps directly into health.schwab.
GET /api/heatmap/thermal
Regime tab data source.
{
"cells": [{ "x": 0, "y": 0, "value": 12500000, "label": "7480C" }],
"lagged": false,
"asOf": "2026-07-13T20:00:00Z"
}
If Schwab is down but CBOE fallback is available, still return cells with lagged: true and a 15-minute delayed asOf.
---
2. Health Cron + Thresholds
Internal job (or external cron hitting /api/health).
Schedule: weekdays only, every 5 minutes 06:50–08:10 ET (410–490 minutes past midnight). Guards against the DST double-fire.
Per run:
•	Hit /api/health with 2–3s timeout
•	Classify:
green: serverUp && schwab.connected && !schwab.needsReauth && backups.envPresent
yellow: server up, backups ok, but Schwab disconnected or needsReauth; CBOE fallback live
red: !serverUp or /api/health times out, or !backups.envPresent
•	Write each run to cron_tracking/<instance_id>/run_YYYY-MM-DD_HHMMET.json
---
3. Self-Heal Actions (ordered)
If red (server failure)
1.	Run local RESTORE.sh / START.sh:
•	git pull (optional)
•	npm install (first boot only)
•	npm run build
•	node dist/index.cjs on port 5000
2.	Recheck /api/health
3.	If still red → mark manual intervention required, notify in-app
If yellow (Schwab degraded)
1.	Do NOT auto-reauth
2.	Expose flag in app (Settings + global banner): "schwab disconnected — reauth required before open"
3.	Keep CBOE fallback on for SPX/QQQ with 15-min lag
4.	Once user completes reauth, /api/schwab/status flips connected: true and health returns to green
If green
Log run, no action.
---
4. Schwab Reauth Flow
Endpoints
GET /api/schwab/auth-url
Returns: https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=…&redirect_uri=https%3A%2F%2F127.0.0.1
POST /api/schwab/callback
Body: { "redirectedUrl": "https://127.0.0.1/?code=…&session=…" }
CRITICAL:
•	Param name is redirectedUrl — NOT url. This was the recurring bug.
•	Reject codes older than ~30 seconds (Schwab TTL).
•	Persist access_token + refresh_token in .env.local (never in git).
Client behavior
•	When /api/schwab/status returns needsReauth: true:
•	Show "Connect Schwab" CTA in Settings + global banner
•	CTA calls GET /api/schwab/auth-url, opens URL in real browser
•	User pastes the https://127.0.0.1/?code=… redirect back into app
•	App POSTs to /api/schwab/callback with { redirectedUrl } immediately
•	On success, refresh /api/schwab/status and /api/health
---
5. UI Contract (post-resume expectations)
•	Tab order LOCKED: Signals, Chart, Models, Heatseeker, Trade Desk, Regime, Cosmos, News, Take Five, Edge Lab. Never reordered, never renamed.
•	Regime headline banner: sticky top, present across all tabs, driven by /api/regime/headline. Visible, non-blocking, always renders after build resume.
•	Regime thermal heatmap: Regime tab, driven by /api/heatmap/thermal. Expects cells array; on shape mismatch show inline error but keep tab stable. Scrollable, live data from Schwab dealer positioning (or CBOE fallback if degraded).
---
6. Secrets and Privacy
•	Repo stays private on GitHub.
•	Never commit: Schwab CLIENT_ID, CLIENT_SECRET, refresh/access tokens, local REDIRECT_URI secrets.
•	Store in .env.local (git-ignored) or encrypted secret storage.
•	Self-heal reports on:
•	backups.envPresent — file exists
•	backups.envMode — file mode (600 on *nix)
•	backups.envSize — non-zero
---
7. Locked Rules
•	NO third-party services. No Railway. No ngrok. No Cloudflare tunnels. Everything in-thread.
•	System is "Batcave" — never "Selz".
•	Never edit: signals.ts, regime.ts, dfi.ts, models.ts, composite.ts, PreMarketGate.tsx.
•	Schwab-only primary data. CBOE fallback OK. No Yahoo.
•	No emojis. Lowercase peer-to-peer voice. EV / probability framing.
---
8. Cron IDs (existing)
•	bbead8fa — Pulse pre-market health check (weekdays 7am ET window, in-app notif)
•	ecdd712a — Pulse auto-heal (every 15min market hours, restart on failure)
