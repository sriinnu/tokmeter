/**
 * @sriinnu/drishti — Live TUI Dashboard
 *
 * A beautiful, colorful, auto-refreshing terminal dashboard
 * built with Ink (React for terminals).
 *
 * Usage:
 *   import { startLive } from "./live.js";
 *   startLive();
 */

import type { DailyEntry, ModelSummary, ProviderSummary } from "@sriinnu/tokmeter-core";
import { Box, Text, render, useApp, useInput } from "ink";
import React, { useState, useEffect, useMemo } from "react";
import {
  formatBar as barStr,
  formatCost as fmtCost,
  formatNumber as fmtNum,
  sparkline,
} from "./formatter.js";
import { LiveTracker, type Snapshot } from "./tracker.js";

// ─── Formatting Helpers (only TUI-specific ones) ────────────────

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 2) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function burnColor(rate: number): string {
  if (rate < 5) return "green";
  if (rate <= 10) return "yellow";
  return "red";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function padRight(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return " ".repeat(w - s.length) + s;
}

// ─── Tab Definitions ─────────────────────────────────────────────

type TabId = 0 | 1 | 2;
const TAB_NAMES = ["Overview", "Models", "Providers"] as const;

// ─── Header Component ────────────────────────────────────────────

function Header({ tab, lastUpdated }: { tab: TabId; lastUpdated: number }) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="magenta" bold>
            {"【♾️】 DRISHTI"}
          </Text>
          <Text color="gray">{" · Live Token Observatory"}</Text>
        </Text>
        <Text color="gray">
          {"⟳ "}
          {lastUpdated > 0 ? timeAgo(lastUpdated) : "..."}
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        {TAB_NAMES.map((name, i) => (
          <Text key={name} bold={tab === i} color={tab === i ? "cyan" : "gray"}>
            {tab === i ? `[${i + 1}] ${name}` : ` ${i + 1}  ${name}`}
          </Text>
        ))}
        <Box flexGrow={1} />
        <Text color="gray">{"q:quit  r:refresh"}</Text>
      </Box>
    </Box>
  );
}

// ─── Token Card ──────────────────────────────────────────────────

function TokenCard({
  title,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
  cost,
  borderColor,
}: {
  title: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  borderColor?: string;
}) {
  const totalCache = cacheReadTokens + cacheWriteTokens;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor ?? "cyan"}
      paddingX={1}
      minWidth={30}
    >
      <Text bold color="cyan">
        {"─ "}
        {title}
        {" ─"}
      </Text>
      <Box>
        <Text color="blue">{"  ↑ Input   "}</Text>
        <Text bold>{padLeft(fmtNum(inputTokens), 10)}</Text>
      </Box>
      <Box>
        <Text color="red">{"  ↓ Output  "}</Text>
        <Text bold>{padLeft(fmtNum(outputTokens), 10)}</Text>
      </Box>
      <Box>
        <Text color="gray">{"  ⟳ Cache   "}</Text>
        <Text bold>{padLeft(fmtNum(totalCache), 10)}</Text>
      </Box>
      <Box>
        <Text color="magenta">{"  ◆ Think   "}</Text>
        <Text bold>{padLeft(fmtNum(reasoningTokens), 10)}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="gray">{"  ─────────────────────"}</Text>
      </Box>
      <Box>
        <Text bold>{"  TOTAL     "}</Text>
        <Text bold color="yellow">
          {padLeft(fmtCost(cost), 10)}
        </Text>
      </Box>
    </Box>
  );
}

// ─── Model Bar Row ───────────────────────────────────────────────

