// Per-browser display preferences. Storage can be blocked (private mode,
// embedded previews), so every access is guarded and falls back to defaults.

const PREMARKET_KEY = "batcave.premarketGate";

/** Pre-market checklist on open: off unless the user turned it on. */
export function premarketGateEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREMARKET_KEY) === "on";
  } catch {
    return false;
  }
}

export function setPremarketGateEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(PREMARKET_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable: the setting lasts for this page load only */
  }
}
