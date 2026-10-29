import type { ReactNode } from "react";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { useDashboardData } from "../lib/data-context.js";
import { EmptyState, ErrorState, PageSkeleton } from "./states.js";

/**
 * Loading / error / empty handling shared by every route. Once a payload has
 * loaded, a failed refresh keeps rendering it (the hook surfaces the failure
 * as a warning in the status banner instead).
 */
export function DataGate({
  children,
  skeleton,
}: {
  children: (data: TokmeterData) => ReactNode;
  skeleton?: ReactNode;
}) {
  const { data, loading, error } = useDashboardData();
  if (data) return <>{children(data)}</>;
  if (loading) return <>{skeleton ?? <PageSkeleton />}</>;
  if (error) {
    return (
      <ErrorState
        art="offline"
        title="Usage data unavailable"
        message={
          <>
            Tokmeter could not load a summary yet. Make sure the Tokmeter app or daemon is running,
            then reload. <span className="mt-1 block font-mono text-xs">{error}</span>
          </>
        }
      />
    );
  }
  return (
    <EmptyState
      art="empty"
      title="No usage data yet"
      message="Run Tokmeter once, or keep the daemon open for a moment, so the first summary can be generated."
    />
  );
}
