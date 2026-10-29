import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";

export type MotionPreference = "system" | "on" | "off";

const STORAGE_KEY = "tokmeter.motion";
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

// Storage can throw (private mode, blocked site data); motion must still resolve.
function readPreference(): MotionPreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "on" || value === "off" ? value : "system";
  } catch {
    return "system";
  }
}

function writePreference(value: MotionPreference): void {
  try {
    if (value === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* preference just won't persist */
  }
}

function resolve(pref: MotionPreference, systemReduces: boolean): boolean {
  return pref === "system" ? !systemReduces : pref === "on";
}

/**
 * `data-motion="off"` on <html> is what CSS keys off to drop every animation
 * and transition, so an explicit "On" can override the OS setting and "Off"
 * covers things JS never touches (hover transitions, route fades).
 */
export function applyMotion(enabled: boolean): void {
  document.documentElement.dataset.motion = enabled ? "on" : "off";
}

export function initialMotion(): boolean {
  return resolve(readPreference(), window.matchMedia?.(REDUCE_QUERY).matches ?? false);
}

interface MotionState {
  preference: MotionPreference;
  /** Whether anything should move right now. */
  enabled: boolean;
  setPreference: (value: MotionPreference) => void;
}

const MotionContext = createContext<MotionState | null>(null);

export function MotionProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<MotionPreference>(readPreference);
  const systemReduces = useMediaQuery(REDUCE_QUERY);
  const enabled = resolve(preference, systemReduces);

  useEffect(() => applyMotion(enabled), [enabled]);

  const setPreference = useCallback((value: MotionPreference) => {
    writePreference(value);
    setPreferenceState(value);
  }, []);

  return (
    <MotionContext.Provider value={{ preference, enabled, setPreference }}>
      {children}
    </MotionContext.Provider>
  );
}

export function useMotion(): MotionState {
  const value = useContext(MotionContext);
  if (!value) throw new Error("useMotion must be used inside <MotionProvider>");
  return value;
}
