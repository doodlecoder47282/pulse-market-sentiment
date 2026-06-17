# Pulse Batcave — Local Setup Guide

Run the full market intelligence terminal on your home machine with your own Schwab credentials. No sandbox, no geoblock, live data from your account.

---

## What you need

- **Node.js v18 or newer** — download from [nodejs.org](https://nodejs.org) (LTS version works)
- **A Charles Schwab developer account** — sign up at [developer.schwab.com](https://developer.schwab.com)
- **Your Schwab App Key + App Secret** (5–10 min to create, may take 1–3 days for approval)

---

## First-time setup (~5 minutes after Schwab approval)

### 1. Extract the zip

Unzip `Pulse-Local.zip` anywhere — your Desktop, Documents, wherever. You'll get a folder called `sentiment-app`.

### 2. Create your Schwab developer app

1. Go to [developer.schwab.com](https://developer.schwab.com) and sign in with your Schwab brokerage login.
2. Click **Add an App** (or **Create App**).
3. Fill in:
   - **App Name**: anything, e.g. `Pulse Local`
   - **Callback URL**: `http://localhost:5000/api/schwab/callback`
   - **Product**: Individual Trader API
   - Order execution: not needed — read-only is fine
4. Note your **App Key** (= Client ID) and **App Secret** after approval.

### 3. Add your credentials

Inside the `sentiment-app` folder:

1. Copy `.env.local.template` → `.env.local`
2. Open `.env.local` in any text editor (Notepad, TextEdit, VS Code)
3. Replace the placeholders:

```
SCHWAB_CLIENT_ID=your_app_key_here
SCHWAB_CLIENT_SECRET=your_app_secret_here
SCHWAB_REDIRECT_URI=http://localhost:5000/api/schwab/callback
```

Save the file. **Never share or commit `.env.local`** — it stays local.

### 4. Start the app

**Mac / Linux:**
```bash
bash START-PULSE.sh
```

**Windows:**
Double-click `START-PULSE.bat`

On first run it installs npm packages (~1 min) and builds the app (~30s). Subsequent starts take ~5 seconds.

### 5. Open in browser

Go to **http://localhost:5000**

### 6. Connect Schwab inside the app

1. Click the **SCHWAB** status pill in the top-right header.
2. In the Settings panel, click **Connect Schwab**.
3. You'll be redirected to Schwab's OAuth page — log in and approve.
4. The pill turns green (**SCHWAB LIVE**). Live options flow starts immediately.

---

## Stopping the app

Press **Ctrl+C** in the terminal / command prompt window.

---

## Restarting after first run

Just run the start script again — no reinstall, no rebuild (unless you've updated the source).

---

## Optional: AI features (EOD Play Maker + ALPHA briefing)

Add these to `.env.local` for AI-powered trade narratives and news briefings:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

The app works fine without them — AI panels show a fallback message.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 5000 already in use | Add `PORT=5001` to `.env.local`, update Schwab callback URL to match |
| Schwab says "invalid callback URL" | Make sure the URL in your Schwab app settings exactly matches `SCHWAB_REDIRECT_URI` in `.env.local` |
| `node: command not found` | Install Node.js from nodejs.org |
| npm install fails | Try `npm install --legacy-peer-deps` |
| App loads but shows "Schwab offline" | Click the status pill → Connect Schwab → authorize |

---

## What's in this package

```
sentiment-app/
├── client/          React frontend (Vite + Tailwind)
├── server/          Express backend + Schwab OAuth
├── shared/          Shared types
├── scripts/         Build helpers
├── .env.local.template   Credential template (fill this in)
├── START-PULSE.sh   Mac/Linux launcher
├── START-PULSE.bat  Windows launcher
├── RESTORE.sh       Sandbox restore script (for dev environment)
├── README-LOCAL.md  This file
└── package.json
```

---

## Updating

To get the latest version, replace the contents of `sentiment-app/` with a fresh unzip of a new `Pulse-Local.zip`. Your `.env.local` stays separate and won't be overwritten.
