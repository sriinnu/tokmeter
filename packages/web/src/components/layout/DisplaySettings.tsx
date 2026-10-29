import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import { MotionToggle } from "./MotionToggle.js";
import { ThemeToggle } from "./ThemeToggle.js";

/**
 * Phone-width home for the theme and motion controls: the top bar has no
 * room for both. A native <details> keeps it keyboard- and screen-reader-
 * operable without a popover dependency; outside clicks and Escape close it.
 */
export function DisplaySettings() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (
        event instanceof KeyboardEvent ? event.key === "Escape" : !el.contains(event.target as Node)
      ) {
        el.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details ref={ref} className="relative">
      <summary
        aria-label="Display settings"
        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-md border bg-card text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <SlidersHorizontal className="size-4" aria-hidden />
      </summary>
      <div className="absolute top-full right-0 z-40 mt-2 grid w-max grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 rounded-lg border bg-popover p-3 text-xs text-muted-foreground shadow-md">
        <span>Theme</span>
        <ThemeToggle />
        <span>Motion</span>
        <MotionToggle />
      </div>
    </details>
  );
}
