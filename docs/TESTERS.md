# Invite-only testers: your own Batcave on your own Schwab account

Each tester runs a private copy of Batcave that only they can open, on market
data from **their own** Schwab account. Nobody's Schwab data passes through
anyone else's server. This is the setup until Schwab approves a commercial
(multi-user) app.

## What you need (about 30 minutes, plus Schwab's app approval)

- A Charles Schwab brokerage account.
- A Schwab developer account at developer.schwab.com (free).
- A Railway account on the Hobby plan (paid by you; check railway.com/pricing).
- A GitHub account.

## 1. Copy the code

Fork `github.com/doodlecoder47282/pulse-market-sentiment` to your GitHub
account. To get updates later, open your fork and press **Sync fork**.

## 2. Create the Railway service

1. Railway → **New Project** → **Deploy from GitHub repo** → your fork, branch
   `main`.
2. Right-click the service → **Attach Volume** → mount path `/app/data`. Your
   encrypted Schwab sign-in and history live here.
3. Settings → Networking → **Generate Domain**. Note the URL, for example
   `https://batcave-yourname.up.railway.app`.

## 3. Create your Schwab app

On developer.schwab.com → Dashboard → **Create App**:

- API products: **Market Data Production**. Add **Accounts and Trading
  Production** too if you want live streaming quotes (Batcave reads only your
  streaming preferences; it never places orders).
- Callback URL: your Railway URL plus `/api/schwab/oauth/callback`, e.g.
  `https://batcave-yourname.up.railway.app/api/schwab/oauth/callback`.
- Schwab reviews new apps. Wait until the status is **Ready For Use**.

## 4. Set the variables

Railway → your service → **Variables**. Generate the two keys on your own
computer (Terminal on a Mac) and paste them straight into Railway. Never send
them to anyone, including the Batcave owner.

```text
BATCAVE_EDITION      = investor
BATCAVE_ACCESS_KEY   = <run: openssl rand -hex 32>
BATCAVE_TOKEN_KEY    = <run: openssl rand -base64 32>
SCHWAB_CLIENT_ID     = <App Key from your Schwab app>
SCHWAB_CLIENT_SECRET = <Secret from your Schwab app>
SCHWAB_REDIRECT_URI  = <exactly the callback URL from step 3>
PULSE_ML_AUTOSTART   = 0
```

Railway redeploys on save (about 3 minutes).

## 5. Sign in

1. Open your Railway URL. Enter your `BATCAVE_ACCESS_KEY` once; the browser
   keeps it.
2. Settings (gear icon) → **Open Schwab Login** → sign in on Schwab's page →
   you land back in Batcave, connected.
3. Settings → **Test Schwab data**. Each line says what works.

iPhone: ask the owner for the Xcode project, or use the website in Safari and
Share → **Add to Home Screen**.

## What the investor edition includes

Levels, gamma, flow, regime, models, news and the rest of the analytics.
Trade setups and Discord trade cards are personal-edition features and are
off. Scores are heuristics, not probabilities, and nothing in Batcave is
investment advice.

## Getting help

Send the owner the self-test lines and the last 30 lines of Railway → Deploy
Logs. Never send keys, secrets or tokens; the logs do not contain them.

---

## For the owner: one-click Railway template

A template lets testers skip steps 1, 2 and 4 except for pasting their own
values. In Railway: your project → **Settings** → create a template from the
service (or railway.com/new/template), then:

- Source: this GitHub repo, branch `main`.
- Volume: `/app/data`.
- Variables with defaults: `BATCAVE_EDITION=investor`, `PULSE_ML_AUTOSTART=0`.
- Variables the tester must fill: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`,
  `SCHWAB_REDIRECT_URI`.
- Generated per deploy: `BATCAVE_ACCESS_KEY=${{secret(64)}}` (Railway
  template function; the tester reads it from their own Variables tab).
- Left for the tester: `BATCAVE_TOKEN_KEY` (must be 32 random bytes in
  base64, from `openssl rand -base64 32`; a plain random string is refused).

Publishing the template makes its page public; the template holds no secrets
because every key is generated or entered by the tester.
