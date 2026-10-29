import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { LedgerArt, type LedgerArtKind } from "./art/LedgerArt.js";
import { Card, CardContent } from "./ui/card.js";
import { Skeleton } from "./ui/skeleton.js";

/** Layout-shaped placeholder so the page doesn't jump when data lands. */
export function PageSkeleton({ tiles = 4, rows = 2 }: { tiles?: number; rows?: number }) {
  return (
    <div className="grid gap-5" aria-busy="true">
      <span className="sr-only" role="status">
        Loading usage data
      </span>
      <div className="grid gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: tiles }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-72 rounded-xl" />
      ))}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  art = "error",
}: {
  title: string;
  message: ReactNode;
  art?: LedgerArtKind;
}) {
  return (
    <Card role="alert">
      <CardContent className="flex flex-col items-start gap-4 pt-5 sm:flex-row sm:items-center">
        <LedgerArt kind={art} />
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="size-4 shrink-0 text-critical" aria-hidden />
            {title}
          </h1>
          <div className="mt-1 break-words text-sm text-muted-foreground">{message}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function EmptyState({
  title,
  message,
  art,
}: {
  title: string;
  message?: ReactNode;
  /** Illustration; without one, a small inbox icon. */
  art?: LedgerArtKind;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center">
      {art ? (
        <LedgerArt kind={art} className="mb-1" />
      ) : (
        <Inbox className="size-5 text-muted-foreground" aria-hidden />
      )}
      <div className="text-sm font-medium">{title}</div>
      {message && <div className="max-w-md text-xs text-muted-foreground">{message}</div>}
    </div>
  );
}
