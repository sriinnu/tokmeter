import { createContext, type ReactNode, useContext } from "react";
import { type LiveData, useLiveData } from "../hooks/useLiveData.js";
import { useTokmeterData } from "../hooks/useTokmeterData.js";

type SummaryState = ReturnType<typeof useTokmeterData>;

export interface DashboardData extends SummaryState {
  live: LiveData;
}

const DataContext = createContext<DashboardData | null>(null);

/**
 * One summary poller and one live poller for the whole app. Each page used to
 * mount its own `useTokmeterData`, which meant a fresh interval per route and
 * a loading flash on every navigation.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const summary = useTokmeterData();
  const live = useLiveData();
  return <DataContext.Provider value={{ ...summary, live }}>{children}</DataContext.Provider>;
}

export function useDashboardData(): DashboardData {
  const value = useContext(DataContext);
  if (!value) throw new Error("useDashboardData must be used inside <DataProvider>");
  return value;
}
