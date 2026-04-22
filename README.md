# Pulse — Market Sentiment

Professional-grade market sentiment dashboard for traders. Live quotes, options flow, regime detection, sector heatmaps, and more — all in one place.

![8 tabs](https://img.shields.io/badge/tabs-8-blue) ![realtime](https://img.shields.io/badge/quotes-5s%20poll-green) ![stack](https://img.shields.io/badge/stack-react%20%2B%20express-black)

## Features

- **Signals** — Mag7 live strip, options flow panel, macro ticker, metric cards
- **Chart** — TradingView widget + custom candlestick charts with ticker search
- **Models** — positioning/regime models with visual gauges
- **Trade Desk** — ticker context, news, unusual flow per symbol
- **Regime** — market regime classification with detail breakdowns
- **News** — curated financial news feed
- **Voices** — aggregated commentary and analyst opinions
- **Take Five** — end-of-day 5-point market wrap

Plus: live clock + market-open/closed pill in the header, keyboard shortcuts (press `?` to see them), SPY/VIX flashing on every tick, lazy-loaded heavy panels, error boundaries on every fetch, and full mobile responsive layout.

---

## Local development

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Opens on `http://localhost:5000`.

## Production build

```bash
npm run build
npm start
```

---

## Deploy to Railway (recommended — free tier)

1. Sign in at [railway.app](https://railway.app) with your GitHub account
2. Click **New Project → Deploy from GitHub repo**
3. Select this repo
4. Railway auto-detects Node, runs `npm install && npm run build`, and starts with `npm start`
5. In **Settings → Networking**, click **Generate Domain** to get a public URL

### Environment variables

None required. The app uses Yahoo Finance public endpoints (no API key needed).

If you later add a paid data feed (Polygon, IEX, etc.), drop keys into Railway's Variables tab — they'll be injected as env vars and read by `server/routes.ts`.

### Build/start commands (Railway auto-detects these)

- Build: `npm run build`
- Start: `npm start`
- Port: Railway provides `PORT` env var; app listens on `process.env.PORT || 5000`

---

## Deploy to Render (alternative)

Same idea. Pick "Web Service", connect repo, set build command to `npm run build` and start command to `npm start`. Free tier available.

---

## Deploy to Vercel (frontend-only, NOT recommended for this app)

Vercel works for static sites but this app has an Express backend (`/api/snapshot`, `/api/quotes`). Railway/Render/Fly are better fits.

---

## Stack

- **Frontend:** React 18 + Vite + Tailwind CSS + shadcn/ui + TanStack Query + wouter
- **Backend:** Express + better-sqlite3 + Drizzle ORM
- **Data:** Yahoo Finance (unofficial, free) for quotes, options, fundamentals
- **Deploy:** Railway / Render / Fly.io

## Data source note

Yahoo Finance data is free for personal use. If you plan to **commercialize** this (charge users for access), you must switch to a licensed feed like [Polygon](https://polygon.io), [Databento](https://databento.com), or [IEX Cloud](https://iexcloud.io) first. Swap the helpers in `server/` accordingly.

## License

Personal use.
