# Reference library: the papers and patents the owner collected

Found again on 2026-11-22 in the owner's chat "0DTE SPX trading algorithms and quant strategies" (June 2026,
https://claude.ai/chat/d3f4f3d7-361a-4ab0-b031-1ad23a020d49). The links are copied as that chat recorded
them. They have NOT been re-opened or checked since, and no PDF is stored in this repository yet. The
one-line notes say what each source is about; claims the old chat made about accuracy or returns are left out
because nothing here has verified them.

The owner's design rule (2026-11-22): the terminal combines physics and simple variables. A number on screen
should be the output of a stated model from measured inputs (price, strike, time to expiry, implied
volatility, open interest, volume). This file is the index of where those models come from.

## 1. Dealer gamma and 0DTE mechanics

| Source | Link |
|---|---|
| Dim, Eraker, Vilkov: 0DTEs: Trading, Gamma Risk and Volatility Propagation | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4692190 |
| Vilkov: 0DTE Trading Rules (with public code and data) | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4641356 and https://github.com/vilkovgr/0dte-strategies |
| Adams, Dim, Eraker, Fontaine, Ornthanalai, Vilkov: Do S&P 500 Options Increase Market Volatility? Evidence from 0DTEs | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5641974 |
| Adams, Fontaine, Ornthanalai: The Market for 0DTE: liquidity providers | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4881008 |
| Almeida, Freire, Hizmeri: 0DTE Asset Pricing | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4701401 |
| Bozovic: Intraday Jumps and 0DTE Options | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5223127 |
| Cboe: 0DTE index options and market volatility (gamma squeezes) | https://cdn.cboe.com/resources/education/research_publications/gammasqueezes.pdf |
| Cboe: 0DTEs Decoded | https://www.cboe.com/insights/posts/0-dt-es-decoded-positioning-trends-and-market-impact/ |
| Garmash: Zero DTE Options Gamma Hedging | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5329719 |
| Brogaard, Han, Won: Does 0DTE Options Trading Increase Volatility? | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4426358 |
| Beckmeyer, Branger, Gayda: Retail Traders Love 0DTE Options... But Should They? | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4404704 |
| SEC DERA: Hope at a Reasonable Price (limit orders in 0DTE) | https://www.sec.gov/files/dera-hope-reasonable-prc-2503.pdf |
| Doshi, Patel, Seo: Risky Intraday Order Flow and Option Liquidity | https://www.bauer.uh.edu/hdoshi/docs/DPS_May_2025.pdf |
| Baltussen, Da, Lammers, Martens: Hedging Demand and Market Intraday Momentum | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3760365 |
| Park, Zhao: Inelastic Hedging Demand and Intraday Momentum | https://portal.northernfinanceassociation.org/viewp.php?n=2240183764 |
| US7418416B2: Gamma trading tool (hedging algorithm) | https://patents.google.com/patent/US7418416B2 |

## 2. Option pricing and volatility surfaces at short maturities

| Source | Link |
|---|---|
| Bandi, Fusari, Gazzani, Reno: Ultra-Short-Term Volatility Surfaces | https://arxiv.org/abs/2603.29430 |
| Sakuma: Differential Machine Learning for 0DTE | https://arxiv.org/abs/2603.07600 |
| Revisiting Local Expansions for Zero Days-to-Expiry Option Pricing | https://www.sciencedirect.com/science/article/pii/S3050700625000532 |
| Intraday implied volatility surface with physics-informed networks (WamOL) | https://arxiv.org/abs/2411.02375 |
| VolNP: neural process for the implied volatility surface | https://arxiv.org/abs/2509.11928 |
| LLM detection of gamma exposure patterns | https://arxiv.org/abs/2512.17923 |

## 3. Scheduled events priced by options

| Source | Link |
|---|---|
| Wright: Event-Day Options (NBER 28306) | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3759844 |
| Londono, Fed Board: Which Days Matter for Global Equity Markets? | https://www.federalreserve.gov/econres/notes/feds-notes/which-days-matter-for-global-equity-markets-using-options-to-price-events-in-the-global-calendar-20251003.html |
| Johannes, Kaeck, Seeger: FOMC announcement event risk | SSRN 2023 (no link recorded) |
| US8229840B2 / US7856395B2 / US20110087586A1: short-term option trading system | https://patents.google.com/patent/US20110087586A1 |

