# BATCAVE · Pulse Market Intelligence Terminal

> Institutional-grade market intelligence terminal — live options flow with Schwab integration, gamma levels, regime detection, dealer positioning, seasonality analysis, and AI-powered EOD setups.

---

## Overview

BATCAVE is a full-stack market intelligence dashboard built for serious traders. It combines live market data (via Charles Schwab API), options flow analytics, gamma/dealer positioning models, sector correlation analysis, AI-powered trade setups, and curated market commentary into a single terminal.

### Tabs (locked order)

| Tab | Description |
|-----|-------------|
| **Signals** | Put/Call Flow Ratio, Flow Alerts (Schwab live), Index PCR, Mag 7 ratio |
| **Chart** | Interactive price chart with technical overlays |
| **Models** | BATCAVE Daily Model — SPX gamma levels, pivot zones, dealer positioning |
| **Trade Desk** | AI-powered EOD trade setups and intraday scenarios |
| **Regime** | Market regime detection, sector correlation constellation |
| **News** | Curated market news with sentiment scoring |
| **Voices** | Curated commentary from top traders and analysts |
| **Take Five** | 5-minute briefings — macro themes and key levels |

---

## Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS v3, shadcn/ui, TanStack Query v5, Framer Motion, Recharts
- **Backend**: Express.js, SQLite (via Drizzle ORM), `tsx` for dev, `esbuild` for prod
- **Data**: Charles Schwab API (live quotes, option chains), Yahoo Finance (fallback), CBOE (PCR)
- **Fonts**: Bebas Neue (display), DM Sans (body), JetBrains Mono (data), Inter (UI)

---

## Quick Start

### Prerequisites
- Node.js 20+
- A Charles Schwab developer account (optional — Yahoo Finance fallback active when not connected)

### Install & Run

```bash
git clone <repo>
cd sentiment-app
npm install

# Create environment file (copy example and fill in your values)
cp .env.local.example .env.local
# Edit .env.local with your Schwab credentials

# Development
npm run dev          # Vite dev server + Express on port 5000

# Production
npm run build        # Build client + server bundles
NODE_ENV=production node dist/index.cjs
```

The app runs on **http://localhost:5000**.

---

## Environment Variables

Copy `.env.local.example` to `.env.local` and configure:

```env
SCHWAB_CLIENT_ID=your_schwab_client_id
SCHWAB_CLIENT_SECRET=your_schwab_client_secret
SCHWAB_REDIRECT_URI=https://127.0.0.1
```

> `.env.local` is gitignored and never committed. Credentials are stored only locally.

### Obtaining Schwab API Credentials

