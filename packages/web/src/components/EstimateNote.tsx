import { Info } from "lucide-react";
import { cn } from "../lib/utils.js";

/** Cost figures are modelled, not billed. Say so wherever a dollar total is headline. */
export function EstimateNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        Costs are estimates: API-rate pricing plus tool-reported amounts, not a verified bill. Usage
        without a known price counts as $0.
      </span>
    </p>
  );
}
