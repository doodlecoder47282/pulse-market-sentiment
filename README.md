# Pulse — Market Intelligence Terminal (BATCAVE)

Pulse is an institutional-grade market intelligence terminal built for active equity and options traders. It aggregates live options flow, dealer gamma exposure, volatility term structure, regime detection, seasonality research, and AI-powered end-of-day trade setups into a single dark-mode dashboard with direct Charles Schwab integration.

**Core features:** Signals tab (composite sentiment gauge, dealer gamma structure, VIX term structure, social chatter, Fear & Greed), Chart tab (live candlestick with gamma level overlays), Models BATCAVE (AI model runners), Trade Desk (EOD Play Maker with AI narrative, gamma map, pivot table, squeeze detector), Regime (seasonality research + dark knight bat levels), News (ALPHA AI briefing), Voices (trader commentary), Take Five (rapid-fire analysis).

---

## Quick Start

```bash
git clone https://github.com/tankanthony6/sentiment-app.git
cd sentiment-app
npm install
npm run dev
```

The app starts at `http://localhost:5000`. The backend (Express) and frontend (Vite/React) run on the same port.

---

## Connecting Charles Schwab (Live Options Flow)

The app supports live options flow data via the Schwab Individual Developer API.

### Step 1 — Create a Schwab developer app

1. Go to [developer.schwab.com](https://developer.schwab.com) and sign in with your Schwab brokerage account.
2. Click **Create App** and fill in:
   - **App Name**: anything (e.g. "Pulse Terminal")
   - **Callback URL**: `http://localhost:5000/api/schwab/callback`
   - **Order Execution**: not required — select read-only access only
3. After approval (can take 1–3 business days), note your **App Key** (client ID) and **App Secret**.

### Step 2 — Add credentials to `.env.local`

Create `/home/user/workspace/sentiment-app/.env.local` (never committed):

```env
SCHWAB_CLIENT_ID=your_app_key_here
SCHWAB_CLIENT_SECRET=your_app_secret_here
SCHWAB_REDIRECT_URI=http://localhost:5000/api/schwab/callback
```

### Step 3 — Authorize in the app

1. Start the dev server: `npm run dev`
2. Open the dashboard and click the **YAHOO** / **SCHWAB** status pill in the header (top right).
3. In the Settings dialog, click **Connect Schwab**.
4. You'll be redirected to Schwab's OAuth page — log in and approve.
5. The pill turns green (**SCHWAB LIVE**) once connected. Tokens auto-refresh.

---

## Connecting AI Models (EOD Play Maker + ALPHA)

The **EOD Play Maker** (Trade Desk tab) and **ALPHA** (News tab) use LLM APIs to generate trade narratives and news briefings.

### Required API keys

Add to `.env.local`:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

> **Note for Perplexity Computer deployments:** API credentials are injected automatically via the `api_credentials=["llm-api:website"]` preset — you do not need to provide keys manually. For standalone deployments outside Perplexity Computer, you will need your own OpenAI and Anthropic API keys as shown above.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `SCHWAB_CLIENT_ID` | Optional | Schwab app key (enables live flow) |
| `SCHWAB_CLIENT_SECRET` | Optional | Schwab app secret |
| `SCHWAB_REDIRECT_URI` | Optional | OAuth callback URL |
| `OPENAI_API_KEY` | Optional | OpenAI key (EOD Play Maker, ALPHA) |
| `ANTHROPIC_API_KEY` | Optional | Anthropic key (EOD Play Maker, ALPHA) |

The app runs fully without any of these — it falls back to Yahoo Finance for quote data and disables AI features.

---

## Running Locally

```bash
npm run dev        # Development — hot reload, Vite dev server on port 5000
npm run build      # Production build → dist/
npm run check      # TypeScript type check
```

---

## Deploying

### Static + backend (recommended)

The backend runs Express on port 5000. Build and serve:

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

Set all environment variables in your hosting environment. The `dist/public` directory contains the compiled frontend.

### Docker (optional)

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm ci && npm run build
ENV NODE_ENV=production
CMD ["node", "dist/index.cjs"]
EXPOSE 5000
```

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript |
| UI components | shadcn/ui + Tailwind CSS v3 |
| State / data fetching | TanStack Query v5 |
| Routing | wouter (hash-based) |
| Backend | Express.js + TypeScript |
| Database | SQLite via Drizzle ORM + better-sqlite3 |
| Charts | Recharts + lightweight-charts |
| Animation | Framer Motion |
| Fonts | Bebas Neue (display), DM Sans (body), JetBrains Mono (data), Inter (UI) |

---

## License

Private. All rights reserved.