function ModelBarRow({
  model,
  cost,
  percentage,
  maxCost,
  rank,
  barWidth,
}: {
  model: ModelSummary;
  cost: number;
  percentage: number;
  maxCost: number;
  rank: number;
  barWidth: number;
}) {
  return (
    <Box gap={1}>
      <Text color="gray">{`${rank}.`}</Text>
      <Text bold>{padRight(truncate(model.model, 22), 22)}</Text>
      <Text color="gray">{padRight(model.provider, 10)}</Text>
      <Text color="blue">{padLeft(`↑${fmtNum(model.inputTokens)}`, 9)}</Text>
      <Text color="red">{padLeft(`↓${fmtNum(model.outputTokens)}`, 9)}</Text>
      <Text color="gray">{padLeft(`⟳${fmtNum(model.cacheReadTokens + model.cacheWriteTokens)}`, 9)}</Text>
      <Text color="green">{barStr(cost, maxCost, barWidth)}</Text>
      <Text bold color="yellow">
        {padLeft(fmtCost(cost), 7)}
      </Text>
      <Text color="gray">{padLeft(`${percentage.toFixed(1)}%`, 6)}</Text>
    </Box>
  );
}

// ─── Burn Rate Bar ───────────────────────────────────────────────

function BurnRateBar({ snapshot }: { snapshot: Snapshot }) {
  const { burnRate, tokensPerMin } = snapshot;
  const stats = snapshot.stats;
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="center" gap={2}>
      <Text>
        <Text bold color={burnColor(burnRate)}>
          {"BURN: "}
          {fmtCost(burnRate)}
          {"/hr"}
        </Text>
      </Text>
      <Text color="gray">{"·"}</Text>
      <Text>
        <Text color="cyan" bold>
          {"⚡ "}
          {fmtNum(tokensPerMin)}
          {" tok/min"}
        </Text>
      </Text>
      <Text color="gray">{"·"}</Text>
      <Text>
        <Text color="blue">
          {"📁 "}
          {stats.projects}
          {" proj"}
        </Text>
      </Text>
      <Text color="gray">{"·"}</Text>
      <Text>
        <Text color="magenta">
          {"🤖 "}
          {stats.models}
          {" models"}
        </Text>
      </Text>
    </Box>
  );
}

// ─── Provider Inline ─────────────────────────────────────────────

function ProviderBar({ providers }: { providers: ProviderSummary[] }) {
  if (providers.length === 0) return null;
  return (
    <Box paddingX={1} gap={1} flexWrap="wrap">
      <Text bold color="cyan">
        {"PROVIDERS "}
      </Text>
      {providers.slice(0, 6).map((p, i) => (
        <Text key={p.provider}>
          {i > 0 && <Text color="gray">{" │ "}</Text>}
          <Text bold>{p.provider}</Text>
          <Text color="yellow">{` ${fmtCost(p.cost)}`}</Text>
          <Text color="gray">{` (${p.percentageOfTotal.toFixed(0)}%)`}</Text>
        </Text>
      ))}
    </Box>
  );
}

// ─── Sparkline Row ───────────────────────────────────────────────

function SparklineRow({ daily }: { daily: DailyEntry[] }) {
  const last7 = daily.slice(-7);
  if (last7.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">{"No daily data yet"}</Text>
      </Box>
    );
  }
  const costs = last7.map((d) => d.cost);
  const spark = sparkline(costs);
  return (
    <Box paddingX={1} gap={1}>
      <Text bold color="cyan">
        {"LAST 7 DAYS "}
      </Text>
      <Text color="green" bold>
        {spark}
      </Text>
      <Text color="gray"> </Text>
      {last7.map((d) => (
        <Text key={d.date} color="yellow">
          {fmtCost(d.cost)}{" "}
        </Text>
      ))}
    </Box>
  );
}

// ─── Overview Tab ────────────────────────────────────────────────

