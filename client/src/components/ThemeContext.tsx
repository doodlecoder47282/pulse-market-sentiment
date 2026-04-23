import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  compact: boolean;
  toggleCompact: () => void;
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
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, compact, toggleCompact }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