## 4. Candle structure (the Bloomberg paper and the patents)

| Source | Link |
|---|---|
| Enhancing OHLC Data with Timing Features (the Bloomberg timing-enhanced bars: when the high and low occurred inside a bar) | https://arxiv.org/abs/2509.16137 |
| US7844487B2: sequence of price extremes inside a bar | https://patents.google.com/patent/US7844487B2 |
| US11631097B2: intra-period trend data generation | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11631097 |
| US11348293: dynamic price range symbol (when the high and low occurred) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11348293 |
| US8650115B2: computer trading system using supply and demand analysis (zones from basing candles) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8650115 |
| US7043449B1: volume at the wick extreme | (number only) |
| US20030139989A1: integrated price and volume display (volume by price bracket) | https://patents.google.com/patent/US20030139989A1 |
| DeepSupp: support and resistance by attention and clustering | https://arxiv.org/abs/2507.01971 |
| DPP: price movement from candlestick charts | PMC8216512 |
| Encoding candlesticks as images | https://arxiv.org/abs/1901.05237 |
| SPY volume profile | https://arxiv.org/abs/2406.17198 |

## 5. Order flow, microstructure and intrinsic time

| Source | Link |
|---|---|
| Bouchaud and others: Microstructure Modes | https://arxiv.org/abs/2405.10654 |
| Rosenbaum group: unified theory of order flow, market impact and volatility | https://arxiv.org/abs/2601.23172 |
| Returns and order flow imbalance, intraday dynamics (ES futures) | https://arxiv.org/abs/2508.06788 |
| Forecasting high-frequency order flow imbalance (Hawkes) | https://arxiv.org/abs/2408.03594 |
| Intrinsic Time: theory primer | https://arxiv.org/abs/2406.07354 |
| A modern paradigm for algorithmic trading (intrinsic time) | https://arxiv.org/abs/2501.06032 |
| The hidden constant of market rhythms | https://arxiv.org/abs/2511.14408 |
| Bridging the gap: intrinsic time | https://arxiv.org/abs/2204.02682 |
| Predicting intraday jumps from liquidity and technical indicators | https://arxiv.org/abs/1912.07165 |
| Forecasting intraday volume | https://arxiv.org/html/2505.08180v1 |
| arXiv 2507.16701, 2502.15757, 2505.05595, 2408.05659 (order-book prediction models) | https://arxiv.org/abs/2507.16701 |
| US8433645B1 / US8412617B1: order flow and price impact | https://patents.google.com/patent/US8433645B1 |
| US8140416B2, CA2662746A1: hidden and iceberg order detection | https://patents.google.com/patent/CA2662746A1 |
| US12045882: liquidity clustering prediction | (number only) |
| US8442885B1, US8571967B1: execution across venues, execution timing | https://patents.google.com/patent/US8442885B1 |
| US10803522B2: open interest, volume and implied volatility as one indicator | (number only) |

## 6. Intraday strategies cited

| Source | Link |
|---|---|
| Zarattini, Aziz, Barbon: Beat the Market (SPY intraday momentum) | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172 |
| Maroy: improvements with VWAP exits | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5095349 |
| QuantAgent: multi-agent LLM on price data | https://arxiv.org/abs/2509.09995 |

## What this library does and does not give

It gives the mechanisms: how dealer gamma relates to intraday reversal and momentum (section 1), how options
price a scheduled event (section 3), what is inside a candle (section 4). It does not, by itself, give the
exact formula for every number the terminal shows. The next step is one table: each number on a screen, the
model it comes from, the source and page, and a worked example. A number with no row in that table comes off
the screen.

Also from the owner's earlier work (not in the chat above): the Greeks and exposure formulas in the owner's
Excel sheet and `ezoptionsschwab.py` (chat "Greeks calculation comparison: Python vs Excel", March 2026).
