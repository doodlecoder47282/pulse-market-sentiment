// shared/sectors.ts
//
// Sector for the names the desk scans, so a ranked list can cap how many
// setups express one bet. Static and small on purpose; a name not listed is
// its own sector (never silently grouped). Update when the universe changes.

const SECTOR: Record<string, string> = {
  SPX: "index", SPY: "index", QQQ: "index", IWM: "index", DIA: "index",
  NVDA: "semiconductors", AMD: "semiconductors", AVGO: "semiconductors",
  AAPL: "megacap tech", MSFT: "megacap tech", META: "megacap tech", GOOGL: "megacap tech", GOOG: "megacap tech", AMZN: "megacap tech",
  TSLA: "autos", PLTR: "software", COIN: "crypto-linked", MSTR: "crypto-linked",
};

export function sectorOf(symbol: string): string | null {
  return SECTOR[symbol.toUpperCase().replace(/^\$/, "")] ?? null;
}
