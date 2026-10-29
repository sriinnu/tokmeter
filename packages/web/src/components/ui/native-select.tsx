import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

/**
 * shadcn's native-select: a styled <select>. Chosen over the Radix Select
 * because the native control is fully accessible and mobile-friendly for free,
 * and Radix Select drags in scroll-lock packages that ship no license file
 * (which the app build's THIRD_PARTY_NOTICES step rightly refuses).
 */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select
        className="h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-card py-0 pr-8 pl-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 opacity-60"
        aria-hidden
      />
    </div>
  );
}
