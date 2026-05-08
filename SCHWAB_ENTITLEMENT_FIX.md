# Schwab Chains 403 — Entitlement Fix Checklist

**Date:** May 8, 2026
**Status:** Quotes ✅ pricehistory ✅ chains ❌ (403 forbidden)

## What's working

After the symbol map + backoff fix (commit `a8d7cb8`), Schwab is returning live data for:

| Endpoint | Symbols verified | Status |
|---|---|---|
| `marketdata/v1/quotes` | SPY, QQQ, DIA, IWM, $VIX, $VVIX, $VIX9D, $VIX3M, $SKEW, $SPX, gold, bonds, credit | ✅ working |
| `marketdata/v1/pricehistory` | SPY, $SPX (390 candles confirmed) | ✅ working (intermittent, see notes) |
| `marketdata/v1/chains` | SPY, SPX, NVDA, TSLA, etc. | ❌ persistent 403 |

## Root cause hypothesis

Your Schwab Developer **app registration** is missing the **"Market Data Production"** API product, OR has it but options-chain entitlement is throttled separately.

Schwab Developer Portal lets you select per-app:
- **Accounts and Trading Production** — read positions, place orders
- **Market Data Production** — quotes, pricehistory, chains, movers

Quotes are working, which means SOME market data permission is enabled. But chains may be a separate sub-entitlement (OPRA options data has its own subscription tier — see [Schwab Market Data Pricing Guide](https://content.schwab.com/web/scs/pdf/AS_MarketData_Pricing_Guide_v4.pdf), which lists "OPRA Pro" at $31.50/mo separate from base quotes).

## Action items — do these in order

### 1. Verify your app's API products (5 min)

1. Go to [https://developer.schwab.com](https://developer.schwab.com)
2. Sign in → **Dashboard** → find your registered app (the one whose `client_id` is in your `.env` as `SCHWAB_CLIENT_ID`)
3. Click into the app → check the **API Products** section
4. **Confirm both are checked:**
   - `Accounts and Trading Production`
   - `Market Data Production`
5. If `Market Data Production` is missing or shows pending/denied status → that's your problem

### 2. Check for app status / approval issues (3 min)

In the app dashboard, look for:
- Status: should be **"Approved"** or **"Ready for Use"**, not "Pending" or "Submitted"
- Any red error banners
- Daily/monthly quota meters (Schwab shows these per app)

### 3. Confirm individual developer agreement is signed (3 min)

[About the Individual Developer Role](https://developer.schwab.com/user-guides/individual-developer/about-individual-developer-role) — make sure you've accepted the **Individual Developer Subscriber Agreement** specifically. Some users report chains 403 until this exact agreement is signed (separate from the standard Terms).

### 4. If all above are correct — email Schwab API support

Subject: `Market Data API — chains endpoint 403 forbidden, quotes/pricehistory working`

Body template:

> Hi Schwab API team,
>
> My registered app `[YOUR_CLIENT_ID]` is successfully calling `marketdata/v1/quotes` and `marketdata/v1/pricehistory` for both equities and cash indexes ($VIX, $SPX). However, every call to `marketdata/v1/chains` returns HTTP 403 Forbidden, regardless of symbol (SPY, NVDA, $SPX, etc).
>
> Token is valid (proven by working quotes calls on the same Bearer). Request URL example:
> `https://api.schwabapi.com/marketdata/v1/chains?symbol=SPY&contractType=ALL&strikeCount=60&includeUnderlyingQuote=true`
>
> App registration shows "Market Data Production" enabled. Could you confirm whether option chain access requires a separate entitlement on my app, or if there's a status flag I need to set?
>
> Thanks.

Schwab API contact: from the developer portal "Help" or "Contact" link (varies — they don't publicize a generic email).

### 5. Workaround while waiting (optional, ~30 min code)

If approval takes days, we can wire **CBOE delayed chains** as a fallback:

- Source: `https://cdn.cboe.com/api/global/delayed_quotes/options/SPY.json` (free, no auth)
- Lag: ~15 min
- Coverage: SPY, QQQ, NVDA, TSLA, AAPL, MSFT, etc.
- Already partially used in `server/sources.ts` (`cboeSpyChain`) and `server/cboeFlow.ts`

We'd add a fallback in `server/schwab.ts` `getOptionChain()`: on 403, try CBOE. The data feeds gamma walls + 0DTE banger detection, so 15-min lag is acceptable for end-of-day analysis but degrades same-day 0DTE alerts.

**Decision pending — let me know if you want CBOE fallback wired now or wait for Schwab.**

---

## Diagnostic endpoint reference

Hit these to verify state:

```bash
# Schwab cache, rate budget, cooldowns, 403 streaks
curl http://127.0.0.1:5000/api/schwab/diag

# Live VIX from Schwab
curl http://127.0.0.1:5000/api/snapshot | jq '.vol.vix'
```

## Files in this commit

`a8d7cb8` — `fix(schwab): VIX/index symbol map (.X stripped) + 429/403 backoff + cache + self-throttle`

Changed:
- `server/sources.ts` — symbol map fixed, exported `toSchwabSymbol`
- `server/quotes.ts`, `server/ohlc.ts`, `server/seasonality.ts`, `server/jpmCollar.ts`, `server/backtest.ts`, `server/odteAlertEngine.ts`, `server/schwabFlow.ts`, `server/auditEnrich.ts` — all `.X` suffixes stripped
- `server/schwab.ts` — `_normalizeIndexSymbol()` shim (auto-fixes locked `regime.ts`), full `schwabFetch()` rewrite with cache + retry + cooldown + self-throttle
- `server/routes.ts` — `/api/schwab/diag` endpoint
