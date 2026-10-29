import { Info } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";
import { formatCurrency } from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import type { SpendTempo } from "../lib/tempo.js";
import { useTheme } from "../lib/theme.js";
import type { FlowRenderer } from "./flowRenderer.js";

/**
 * Header band with a live shader behind it. The shader module loads lazily
 * after first paint; until then (and forever, without WebGL) a static CSS
 * gradient in the same palette stands in. A left-weighted scrim keeps the
 * header copy on near-background colour so its contrast doesn't depend on
 * where the flow happens to be.
 */
export function AmbientBand({ tempo, children }: { tempo: SpendTempo; children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<FlowRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const { enabled: animate } = useMotion();
  const { resolved: theme } = useTheme();

  // biome-ignore lint/correctness/useExhaustiveDependencies: built once; later changes go through update()
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    // A fresh canvas per mount: a context lost on dispose (StrictMode remount,
    // route change) can't be reacquired from the same element.
    const canvas = document.createElement("canvas");
    canvas.className = "block size-full";
    host.appendChild(canvas);
    import("./flowRenderer.js")
      .then(({ startFlow }) => {
        if (disposed) return;
        rendererRef.current = startFlow(canvas, {
          animate,
          tempo: tempo.tempo,
          brightness: tempo.brightness,
          background: readBackground(),
          dark: theme === "dark",
          onFirstFrame: () => !disposed && setReady(true),
        });
      })
      .catch(() => {
        /* chunk failed to load: the CSS gradient stays */
      });
    return () => {
      disposed = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      canvas.remove();
      setReady(false);
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.update({ animate, tempo: tempo.tempo, brightness: tempo.brightness });
  }, [animate, tempo.tempo, tempo.brightness]);

  useEffect(() => {
    rendererRef.current?.update({ background: readBackground(), dark: theme === "dark" });
  }, [theme]);

  return (
    <div className="relative isolate overflow-hidden rounded-xl border">
      <div
        aria-hidden
        className="absolute inset-0 -z-30"
        style={{
          background:
            "radial-gradient(90% 160% at 100% 0%, color-mix(in oklab, var(--brand-2) 30%, transparent), transparent 70%), radial-gradient(60% 140% at 80% 110%, color-mix(in oklab, var(--brand-amber) 18%, transparent), transparent 70%), var(--background)",
        }}
      />
      <div
        ref={hostRef}
        aria-hidden
        className="absolute inset-0 -z-20 opacity-0 transition-opacity duration-700 data-[ready=true]:opacity-100"
        data-ready={ready}
      />
      {/* Scrim: on phones the copy spans the full width, so it is uniform there. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-background/70 sm:bg-transparent sm:bg-gradient-to-r sm:from-background/80 sm:from-10% sm:via-background/30 sm:via-45% sm:to-transparent sm:to-70%"
      />
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-5 sm:px-6 sm:py-6">
        <div className="min-w-0">{children}</div>
        <TempoHint tempo={tempo} />
      </div>
    </div>
  );
}

function TempoHint({ tempo }: { tempo: SpendTempo }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="About the animated background"
          className="rounded-md bg-background/70 p-1.5 text-muted-foreground backdrop-blur hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" className="grid gap-1">
        <span>Background tempo follows today’s spend rate vs your typical hour.</span>
        <span className="text-muted-foreground">
          {tempo.neutral || tempo.typicalPerHour === null || tempo.todayPerHour === null
            ? "Not enough sealed history yet, so it runs at a neutral pace."
            : `Today ${formatCurrency(tempo.todayPerHour)}/h so far vs a typical ${formatCurrency(tempo.typicalPerHour)}/h (median of recent sealed days, est.).`}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Theme background as sRGB 0..1; tokens may be oklch(), so let the browser rasterise it. */
function readBackground(): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [0.5, 0.5, 0.5];
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#808080";
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}
