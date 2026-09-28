# Batcave source inventory

Generated from tracked source paths. 330 source/script files received static inventory scanning.
Tags and hosts are lexical leads, not proof that a path executes or that a calculation is correct.
Comments may contribute host names. Runtime databases, credentials, and generated build bundles are not read.

- **root:** 20 files.
- **client:** 152 files.
- **ios:** 4 files.
- **ml_service:** 8 files.
- **script:** 1 files.
- **scripts:** 2 files.
- **server:** 139 files.
- **shared:** 2 files.
- **tests:** 2 files.

| File | Lines | Review leads | Referenced HTTPS hosts |
|---|---:|---|---|
| `RESTORE.sh` | 101 | — | github.com, 127.0.0.1 |
| `START-PULSE.bat` | 85 | — | nodejs.org |
| `START-PULSE.sh` | 71 | — | nodejs.org |
| `START-WATCHDOG.sh` | 23 | — | — |
| `capacitor.config.ts` | 18 | — | — |
| `client/src/App.tsx` | 68 | — | — |
| `client/src/components/AlphaNewsOverlay.tsx` | 393 | — | — |
| `client/src/components/BacktestOverlay.tsx` | 311 | — | — |
| `client/src/components/BatmanLogo.tsx` | 83 | — | — |
| `client/src/components/BreadthCard.tsx` | 100 | — | — |
| `client/src/components/CanaryStrip.tsx` | 136 | — | — |
| `client/src/components/CandlestickChart.tsx` | 493 | — | — |
| `client/src/components/ChainAudit.tsx` | 1015 | calculation | — |
| `client/src/components/ChartPanel.tsx` | 515 | scheduler, calculation | — |
| `client/src/components/CollapsibleCard.tsx` | 112 | — | — |
| `client/src/components/ConstellationPulse.tsx` | 297 | — | — |
| `client/src/components/CosmosPanel.tsx` | 1304 | — | — |
| `client/src/components/CryptoPanel.tsx` | 510 | — | — |
| `client/src/components/DailyPlaybookChart.tsx` | 583 | calculation | — |
| `client/src/components/DecisionSupportCard.tsx` | 290 | calculation | — |
| `client/src/components/DepthSkewFlow.tsx` | 644 | — | — |
| `client/src/components/EdgeInfo.tsx` | 228 | calculation | — |
| `client/src/components/EdgeLabPanel.tsx` | 55 | — | — |
| `client/src/components/EdgeStatsPanel.tsx` | 422 | — | — |
| `client/src/components/ErrorBoundary.tsx` | 96 | — | — |
| `client/src/components/ExitBrainPanel.tsx` | 279 | — | — |
| `client/src/components/ExposurePanel.tsx` | 359 | — | — |
| `client/src/components/FlashNumber.tsx` | 76 | — | — |
| `client/src/components/FlowAlertsPanel.tsx` | 518 | randomness | — |
| `client/src/components/FlowPanel.tsx` | 1045 | — | — |
| `client/src/components/GammaContextBanner.tsx` | 205 | — | — |
| `client/src/components/GammaLevelsStrip.tsx` | 318 | — | — |
| `client/src/components/Gauge.tsx` | 91 | — | — |
| `client/src/components/GexChart.tsx` | 81 | — | — |
| `client/src/components/GlobalEdgeBanner.tsx` | 158 | — | — |
| `client/src/components/Heatseeker.tsx` | 1358 | randomness | — |
| `client/src/components/JPMCollarPanel.tsx` | 259 | — | — |
| `client/src/components/Killbox.tsx` | 617 | — | — |
| `client/src/components/LaunchSplash.tsx` | 809 | scheduler, randomness | — |
| `client/src/components/LightweightCandlestick.tsx` | 352 | — | — |
| `client/src/components/LiveOdteTracker.tsx` | 604 | — | — |
| `client/src/components/LiveQuoteStrip.tsx` | 91 | — | — |
| `client/src/components/LivenessBadge.tsx` | 103 | — | — |
| `client/src/components/Logo.tsx` | 19 | — | — |
| `client/src/components/MLProjectionPanel.tsx` | 1379 | — | — |
| `client/src/components/MacroCarousel.tsx` | 286 | scheduler | — |
| `client/src/components/Mag7Panel.tsx` | 278 | — | — |
| `client/src/components/MetricCard.tsx` | 45 | — | — |
| `client/src/components/ModelsPanel.tsx` | 2288 | scheduler, calculation | — |
| `client/src/components/NativeShell.tsx` | 111 | — | your-batcave-server.com |
| `client/src/components/NewsPanel.tsx` | 1333 | — | finance.yahoo.com, www.federalreserve.gov, www.treasurydirect.gov, www.cboe.com, www.bls.gov, www.bea.gov, www.dol.gov, www.ismworld.org, www.census.gov, www.conference-board.org, www.nasdaq.com |
| `client/src/components/OdteContractChart.tsx` | 631 | — | — |
| `client/src/components/OdteForward.tsx` | 406 | — | — |
| `client/src/components/OfiHistogram.tsx` | 156 | — | — |
| `client/src/components/PanelErrorBoundary.tsx` | 14 | — | — |
| `client/src/components/PositionSizer.tsx` | 322 | calculation | — |
| `client/src/components/PreMarketGate.tsx` | 230 | calculation | — |
| `client/src/components/RegimeChip.tsx` | 95 | — | — |
| `client/src/components/RegimeHeadline.tsx` | 111 | — | — |
| `client/src/components/RegimePanel.tsx` | 775 | — | — |
| `client/src/components/RegimePredictPanel.tsx` | 329 | calculation | — |
| `client/src/components/SchwabSettings.tsx` | 659 | — | 127.0.0.1 |
| `client/src/components/SeasonalityPanel.tsx` | 878 | — | — |
| `client/src/components/SeasonalityResearch.tsx` | 693 | — | charts.equityclock.com |
| `client/src/components/SectorWeb.tsx` | 1062 | — | — |
| `client/src/components/ShortcutsModal.tsx` | 67 | — | — |
| `client/src/components/SortableTh.tsx` | 87 | — | — |
| `client/src/components/TabHeadline.tsx` | 98 | — | — |
| `client/src/components/TakeFive.tsx` | 452 | scheduler, calculation | — |
| `client/src/components/ThemeContext.tsx` | 63 | — | — |
| `client/src/components/ThermalHeatmap.tsx` | 389 | — | — |
| `client/src/components/ThresholdTuner.tsx` | 287 | — | — |
| `client/src/components/TickerContext.tsx` | 125 | — | — |
| `client/src/components/TickerOutlookCard.tsx` | 912 | calculation | — |
| `client/src/components/TradeDesk.tsx` | 2023 | calculation | — |
| `client/src/components/TradeEnvironmentStrip.tsx` | 120 | — | — |
| `client/src/components/TradingViewWidget.tsx` | 129 | — | s3.tradingview.com, www.tradingview.com |
| `client/src/components/UnusualFlowPanel.tsx` | 1216 | — | — |
| `client/src/components/VoicesPanel.tsx` | 394 | — | — |
| `client/src/components/WefThemePanel.tsx` | 281 | — | — |
| `client/src/components/WhaleFlowPanel.tsx` | 1027 | — | — |
| `client/src/components/WidgetStack.tsx` | 224 | — | — |
| `client/src/components/edgelab/AnomalyPanel.tsx` | 161 | — | — |
| `client/src/components/edgelab/BacktestPanel.tsx` | 233 | — | — |
| `client/src/components/edgelab/ClvPanel.tsx` | 285 | — | — |
| `client/src/components/edgelab/CrossAssetPanel.tsx` | 125 | — | — |
| `client/src/components/edgelab/EdgeBrief.tsx` | 219 | — | — |
| `client/src/components/edgelab/EdgeBriefing.tsx` | 407 | calculation | — |
| `client/src/components/edgelab/GammaCurvePanel.tsx` | 203 | — | — |
| `client/src/components/edgelab/IvRvPanel.tsx` | 163 | — | — |
| `client/src/components/edgelab/MacroFlowPanel.tsx` | 162 | — | — |
| `client/src/components/edgelab/SkewPanel.tsx` | 170 | — | — |
| `client/src/components/edgelab/TruthPanel.tsx` | 207 | calculation | — |
| `client/src/components/models/MLAccuracyCard.tsx` | 379 | calculation | — |
| `client/src/components/models/MultiDayCone.tsx` | 316 | — | — |
| `client/src/components/models/PivotProjection.tsx` | 535 | — | — |
| `client/src/components/regime/UnderperformerWatcher.tsx` | 221 | — | — |
| `client/src/components/signals/TrackButton.tsx` | 109 | — | — |
| `client/src/components/signals/TrackedSignalsPanel.tsx` | 255 | — | — |
| `client/src/components/ui/accordion.tsx` | 57 | — | — |
| `client/src/components/ui/alert-dialog.tsx` | 140 | — | — |
| `client/src/components/ui/alert.tsx` | 61 | — | — |
| `client/src/components/ui/aspect-ratio.tsx` | 6 | — | — |
| `client/src/components/ui/avatar.tsx` | 52 | — | — |
| `client/src/components/ui/badge.tsx` | 40 | — | — |
| `client/src/components/ui/breadcrumb.tsx` | 116 | — | — |
| `client/src/components/ui/button.tsx` | 64 | — | — |
| `client/src/components/ui/calendar.tsx` | 69 | — | — |
| `client/src/components/ui/card.tsx` | 86 | — | — |
| `client/src/components/ui/carousel.tsx` | 260 | — | — |
| `client/src/components/ui/chart.tsx` | 366 | — | — |
| `client/src/components/ui/checkbox.tsx` | 29 | — | — |
| `client/src/components/ui/collapsible.tsx` | 12 | — | — |
| `client/src/components/ui/command.tsx` | 152 | — | — |
| `client/src/components/ui/context-menu.tsx` | 199 | — | — |
| `client/src/components/ui/dialog.tsx` | 123 | — | — |
| `client/src/components/ui/drawer.tsx` | 119 | — | — |
| `client/src/components/ui/dropdown-menu.tsx` | 199 | — | — |
| `client/src/components/ui/form.tsx` | 173 | — | — |
| `client/src/components/ui/hover-card.tsx` | 30 | — | — |
| `client/src/components/ui/input-otp.tsx` | 70 | — | — |
| `client/src/components/ui/input.tsx` | 24 | — | — |
| `client/src/components/ui/label.tsx` | 26 | — | — |
| `client/src/components/ui/menubar.tsx` | 257 | — | — |
| `client/src/components/ui/navigation-menu.tsx` | 129 | — | — |
| `client/src/components/ui/pagination.tsx` | 118 | — | — |
| `client/src/components/ui/panel-skeleton.tsx` | 83 | — | — |
| `client/src/components/ui/popover.tsx` | 30 | — | — |
| `client/src/components/ui/progress.tsx` | 29 | — | — |
| `client/src/components/ui/radio-group.tsx` | 43 | — | — |
| `client/src/components/ui/resizable.tsx` | 46 | — | — |
| `client/src/components/ui/scroll-area.tsx` | 47 | — | — |
| `client/src/components/ui/select.tsx` | 161 | — | — |
| `client/src/components/ui/separator.tsx` | 30 | — | — |
| `client/src/components/ui/sheet.tsx` | 142 | — | — |
| `client/src/components/ui/sidebar.tsx` | 728 | randomness | — |
| `client/src/components/ui/skeleton.tsx` | 16 | — | — |
| `client/src/components/ui/slider.tsx` | 27 | — | — |
| `client/src/components/ui/switch.tsx` | 28 | — | — |
| `client/src/components/ui/table.tsx` | 118 | — | — |
| `client/src/components/ui/tabs.tsx` | 54 | — | — |
| `client/src/components/ui/textarea.tsx` | 23 | — | — |
| `client/src/components/ui/toast.tsx` | 129 | — | — |
| `client/src/components/ui/toaster.tsx` | 34 | — | — |
| `client/src/components/ui/toggle-group.tsx` | 62 | — | — |
| `client/src/components/ui/toggle.tsx` | 45 | — | — |
| `client/src/components/ui/tooltip.tsx` | 31 | — | — |
| `client/src/hooks/use-keyboard-shortcuts.ts` | 146 | — | — |
| `client/src/hooks/use-mobile.tsx` | 20 | — | — |
| `client/src/hooks/use-toast.ts` | 192 | — | — |
| `client/src/lib/format.ts` | 34 | — | — |
| `client/src/lib/nativeSession.ts` | 48 | — | — |
| `client/src/lib/queryClient.ts` | 84 | network | — |
| `client/src/lib/utils.ts` | 8 | — | — |
| `client/src/main.tsx` | 64 | — | — |
| `client/src/pages/dashboard.tsx` | 1063 | scheduler | — |
| `client/src/pages/not-found.tsx` | 22 | — | — |
| `drizzle.config.ts` | 11 | database | — |
| `ios/App/App/AppDelegate.swift` | 45 | — | — |
| `ios/App/App/SceneDelegate.swift` | 25 | — | — |
| `ios/App/CapApp-SPM/Package.swift` | 26 | — | github.com |
| `ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift` | 2 | — | — |
| `ml_service/__init__.py` | 1 | — | — |
| `ml_service/app.py` | 213 | — | — |
| `ml_service/backfill.py` | 421 | database | cdn.cboe.com, www.alphavantage.co |
| `ml_service/loaders.py` | 164 | database | — |
| `ml_service/predictor.py` | 332 | calculation | — |
| `ml_service/train_quantile_impl.py` | 812 | database | — |
| `ml_service/train_quantile_morning_impl.py` | 479 | — | — |
| `ml_service/trainer.py` | 852 | database | — |
| `playwright_screenshots.cjs` | 120 | — | — |
| `postcss.config.js` | 7 | — | — |
| `pw_debug.cjs` | 57 | — | — |
| `pw_final.cjs` | 118 | — | — |
| `pw_final2.cjs` | 94 | — | — |
| `pw_tabs.cjs` | 104 | — | — |
| `pw_with_server.cjs` | 147 | — | — |
| `script/build.ts` | 66 | — | — |
| `scripts/reseed.cjs` | 172 | database, randomness, calculation | — |
| `scripts/review-inventory.mjs` | 32 | database, scheduler, calculation | — |
| `server/alphaEmailComposer.ts` | 296 | scheduler, calculation | — |
| `server/alphaEngine.ts` | 334 | — | — |
| `server/alphaFusion.ts` | 467 | network | — |
| `server/alphaNews.ts` | 550 | LLM, calculation | — |
| `server/anomalyDetector.ts` | 180 | database | — |
| `server/auditEnrich.ts` | 982 | database | — |
| `server/backtest.ts` | 586 | — | — |
| `server/breadth.ts` | 193 | database | — |
| `server/breedenLitzenberger.ts` | 133 | calculation | — |
| `server/calibration.ts` | 347 | database | — |
| `server/calibrationCard.ts` | 208 | network | discord.com |
| `server/canary.ts` | 291 | database, scheduler | — |
| `server/cboeCache.ts` | 148 | network | cdn.cboe.com, www.cboe.com |
| `server/cboeChainAdapter.ts` | 156 | — | — |
| `server/chainAudit.ts` | 905 | calculation | — |
| `server/clvTracker.ts` | 333 | database | — |
| `server/composite.ts` | 262 | — | — |
| `server/contractPicker.ts` | 420 | — | — |
| `server/cosmos.ts` | 1909 | network, calculation | services.swpc.noaa.gov |
| `server/cotClient.ts` | 192 | network, database, scheduler | publicreporting.cftc.gov |
| `server/crossAsset.ts` | 185 | database | — |
| `server/cryptoAuditStats.ts` | 17 | database | — |
| `server/cryptoEngine.ts` | 1013 | network, database, scheduler | api.geckoterminal.com, api.dexscreener.com, solana-rpc.publicnode.com, api.mainnet-beta.solana.com, api.rugcheck.xyz, api.bsky.app, frontend-api-v3.pump.fun, www.coindesk.com, www.theblock.co, decrypt.co |
| `server/cusumWatchdog.ts` | 94 | database | — |
| `server/dailyPlaybook.ts` | 505 | calculation | — |
| `server/dbBackup.ts` | 72 | database, scheduler | — |
| `server/decisionSupport.ts` | 122 | calculation | — |
| `server/discord.ts` | 620 | network | discord.com |
| `server/discordBatcaveCard.ts` | 895 | network | discord.com |
| `server/discordFlowCard.ts` | 107 | calculation | — |
| `server/discordScheduler.ts` | 1001 | network, database, scheduler | — |
| `server/discordUoaCard.ts` | 61 | — | — |
| `server/earnings.ts` | 372 | network | api.nasdaq.com, www.nasdaq.com |
| `server/econWeek.ts` | 628 | network | perplexity.ai, api.nasdaq.com |
| `server/edgeBriefing.ts` | 384 | network, calculation | — |
| `server/edgeLabBrief.ts` | 737 | LLM, calculation | — |
| `server/edgeStats.ts` | 361 | calculation | — |
| `server/edgeSurvival.ts` | 128 | calculation | — |
| `server/etTime.ts` | 43 | — | — |
| `server/exitBrain.ts` | 540 | network, scheduler, calculation | — |
| `server/exposureProfile.ts` | 247 | — | — |
| `server/exposures.ts` | 144 | — | — |
| `server/flow.ts` | 567 | network | cdn.cboe.com |
| `server/flowAlertEngine.ts` | 702 | scheduler, calculation | — |
| `server/flowConfig.ts` | 188 | — | — |
| `server/fredClient.ts` | 171 | network, database, scheduler | fred.stlouisfed.org |
| `server/gammaCurve.ts` | 174 | — | — |
| `server/gammaLevels.ts` | 120 | — | — |
| `server/gammaProfile.ts` | 155 | calculation | perfiliev.com |
| `server/gradeCalibration.ts` | 179 | database, calculation | — |
| `server/greekGradientDb.ts` | 126 | database | — |
| `server/greeks.ts` | 250 | calculation | github.com |
| `server/hazardEngine.ts` | 392 | database, scheduler, calculation | — |
| `server/headline.ts` | 269 | network, calculation | — |
| `server/heatseeker.ts` | 479 | — | — |
| `server/heatseekerLevels.ts` | 114 | randomness | — |
| `server/index.ts` | 127 | — | — |
| `server/ivRv.ts` | 232 | database | — |
| `server/jpmCollar.ts` | 156 | — | — |
| `server/leeReadyOfi.ts` | 133 | — | — |
| `server/levelPlaybook.ts` | 145 | — | — |
| `server/macro.ts` | 306 | network | api.coingecko.com, api.frankfurter.dev |
| `server/mag7.ts` | 130 | — | — |
| `server/masterAlpha.ts` | 848 | LLM | — |
| `server/mlAccuracy.ts` | 343 | calculation | — |
| `server/mlBridge.ts` | 210 | network, calculation | — |
| `server/mlGreekFeatures.ts` | 302 | — | — |
| `server/mlMorningFingerprint.ts` | 251 | — | — |
| `server/mlRetrainCron.ts` | 134 | network, scheduler | — |
| `server/mlServiceManager.ts` | 101 | network | — |
| `server/mmMatrix.ts` | 465 | calculation | — |
| `server/mmPredictions.ts` | 429 | — | — |
| `server/mmScheduler.ts` | 156 | network, scheduler | — |
| `server/mobileGateway.ts` | 96 | — | — |
| `server/models.ts` | 1482 | calculation | — |
| `server/mtfStack.ts` | 324 | — | — |
| `server/multiDayProjection.ts` | 181 | — | — |
| `server/news.ts` | 657 | network | feeds.content.dj-n.com, news.google.com, www.cnbc.com, www.ft.com, api.nasdaq.com |
| `server/odteAlertEngine.ts` | 2462 | — | — |
| `server/odteAuditDb.ts` | 325 | database | — |
| `server/odteGrader.ts` | 223 | database | — |
| `server/odteProjection.ts` | 326 | calculation | — |
| `server/odteTracker.ts` | 585 | randomness | — |
| `server/ohlc.ts` | 180 | — | — |
| `server/orthogonality.ts` | 160 | database | — |
| `server/ouBand.ts` | 133 | — | — |
| `server/outcomeLogger.ts` | 372 | database, scheduler, calculation | — |
| `server/particleFilterDFI.ts` | 172 | randomness, calculation | — |
| `server/pivotProjection.ts` | 466 | — | — |
| `server/pivots.ts` | 149 | calculation | — |
| `server/playbook.ts` | 687 | calculation | — |
| `server/playbookScheduler.ts` | 76 | scheduler | — |
| `server/positionSizer.ts` | 229 | calculation | — |
| `server/quarterlyTrajectory.ts` | 432 | — | — |
| `server/quoteShield.ts` | 129 | — | — |
| `server/quotes.ts` | 266 | — | — |
| `server/realtimeTargets.ts` | 397 | — | — |
| `server/regime.ts` | 899 | — | — |
| `server/regimeHistoryTicker.ts` | 55 | network, scheduler | — |
| `server/regimePredictor.ts` | 507 | calculation | — |
| `server/regimeStateCache.ts` | 29 | calculation | — |
| `server/revExtClassifier.ts` | 405 | — | — |
| `server/routes.ts` | 6419 | network, database, scheduler, LLM, calculation | api.perplexity.ai |
| `server/scenarioWeights.ts` | 12 | — | — |
| `server/schwab.ts` | 724 | network, scheduler | 127.0.0.1, api.schwabapi.com |
| `server/schwabFlow.ts` | 190 | — | — |
| `server/sdZones.ts` | 155 | — | — |
| `server/seasonality.ts` | 578 | — | — |
| `server/sector-web.ts` | 291 | — | — |
| `server/sessionCache.ts` | 108 | — | — |
| `server/signalBacktest.ts` | 288 | database | — |
| `server/signalTracker.ts` | 255 | — | — |
| `server/skewEngine.ts` | 174 | — | — |
| `server/sources.ts` | 393 | network | cdn.cboe.com, www.cboe.com, production.dataviz.cnn.io, www.cnn.com, api.stocktwits.com, stocktwits.com, www.reddit.com |
| `server/stableTail.ts` | 86 | — | — |
| `server/static.ts` | 21 | — | — |
| `server/stats.ts` | 308 | calculation | — |
| `server/stockBarsCache.ts` | 166 | scheduler | — |
| `server/storage.ts` | 463 | database | — |
| `server/targetDerivation.ts` | 227 | calculation | — |
| `server/tickerAlpha.ts` | 691 | network, calculation | api.stocktwits.com, stocktwits.com, www.reddit.com, api.twitter.com, x.com |
| `server/tickerCalendar.ts` | 132 | — | — |
| `server/tickerOutlook.ts` | 492 | LLM, calculation | — |
| `server/tickerProjection.ts` | 192 | — | — |
| `server/tradeEnvironment.ts` | 330 | network, database, scheduler | — |
| `server/underperformers.ts` | 197 | — | — |
| `server/unusualFlow.ts` | 289 | — | — |
| `server/uoaScanner.ts` | 417 | — | — |
| `server/vite.ts` | 59 | — | — |
| `server/voices.ts` | 416 | network | x.com, news.google.com, feeds.simplecast.com, brandtp.substack.com |
| `server/volCalendar.ts` | 287 | — | — |
| `server/volumeProfile.ts` | 150 | — | — |
| `server/wef-themes.ts` | 309 | network | www.weforum.org |
| `server/whaleBacktest.ts` | 434 | — | — |
| `server/whaleFollowThrough.ts` | 541 | — | — |
| `server/whalePersistence.ts` | 242 | database | — |
| `server/wickTiming.ts` | 174 | — | — |
| `server/widgetLayouts.ts` | 46 | database | — |
| `server/x.ts` | 221 | network | api.twitter.com, x.com |
| `shared/schema.ts` | 406 | database | — |
| `shared/vol.ts` | 19 | — | — |
| `tailwind.config.ts` | 116 | — | — |
| `test_card.ts` | 88 | — | — |
| `test_wire16.mjs` | 383 | — | — |
| `test_wire16_clean.mjs` | 374 | — | — |
| `tests/calculation-review.test.ts` | 137 | database, calculation | — |
| `tests/mobile.test.ts` | 88 | network | batcave.example, x, sites.pplx.app, www.perplexity.ai, evil.example |
| `vite.config.ts` | 56 | — | — |
| `vite.native.config.ts` | 12 | — | — |
| `watchdog.sh` | 51 | — | — |