1. Register at [developer.schwab.com](https://developer.schwab.com)
2. Create a new app — set the redirect URI to `https://127.0.0.1`
3. Copy the Client ID and Client Secret into `.env.local`

---

## Schwab Integration

### OAuth Flow

Connect via the **Settings** dialog (gear icon in top-right header):

1. Click **Open Schwab Login** — this opens the Schwab OAuth authorization page
2. Log in and approve access
3. You'll be redirected to `https://127.0.0.1/?code=...&session=...`
4. Copy the **full redirect URL** and paste it into the Settings dialog
5. Click **Complete Connection**

The access token is stored in the local SQLite database (`data.db`) and auto-refreshes every 20 minutes. Tokens expire after 30 minutes; refresh tokens last 7 days.

### Data Sources

| Feature | Schwab Connected | Schwab Disconnected |
|---------|-----------------|---------------------|
| Quotes (SPY, VIX, indices) | Schwab LIVE | Yahoo Finance (delayed) |
| Price History (charts) | Schwab LIVE | Yahoo Finance (delayed) |
| Option Chains (flow alerts) | Schwab LIVE | **Not available** |
| Gamma Levels (models) | Schwab LIVE | Yahoo Finance (delayed) |

### Flow Alert Types

When Schwab is connected, the Flow Alerts subsystem polls option chains every 30 seconds and flags:

| Alert | Trigger |
|-------|---------|
| `UNUSUAL_VOL` | Volume > 3× open interest on any strike |
| `BLOCK` | Single contract with premium > $1M notional |
| `MAGNET` | Price within 0.5% of highest OI strike |
| `PC_SHIFT` | 5-minute P/C ratio moves >20% |
| `WALL` | Identified call/put wall formation |

---

## Architecture

```
sentiment-app/
├── client/                  # React frontend (Vite)
│   ├── src/
│   │   ├── components/      # All UI components
│   │   │   ├── BatmanLogo.tsx         # Batman SVG logo (BatmanLogo, BatmanLogoFull)
│   │   │   ├── FlowPanel.tsx          # Options flow + alerts panel
│   │   │   ├── FlowAlertsPanel.tsx    # Schwab-driven alerts subsystem
│   │   │   ├── SchwabSettings.tsx     # Settings dialog + SchwabStatusPill
│   │   │   ├── ModelsPanel.tsx        # BATCAVE daily model
│   │   │   ├── LaunchSplash.tsx       # Animated entry screen
│   │   │   └── ...
│   │   ├── pages/
│   │   │   └── dashboard.tsx          # Main dashboard layout
│   │   └── lib/
│   │       └── queryClient.ts         # TanStack Query v5 + apiRequest helper
│   └── index.html
├── server/
│   ├── index.ts             # Express entry point
│   ├── routes.ts            # All API endpoints
│   ├── schwab.ts            # Schwab OAuth + token mgmt + market data helpers
│   └── storage.ts           # SQLite schema + Drizzle ORM
├── shared/
│   └── schema.ts            # Shared types (Drizzle schema + TS types)
├── .env.local               # Real credentials (gitignored, chmod 600)
├── .env.local.example       # Safe template
└── data.db                  # SQLite database (WAL mode)
```

### Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/schwab/status` | Connection status + token expiry |
| `GET` | `/api/schwab/auth-url` | Get OAuth authorization URL |
| `POST` | `/api/schwab/callback` | Exchange auth code for tokens |
| `POST` | `/api/schwab/disconnect` | Revoke tokens |
| `GET` | `/api/market/quotes` | Live quotes (Schwab or Yahoo fallback) |
| `GET` | `/api/market/price-history/:symbol` | Price history for charts |
| `GET` | `/api/market/option-chain/:symbol` | Option chain data (Schwab required) |

### Design Decisions

- **No localStorage/sessionStorage** — all state via TanStack Query + server API
- **`apiRequest` wrapper** — all client-server calls use `@/lib/queryClient.apiRequest`, never raw `fetch`
- **TanStack Query v5** — array query keys, object form throughout
- **Single SQLite token row** — Schwab token stored as row id=1 in `schwab_tokens` table
- **Yahoo Finance fallback** — quotes and price history gracefully degrade when Schwab disconnected
- **No option chain fallback** — flow alerts require Schwab (returns `{error: "schwab_required"}`)

---

## Batman Logo

The `BatmanLogo.tsx` component exports two variants:

- **`BatmanLogoFull`** — full yellow oval with black bat silhouette (LaunchSplash hero, Models header)
- **`BatmanLogo`** / **`BatmanLogoSmall`** — monochrome bat using `currentColor` (header nav, inline uses)

The bat path is drawn on a 200×120 viewBox, matching the classic DC 1989 Burton-era/Dark Knight movie badge silhouette: wide outstretched wings with 3 scalloped trailing-edge curves per side, pointed ear tips, and a belly scallop pattern.

---

## Development

```bash
npm run dev     # Start dev server (hot reload)
npm run build   # Production build
npm run check   # TypeScript type checking
```

### Key Libraries

- `@tanstack/react-query` v5 — server state management
- `framer-motion` — animations (LaunchSplash, transitions)
- `recharts` — charting (flow ratio, price history)
- `drizzle-orm` — SQLite ORM
- `better-sqlite3` — SQLite driver
- `lucide-react` — icons
- `shadcn/ui` — UI component library

---

## License

Private — not for redistribution.
