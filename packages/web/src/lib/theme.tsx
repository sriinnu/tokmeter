import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tokmeter.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

// Storage can throw (private mode, blocked site data); the theme must still work.
function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function writePreference(value: ThemePreference): void {
  try {
    if (value === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* preference just won't persist */
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** Stamp the resolved theme on <html> so CSS tokens and the dark variant agree. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

export function initialResolvedTheme(): ResolvedTheme {
  const pref = readPreference();
  return pref === "system" ? systemTheme() : pref;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);
  const resolved = preference === "system" ? system : preference;

  // The class is stamped in the event handlers, before React re-renders:
  // children's effects run before this provider's, and the 3D view reads its
  // palette from CSS in an effect, so it must already see the new tokens.
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return;
    const onChange = () => {
      const next = media.matches ? "dark" : "light";
      if (readPreference() === "system") applyTheme(next);
      setSystem(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => applyTheme(resolved), [resolved]);

  const setPreference = useCallback((value: ThemePreference) => {
    writePreference(value);
    applyTheme(value === "system" ? systemTheme() : value);
    setPreferenceState(value);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
