/**
 * MCP tool scoping: every number a tool reports must come from the scope,
 * project and providers it was asked for — not lifetime totals under a
 * "Last 7 Days" label — and dates must render as the local days core keys
 * usage under.
 *
 * The fixture is a synthetic HOME (never the real one) holding two sealed
 * relay days — one 3 days ago, one 20 days ago — across two providers and two
 * projects, plus one live Claude Code request today. Expected values are
 * computed here from the fixture constants (an independent ledger), never from
 * tokmeter's own output. TZ is pinned east of UTC so a UTC formatter would
 * print the previous day for the early-morning timestamps used below.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const previousTz = process.env.TZ;
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
const previousCodexHome = process.env.CODEX_HOME;
process.env.TZ = "Asia/Kolkata"; // UTC+05:30, no DST

const fakeHome = mkdtempSync(join(tmpdir(), "tokmeter-mcp-scope-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CODEX_HOME = join(fakeHome, ".codex");

// Pricing would refresh the kosha registry over the network; the fixture's
// sealed days already carry their costs, so price nothing.
vi.mock("@sriinnu/tokmeter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sriinnu/tokmeter")>();
  class OfflineCore extends actual.TokmeterCore {
    constructor(config?: ConstructorParameters<typeof actual.TokmeterCore>[0]) {
      super({ ...config, skipPricing: true });
    }
  }
  return { ...actual, TokmeterCore: OfflineCore };
});

// ── Local-day helpers (independent of the code under test) ──────────────

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysAgo(n: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - n);
  return dayKey(date);
}

/** 00:30 local on a day — 19:00 the previous day in UTC under Asia/Kolkata. */
function earlyMorning(day: string): number {
  return new Date(`${day}T00:30:00`).getTime();
}

const TODAY = daysAgo(0);
const D3 = daysAgo(3);
const D20 = daysAgo(20);
const MONTH_START = `${TODAY.slice(0, 8)}01`;
const WEEK_START = daysAgo(6);

// ── Fixture ledger ───────────────────────────────────────────────────────

interface Bucket {
  day: string;
  project: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  records: number;
}

const SEALED: Bucket[] = [
  {
    day: D3,
    project: "alpha-app",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    input: 300,
    output: 30,
    cost: 3,
    records: 3,
  },
  {
    day: D3,
    project: "beta-svc",
    provider: "codex",
    model: "gpt-5",
    input: 500,
    output: 50,
    cost: 5,
    records: 5,
  },
  {
    day: D20,
    project: "alpha-app",
    provider: "codex",
    model: "gpt-5",
    input: 2000,
    output: 200,
    cost: 20,
    records: 2,
  },
  {
    day: D20,
    project: "beta-svc",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    input: 4000,
    output: 400,
    cost: 40,
    records: 4,
  },
];

/** Today's live request (unpriced: pricing is skipped). */
const TODAY_INPUT = 7;
const TODAY_OUTPUT = 11;

function expected(filter: (b: Bucket) => boolean, includeToday: boolean) {
  const rows = SEALED.filter(filter);
  return {
    cost: rows.reduce((s, b) => s + b.cost, 0),
    records: rows.reduce((s, b) => s + b.records, 0) + (includeToday ? 1 : 0),
    tokens:
      rows.reduce((s, b) => s + b.input + b.output, 0) +
      (includeToday ? TODAY_INPUT + TODAY_OUTPUT : 0),
    days: [...new Set(rows.map((b) => b.day)), ...(includeToday ? [TODAY] : [])].sort(),
  };
}

function writeSealedDay(day: string, buckets: Bucket[]): void {
  const zero = () => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    recordCount: 0,
  });
  type Totals = ReturnType<typeof zero>;
  const add = (target: Totals, source: Totals) => {
    for (const key of Object.keys(source) as (keyof Totals)[]) target[key] += source[key];
  };
  const ts = earlyMorning(day);
  const aggregate = {
    date: day,
    ...zero(),
    firstUsed: ts,
    lastUsed: ts,
    models: {} as Record<string, Totals & { model: string; providers: string[] }>,
    projects: {} as Record<string, Record<string, unknown> & Totals>,
    providers: {} as Record<string, Totals & Record<string, unknown>>,
  };
  for (const b of buckets) {
    const t: Totals = {
      ...zero(),
      inputTokens: b.input,
      outputTokens: b.output,
      totalTokens: b.input + b.output,
      cost: b.cost,
      recordCount: b.records,
    };
    add(aggregate, t);
    aggregate.models[b.model] ??= { model: b.model, providers: [], ...zero() };
    add(aggregate.models[b.model], t);
    if (!aggregate.models[b.model].providers.includes(b.provider)) {
      aggregate.models[b.model].providers.push(b.provider);
    }
    aggregate.projects[b.project] ??= {
      project: b.project,
      ...zero(),
      firstUsed: ts,
      lastUsed: ts,
      models: [] as string[],
      modelBuckets: {} as Record<string, unknown>,
    };
    const project = aggregate.projects[b.project];
    add(project, t);
    (project.models as string[]).push(b.model);
    (project.modelBuckets as Record<string, unknown>)[`${b.provider} ${b.model}`] = {
      model: b.model,
      provider: b.provider,
      ...t,
    };
    aggregate.providers[b.provider] ??= {
      provider: b.provider,
      ...zero(),
      firstUsed: ts,
      lastUsed: ts,
    };
    add(aggregate.providers[b.provider], t);
  }
  const dir = join(fakeHome, ".cache", "tokmeter", "aggregates");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(aggregate), { mode: 0o600 });
}