function OverviewTab({ snapshot }: { snapshot: Snapshot }) {
  const { stats, models, providers, daily, sessionTokens } = snapshot;

  // Use precomputed token breakdown from tracker — avoids O(n) per frame
  const {
    inputTokens: sessionInput,
    outputTokens: sessionOutput,
    cacheReadTokens: sessionCacheRead,
    cacheWriteTokens: sessionCacheWrite,
    reasoningTokens: sessionReasoning,
  } = sessionTokens;

  const todayRecords = daily.length > 0 ? daily[daily.length - 1] : null;
  const maxCost = models.length > 0 ? models[0].cost : 1;
  const topModels = models.slice(0, 10);

  return (
    <Box flexDirection="column" gap={1}>
      {/* Token Cards */}
      <Box gap={2}>
        <TokenCard
          title="SESSION"
          inputTokens={sessionInput}
          outputTokens={sessionOutput}
          cacheReadTokens={sessionCacheRead}
          cacheWriteTokens={sessionCacheWrite}
          reasoningTokens={sessionReasoning}
          cost={snapshot.sessionCost}
          borderColor="cyan"
        />
        <TokenCard
          title="TODAY"
          inputTokens={todayRecords?.inputTokens ?? 0}
          outputTokens={todayRecords?.outputTokens ?? 0}
          cacheReadTokens={todayRecords?.cacheReadTokens ?? 0}
          cacheWriteTokens={todayRecords?.cacheWriteTokens ?? 0}
          reasoningTokens={todayRecords?.reasoningTokens ?? 0}
          cost={snapshot.todayCost}
          borderColor="magenta"
        />
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          minWidth={28}
        >
          <Text bold color="yellow">
            {"─ ALL TIME ─"}
          </Text>
          <Box>
            <Text>{"  Records  "}</Text>
            <Text bold>{padLeft(fmtNum(stats.totalRecords), 10)}</Text>
          </Box>
          <Box>
            <Text>{"  Tokens   "}</Text>
            <Text bold>{padLeft(fmtNum(stats.totalTokens), 10)}</Text>
          </Box>
          <Box>
            <Text>{"  Days     "}</Text>
            <Text bold>{padLeft(String(stats.activeDays), 10)}</Text>
          </Box>
          <Box>
            <Text>{"  Streak   "}</Text>
            <Text bold color="green">
              {padLeft(`${stats.longestStreak}d`, 10)}
            </Text>
          </Box>
          <Text color="gray">{"  ─────────────────────"}</Text>
          <Box>
            <Text bold>{"  TOTAL    "}</Text>
            <Text bold color="yellow">
              {padLeft(fmtCost(stats.totalCost), 10)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Model Bars */}
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between" marginBottom={0}>
          <Text bold color="cyan">
            {"MODELS"}
          </Text>
          <Text bold color="gray">
            {"COST"}
          </Text>
        </Box>
        {topModels.map((m, i) => (
          <ModelBarRow
            key={`${m.provider}-${m.model}`}
            model={m}
            cost={m.cost}
            percentage={m.percentageOfTotal}
            maxCost={maxCost}
            rank={i + 1}
            barWidth={16}
          />
        ))}
        {models.length === 0 && <Text color="gray">{"  No model data yet"}</Text>}
      </Box>

      {/* Burn Rate */}
      <BurnRateBar snapshot={snapshot} />

      {/* Providers */}
      <ProviderBar providers={providers} />

      {/* Sparkline */}
      <SparklineRow daily={daily} />
    </Box>
  );
}

// ─── Models Tab ──────────────────────────────────────────────────

