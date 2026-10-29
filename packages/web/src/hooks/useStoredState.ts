import { useCallback, useState } from "react";

/**
 * useState that remembers a small UI choice (a chart range, a view toggle)
 * per browser. Storage can throw or be empty (private mode, blocked site
 * data); the choice then just doesn't persist. `isValid` guards against stale
 * or hand-edited values.
 */
export function useStoredState<T extends string>(
  key: string | undefined,
  fallback: T,
  isValid: (value: string) => value is T
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (!key) return fallback;
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null && isValid(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      if (!key) return;
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* not persisted */
      }
    },
    [key]
  );
  return [value, set];
}