function writeTodayTranscript(): void {
  const dir = join(fakeHome, ".claude", "projects", "-tmp-alpha-app");
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    uuid: "today-1",
    requestId: "req_today",
    timestamp: new Date(Date.now() - 1_000).toISOString(),
    cwd: "/tmp/alpha-app",
    message: {
      id: "msg_today",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: TODAY_INPUT, output_tokens: TODAY_OUTPUT },
      content: [{ type: "text" }],
    },
  });
  writeFileSync(join(dir, "today.jsonl"), `${line}\n`);
}

let client: Client;
let fmtDate: (ts: number) => string;
let fmtDatetime: (ts: number) => string;

beforeAll(async () => {
  writeSealedDay(
    D3,
    SEALED.filter((b) => b.day === D3)
  );
  writeSealedDay(
    D20,
    SEALED.filter((b) => b.day === D20)
  );
  writeTodayTranscript();

  const server = await import("./server.js");
  fmtDate = server.fmtDate;
  fmtDatetime = server.fmtDatetime;
  const mcp = server.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "scope-test", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(fakeHome, { recursive: true, force: true });
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("TZ", previousTz);
  restore("HOME", previousHome);
  restore("USERPROFILE", previousProfile);
  restore("CODEX_HOME", previousCodexHome);
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("\n");
  expect(result.isError, `${name}: ${text}`).toBeFalsy();
  return text;
}

interface ExportAll {
  scope: string;
  stats: { totalCost: number; totalRecords: number; totalTokens: number };
  daily: { date: string; cost: number }[];
  providers: { provider: string; cost: number; recordCount: number }[];
  projects: { project: string; totalCost: number }[];
  models: { model: string; provider: string; cost: number }[];
}

async function exportAll(args: Record<string, unknown>): Promise<ExportAll> {
  const text = await call("tokmeter_export", { format: "json", data: "all", ...args });
  return JSON.parse(text.split("\nUNTRUSTED DATA")[0]) as ExportAll;
}

function expectMatches(data: ExportAll, want: ReturnType<typeof expected>) {
  expect(data.stats.totalCost).toBeCloseTo(want.cost, 9);
  expect(data.stats.totalRecords).toBe(want.records);
  expect(data.stats.totalTokens).toBe(want.tokens);
  expect(data.daily.map((d) => d.date)).toEqual(want.days);
  // The provider breakdown must reconcile with the scope's totals.
  expect(data.providers.reduce((s, p) => s + p.cost, 0)).toBeCloseTo(want.cost, 9);
  expect(data.providers.reduce((s, p) => s + p.recordCount, 0)).toBe(want.records);
}

describe("scope windows", () => {
  it("week covers today and the six days before it, and excludes the 20-day-old day", async () => {
    const data = await exportAll({ scope: "week" });
    expect(data.daily.map((d) => d.date)).not.toContain(D20);
    expectMatches(
      data,
      expected((b) => b.day >= WEEK_START, true)
    );
    expect(data.scope).toBe(`Last 7 Days (${WEEK_START} → ${TODAY})`);
  });

  it("month covers the calendar month to date", async () => {
    const data = await exportAll({ scope: "month" });
    expectMatches(
      data,
      expected((b) => b.day >= MONTH_START, true)
    );
    expect(data.scope).toBe(`This Month (${MONTH_START} → ${TODAY})`);
  });

  it("all is lifetime: every sealed day plus today", async () => {
    expectMatches(
      await exportAll({ scope: "all" }),
      expected(() => true, true)
    );
  });

  it("today has only the live request", async () => {
    expectMatches(
      await exportAll({ scope: "today" }),
      expected(() => false, true)
    );
  });

  it("labels the pulse with the exact days it covers", async () => {
    const text = await call("tokmeter_pulse", { scope: "week" });
    expect(text).toContain(`Last 7 Days (${WEEK_START} → ${TODAY})`);
    expect(text).toContain(`$${expected((b) => b.day >= WEEK_START, true).cost.toFixed(2)}`);
    expect(text).not.toContain("$68.00");
  });
});

describe("provider and project filters", () => {
  it("narrow the exported totals", async () => {
    expectMatches(
      await exportAll({ providers: ["codex"] }),
      expected((b) => b.provider === "codex", false)
    );
    expectMatches(
      await exportAll({ project: "beta" }),
      expected((b) => b.project === "beta-svc", false)
    );
    expectMatches(
      await exportAll({ project: "alpha", providers: ["codex"] }),
      expected((b) => b.project === "alpha-app" && b.provider === "codex", false)
    );
  });

  it("pulse reports one provider, not every provider", async () => {
    const text = await call("tokmeter_pulse", { providers: ["codex"] });
    expect(text).toContain("$25.00");
    expect(text).toMatch(/Providers\s+1\b/);
  });

  // Each row: a tool, filtered args, text that must appear, text that must not.
  it.each([
    ["tokmeter_models", { providers: ["codex"] }, ["gpt-5"], ["claude-sonnet"]],
    ["tokmeter_models", { project: "beta", providers: ["claude-code"] }, ["$40.00"], ["gpt-5"]],
    ["tokmeter_providers", { providers: ["codex"] }, ["CODEX", "$25.00"], ["CLAUDE-CODE"]],
    ["tokmeter_providers", { project: "beta" }, ["CODEX", "$5.00", "$40.00"], ["$20.00"]],
    ["tokmeter_projects", { providers: ["codex"] }, ["Total: $25.00"], ["$68.00"]],
    ["tokmeter_projects", { project: "beta" }, ["beta-svc"], ["alpha-app"]],
    ["tokmeter_timeline", { providers: ["codex"] }, ["$20.00", "$5.00"], ["$40.00", "$3.00"]],
    ["tokmeter_forecast", { project: "beta" }, ["Based on 2 active day(s)"], []],
    ["tokmeter_digest", { providers: ["codex"] }, ["$25.00", "gpt-5"], ["claude-sonnet"]],
    ["tokmeter_efficiency", { providers: ["codex"] }, ["gpt-5"], ["claude-sonnet"]],
    ["tokmeter_compare", { compare_type: "providers", project: "alpha" }, ["$20.00"], ["$40.00"]],
    ["tokmeter_leaderboard", { project: "beta", rank_by: "records" }, ["4 requests"], ["$20.00"]],
    ["tokmeter_cache_efficiency", { provider: "codex" }, ["Provider: codex"], ["claude-sonnet"]],
    ["tokmeter_model_advisor", { project: "alpha" }, ["$20.00", "$3.00"], ["$40.00"]],
    ["tokmeter_budget", { weekly_budget: 100, providers: ["codex"] }, ["Spent:      $5.00"], []],
    [
      "tokmeter_export",
      { format: "markdown", providers: ["codex"] },
      ["| Total Cost | $25.00 |"],
      ["claude-code"],
    ],
    ["tokmeter_search", { providers: ["claude-code"] }, ["claude-sonnet-4-5"], ["NO DATA"]],
    ["tokmeter_search", { providers: ["codex"] }, ["NO DATA"], ["claude-sonnet-4-5"]],
    ["tokmeter_search", { project: "beta" }, ["NO DATA"], []],
    ["tokmeter_heatmap", { providers: ["codex"] }, ["NO DATA"], []],
  ] as [string, Record<string, unknown>, string[], string[]][])(
    "%s narrows to %j",
    async (name, args, present, absent) => {
      const text = await call(name, args);
      for (const s of present) expect(text, `${name} should contain ${s}`).toContain(s);
      for (const s of absent) expect(text, `${name} should not contain ${s}`).not.toContain(s);
    }
  );
});

describe("dates render local", () => {
  it("formats timestamps as the local day, not the UTC day", () => {
    const ts = earlyMorning(D3);
    expect(new Date(ts).toISOString().slice(0, 10)).not.toBe(D3); // fixture sanity
    expect(fmtDate(ts)).toBe(D3);
    expect(fmtDatetime(ts)).toBe(`${D3} 00:30:00`);
  });

  it("shows sealed project ranges under their local days", async () => {
    const text = await call("tokmeter_projects", { project: "beta" });
    expect(text).toContain(`Range: ${D20} → ${D3}`);
  });
});