function ModelsTab({ snapshot }: { snapshot: Snapshot }) {
  const { models } = snapshot;
  const maxCost = models.length > 0 ? models[0].cost : 1;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        {"MODEL BREAKDOWN"}
      </Text>
      <Box marginY={0}>
        <Text color="gray">
          {padRight("Model", 24)}
          {padRight("Provider", 14)}
          {padLeft("Input", 9)}
          {padLeft("Output", 9)}
          {padLeft("Cache", 9)}
          {padLeft("Think", 9)}
          {padLeft("Total", 9)}
          {"  "}
          {padRight("Bar", 16)}
          {padLeft("Cost", 8)}
          {padLeft("%", 7)}
        </Text>
      </Box>
      <Text color="gray">{"─".repeat(108)}</Text>
      {models.map((m, _i) => (
        <Box key={`${m.provider}-${m.model}`}>
          <Text bold>{padRight(truncate(m.model, 23), 24)}</Text>
          <Text color="gray">{padRight(m.provider, 14)}</Text>
          <Text color="blue">{padLeft(fmtNum(m.inputTokens), 9)}</Text>
          <Text color="red">{padLeft(fmtNum(m.outputTokens), 9)}</Text>
          <Text color="gray">{padLeft(fmtNum(m.cacheReadTokens + m.cacheWriteTokens), 9)}</Text>
          <Text color="magenta">{padLeft(fmtNum(m.reasoningTokens), 9)}</Text>
          <Text>{padLeft(fmtNum(m.totalTokens), 9)}</Text>
          <Text>{"  "}</Text>
          <Text color="green">{barStr(m.cost, maxCost, 16)}</Text>
          <Text bold color="yellow">
            {padLeft(fmtCost(m.cost), 8)}
          </Text>
          <Text color="gray">{padLeft(`${m.percentageOfTotal.toFixed(1)}%`, 7)}</Text>
        </Box>
      ))}
      {models.length === 0 && (
        <Text color="gray" italic>
          {"  No model data yet — start using your AI tools!"}
        </Text>
      )}
      <Box marginTop={1}>
        <Text color="gray">
          {"Legend: "}
          <Text color="blue">{"Input"}</Text>
          {" · "}
          <Text color="red">{"Output"}</Text>
          {" · "}
          <Text color="gray">{"Cache"}</Text>
          {" · "}
          <Text color="magenta">{"Think"}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ─── Providers Tab ───────────────────────────────────────────────

function ProvidersTab({ snapshot }: { snapshot: Snapshot }) {
  const { providers } = snapshot;
  const maxCost = providers.length > 0 ? providers[0].cost : 1;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Text bold color="cyan">
        {"PROVIDER BREAKDOWN"}
      </Text>
      {providers.map((p, i) => (
        <Box
          key={p.provider}
          flexDirection="column"
          borderStyle="round"
          borderColor={i === 0 ? "cyan" : "gray"}
          paddingX={1}
        >
          <Box justifyContent="space-between">
            <Text bold color={i === 0 ? "cyan" : "white"}>
              {`${i + 1}. ${p.provider}`}
            </Text>
            <Text>
              <Text bold color="yellow">
                {fmtCost(p.cost)}
              </Text>
              <Text color="gray">{` (${p.percentageOfTotal.toFixed(1)}%)`}</Text>
            </Text>
          </Box>
          <Box gap={1}>
            <Text color="green" bold>
              {barStr(p.cost, maxCost, 30)}
            </Text>
            <Text color="gray">
              {fmtNum(p.totalTokens)}
              {" tokens"}
            </Text>
          </Box>
          <Box gap={1} flexWrap="wrap">
            <Text color="gray">{"Models: "}</Text>
            {p.models.map((m, mi) => (
              <Text key={m}>
                {mi > 0 && <Text color="gray">{", "}</Text>}
                <Text color="magenta">{truncate(m, 30)}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      ))}
      {providers.length === 0 && (
        <Text color="gray" italic>
          {"  No provider data yet — start using your AI tools!"}
        </Text>
      )}

      {/* Summary footer */}
      {providers.length > 0 && (
        <Box paddingX={1} gap={2}>
          <Text color="gray">
            {"Total: "}
            <Text bold color="yellow">
              {fmtCost(providers.reduce((s, p) => s + p.cost, 0))}
            </Text>
            {" across "}
            <Text bold>{providers.length}</Text>
            {" provider"}
            {providers.length !== 1 ? "s" : ""}
            {" and "}
            <Text bold>{providers.reduce((s, p) => s + p.models.length, 0)}</Text>
            {" model"}
            {providers.reduce((s, p) => s + p.models.length, 0) !== 1 ? "s" : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ─── Loading Screen ──────────────────────────────────────────────

function LoadingScreen() {
  const [elapsed, setElapsed] = useState(0);
  const [dots, setDots] = useState("");

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((e) => e + 1);
      setDots((d) => (d.length >= 3 ? "" : `${d}.`));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      borderStyle="double"
      borderColor="magenta"
      paddingX={4}
      paddingY={2}
    >
      <Text bold color="magenta">
        {"【♾️】 DRISHTI"}
      </Text>
      <Text color="gray">{"Live Token Observatory"}</Text>
      <Box marginTop={1}>
        <Text color="cyan">{`⟳ Scanning token usage${dots}`}</Text>
      </Box>
      <Box marginTop={0}>
        <Text color="gray">{`${elapsed}s — first scan parses all session files`}</Text>
      </Box>
    </Box>
  );
}

// ─── Error Banner ────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} marginBottom={1}>
      <Text color="red" bold>
        {"ERROR: "}
      </Text>
      <Text color="red">{message}</Text>
    </Box>
  );
}

// ─── Main App ────────────────────────────────────────────────────

function App() {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<TabId>(0);
  const [error, setError] = useState<string | null>(null);

  const tracker = useMemo(() => new LiveTracker({ refreshMs: 2000 }), []);

  useEffect(() => {
    let mounted = true;

    tracker.on("update", (snap: Snapshot) => {
      if (mounted) {
        setSnapshot(snap);
        setError(null);
      }
    });

    tracker.on("error", (err: Error) => {
      if (mounted) {
        setError(err.message);
      }
    });

    tracker
      .start()
      .then(() => {
        if (mounted) {
          setSnapshot(tracker.snapshot);
        }
      })
      .catch((err: Error) => {
        if (mounted) {
          setError(err.message);
        }
      });

    return () => {
      mounted = false;
      tracker.stop();
    };
  }, [tracker]);

  // ─── Keyboard Input ──────────────────────────────────────────

  useInput((input, key) => {
    // Quit
    if (input === "q" || key.escape) {
      tracker.stop();
      exit();
      process.exit(0);
      return;
    }

    // Manual refresh
    if (input === "r") {
      tracker.refresh();
      return;
    }

    // Tab switching by number
    if (input === "1") {
      setTab(0);
      return;
    }
    if (input === "2") {
      setTab(1);
      return;
    }
    if (input === "3") {
      setTab(2);
      return;
    }

    // Arrow keys
    if (key.leftArrow) {
      setTab(((tab - 1 + 3) % 3) as TabId);
      return;
    }
    if (key.rightArrow) {
      setTab(((tab + 1) % 3) as TabId);
      return;
    }

    // Tab key cycles forward
    if (key.tab) {
      setTab(((tab + 1) % 3) as TabId);
      return;
    }
  });

  // ─── Render ──────────────────────────────────────────────────

  if (!snapshot) {
    return <LoadingScreen />;
  }

  return (
    <Box flexDirection="column">
      <Header tab={tab} lastUpdated={snapshot.lastUpdated} />

      {error && <ErrorBanner message={error} />}

      <Box flexDirection="column" paddingX={1} paddingY={1}>
        {tab === 0 && <OverviewTab snapshot={snapshot} />}
        {tab === 1 && <ModelsTab snapshot={snapshot} />}
        {tab === 2 && <ProvidersTab snapshot={snapshot} />}
      </Box>

      <Box paddingX={1} gap={2}>
        <Text color="gray">{"cache: ~/.cache/tokmeter/scan-cache.json"}</Text>
        <Text color="gray">{"│ mtime+append strategy"}</Text>
        <Text color="gray">{"│ refresh: 2s"}</Text>
        <Text color="gray">{`│ ${snapshot.records.length} records`}</Text>
      </Box>
    </Box>
  );
}

// ─── Public Entry Point ──────────────────────────────────────────

export function startLive(): void {
  render(React.createElement(App)).waitUntilExit();
}
