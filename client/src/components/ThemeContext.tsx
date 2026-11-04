import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

/**
 * Background style for the dark theme. "navy" is the default (institutional
 * navy); "navy-glow" adds a soft light at the top; "graphite" is a neutral
 * blue-grey; "black" is the original night desk with the amber accent.
 * Stored per device; the app works the same without storage.
 */
export type BackgroundStyle = "navy" | "navy-glow" | "graphite" | "black";
export const BACKGROUND_STYLES: { id: BackgroundStyle; label: string; note: string; swatch: string; accent: string }[] = [
  { id: "navy", label: "Navy", note: "Institutional navy (default)", swatch: "#0A1324", accent: "#5B9BFF" },
  { id: "navy-glow", label: "Navy glow", note: "Navy with a soft light at the top", swatch: "#0F2240", accent: "#5B9BFF" },
  { id: "graphite", label: "Graphite", note: "Neutral blue-grey", swatch: "#15181E", accent: "#6EA8FF" },
  { id: "black", label: "Black", note: "The original night desk, amber accent", swatch: "#121212", accent: "#F5A524" },
];
const BG_KEY = "batcave:background";
const BG_COLOR: Record<BackgroundStyle, string> = { navy: "#0A1324", "navy-glow": "#0A1324", graphite: "#15181E", black: "#121212" };

function getInitialBackground(): BackgroundStyle {
  try {
    const v = window.localStorage.getItem(BG_KEY);
    if (v && BACKGROUND_STYLES.some((b) => b.id === v)) return v as BackgroundStyle;
  } catch { /* storage blocked: default */ }
  return "navy";
}

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  compact: boolean;
  toggleCompact: () => void;
  background: BackgroundStyle;
  setBackground: (b: BackgroundStyle) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Sandbox iframe blocks localStorage, so we seed from system preference on mount
// and keep state purely in memory. User's toggle persists only within the session.
function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "dark"; // default dark — batcave aesthetic
  } catch {
    return "dark";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [compact, setCompact] = useState<boolean>(false);
  const [background, setBackgroundState] = useState<BackgroundStyle>(getInitialBackground);
  const setBackground = (b: BackgroundStyle) => {
    setBackgroundState(b);
    try { window.localStorage.setItem(BG_KEY, b); } catch { /* per-device convenience only */ }
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-bg", background);
    // The browser/phone chrome colour follows the background.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && theme === "dark") meta.setAttribute("content", BG_COLOR[background]);
  }, [background, theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
      root.classList.remove("light");
    } else {
      root.classList.add("light");
      root.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (compact) root.setAttribute("data-compact", "1");
    else root.removeAttribute("data-compact");
  }, [compact]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const toggleCompact = () => setCompact((c) => !c);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, compact, toggleCompact, background, setBackground }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
