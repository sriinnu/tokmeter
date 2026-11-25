import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TokmeterData, TokmeterTimeOfDay } from "../hooks/useTokmeterData.js";
import type { DashboardData } from "../lib/data-context.js";
import { TimeOfDayStrip } from "../pages/dashboard/TimeOfDayStrip.js";
import { DataGate } from "./DataGate.js";
import { SummaryStatusBanner } from "./SummaryStatusBanner.js";

const mockUseDashboardData = vi.fn<() => DashboardData>();

vi.mock("../lib/data-context.js", () => ({
  useDashboardData: () => mockUseDashboardData(),
}));

function sampleData(): TokmeterData {
  return {
    records: [],
    projects: [],
    models: [],
    daily: [],
    stats: {
      totalTokens: 1000,
      totalCost: 2.5,
      inputTokens: 800,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalRecords: 1,
      projects: 1,
      models: 1,
      providers: 1,
      activeDays: 1,
      longestStreak: 1,
      firstUsed: 1,
      lastUsed: 2,
    },
    meta: {
      stableThrough: "2026-11-24",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: 1_764_000_000_000,
      warnings: [],
    },
  };
}

describe("Web UI components", () => {
  it("DataGate renders loading, error, empty, and loaded states", () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      warning: null,
      lastLoadedAt: null,
      source: null,
      live: { status: "disconnected", aggregated: null, lastUpdate: null },
    });
    expect(renderToStaticMarkup(<DataGate>{() => <p>ok</p>}</DataGate>)).toContain("aria-busy");

    mockUseDashboardData.mockReturnValue({
      data: null,
      loading: false,
      error: "daemon offline",
      warning: null,
      lastLoadedAt: null,
      source: null,
      live: { status: "disconnected", aggregated: null, lastUpdate: null },
    });
    const errHtml = renderToStaticMarkup(<DataGate>{() => <p>ok</p>}</DataGate>);
    expect(errHtml).toContain("Usage data unavailable");
    expect(errHtml).toContain("daemon offline");

    mockUseDashboardData.mockReturnValue({
      data: null,
      loading: false,
      error: null,
      warning: null,
      lastLoadedAt: null,
      source: null,
      live: { status: "disconnected", aggregated: null, lastUpdate: null },
    });
    expect(renderToStaticMarkup(<DataGate>{() => <p>ok</p>}</DataGate>)).toContain(
      "No usage data yet"
    );

    mockUseDashboardData.mockReturnValue({
      data: sampleData(),
      loading: false,
      error: null,
      warning: null,
      lastLoadedAt: 1_764_000_000_000,
      source: "live-api",
      live: { status: "connected", aggregated: null, lastUpdate: null },
    });
    expect(
      renderToStaticMarkup(
        <DataGate>{(d) => <span>Cost ${d.stats.totalCost.toFixed(2)}</span>}</DataGate>
      )
    ).toContain("Cost $2.50");
  });

  it("SummaryStatusBanner renders healthy and degraded warning banners", () => {
    const healthyHtml = renderToStaticMarkup(
      <SummaryStatusBanner
        meta={sampleData().meta}
        warning={null}
        lastLoadedAt={1_764_000_000_000}
        summarySource="live-api"
        daemonStatus="connected"
      />
    );
    expect(healthyHtml).toContain("History sealed through");
    expect(healthyHtml).not.toContain("warning");

    const degradedHtml = renderToStaticMarkup(
      <SummaryStatusBanner
        meta={{
          ...sampleData().meta,
          todayState: "degraded",
          warnings: [{ scope: "provider", provider: "codex", message: "corrupt tail skipped" }],
        }}
        warning="stale cache refresh"
        lastLoadedAt={1_764_000_000_000}
        summarySource="cached-api"
        daemonStatus="connecting"
      />
    );
    expect(degradedHtml).toContain("2 warnings");
    expect(degradedHtml).toContain("corrupt tail skipped");
    expect(degradedHtml).toContain("stale cache refresh");
  });

  it("TimeOfDayStrip handles missing, insufficient, and ok profiles", () => {
    expect(renderToStaticMarkup(<TimeOfDayStrip profile={undefined} />)).toContain(
      "Not in this summary"
    );

    const insufficient: TokmeterTimeOfDay = {
      status: "insufficient",
      windowDays: 30,
      minDays: 7,
      daysCounted: 3,
      daysSkipped: 0,
      totalCost: 0,
      blocks: [],
      peak: null,
    };
    expect(renderToStaticMarkup(<TimeOfDayStrip profile={insufficient} />)).toContain(
      "Needs 7 days with an hourly cost curve; 3 so far."
    );

    const blocks = Array.from({ length: 8 }, (_, i) => ({
      startHour: i * 3,
      endHour: (i + 1) * 3,
      cost: i === 5 ? 3 : 1,
      share: i === 5 ? 0.3 : 0.1,
    }));
    const ok: TokmeterTimeOfDay = {
      status: "ok",
      windowDays: 30,
      minDays: 7,
      daysCounted: 10,
      daysSkipped: 1,
      totalCost: 10,
      blocks,
      peak: blocks[5],
    };
    const okHtml = renderToStaticMarkup(<TimeOfDayStrip profile={ok} />);
    expect(okHtml).toContain("Busiest 15–18");
    expect(okHtml).toContain("share of est. cost, not tokens");
    expect(okHtml).toContain("10 days");
  });
});
