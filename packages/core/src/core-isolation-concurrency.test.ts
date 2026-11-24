import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyAccumulator, readDayFile, sealRolledOverDay } from "./aggregates-store.js";
import { appendAntigravitySnapshot, readSnapshotHistory } from "./antigravity-live.js";
import { readBaselines } from "./parsers/cumulative-baselines.js";
import { MuxParser } from "./parsers/mux.js";
import {
  clearRecordCache,
  peekCachedRecords,
  saveRecordCacheToDisk,
  setCachedRecords,
} from "./parsers/utils.js";
import { ZedParser } from "./parsers/zed.js";
import { readQuotaStore, recordQuotaSamples } from "./quota.js";
import { TodayJournal } from "./today-journal.js";
import { TokmeterCore } from "./tokmeter-core.js";
import type { TokenRecord } from "./types.js";

const tempDirs: string[] = [];

function makeTempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeClaudeLine(id: string, timestampMs: number, outputTokens: number, cwd = "/tmp/app") {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req-${id}`,
    timestamp: new Date(timestampMs).toISOString(),
    cwd,
    message: {
      id: `msg-${id}`,
      model: "claude-x",
      usage: { input_tokens: 10, output_tokens: outputTokens },
      content: [{ type: "text" }],
    },
  });
}

function writeClaudeFile(home: string, rel: string, lines: string[], mtimeMs: number): string {
  const file = join(home, ".claude", "projects", "-tmp-app", rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function writeOverrides(
  home: string,
  overrides: Record<string, { inputPerMillion: number; outputPerMillion: number }>,
  mtimeMs: number
): void {
  const koshaDir = join(home, ".kosha");
  const koshaCacheDir = join(koshaDir, "cache");
  const tokDir = join(home, ".tokmeter");
  mkdirSync(koshaCacheDir, { recursive: true });
  mkdirSync(tokDir, { recursive: true });
  utimesSync(koshaCacheDir, new Date(mtimeMs), new Date(mtimeMs));
  const regPath = join(koshaDir, "registry.json");
  writeFileSync(regPath, "{}");
  utimesSync(regPath, new Date(mtimeMs), new Date(mtimeMs));
  const overridesPath = join(tokDir, "pricing-overrides.json");
  writeFileSync(overridesPath, JSON.stringify(overrides));
  utimesSync(overridesPath, new Date(mtimeMs), new Date(mtimeMs));
}

function makeRecord(
  id: string,
  timestamp: number,
  sourceFile: string,
  outputTokens = 50
): TokenRecord {
  return {
    timestamp,
    project: "app",
    provider: "claude-code",
    model: "claude-x",
    apiCallId: id,
    sourceFile,
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    clearRecordCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("core caching, singleton isolation, and concurrency (#290)", () => {
  it("refreshToday() skips rewriting scan-cache.json when clean and flushes on demand", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-15T12:00:00").getTime();
    vi.setSystemTime(now);
    const home = makeTempHome("tokmeter-cache-dirty-");
    const file = writeClaudeFile(
      home,
      "sess.jsonl",
      [writeClaudeLine("1", now - 2000, 100)],
      now - 2000
    );
    writeOverrides(
      home,
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 100 } },
      now - 5000
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: false });
    await core.scan();

    const cachePath = join(home, ".cache", "tokmeter", "scan-cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const backdatedMs = Math.floor((now - 120_000) / 1000) * 1000;
    utimesSync(cachePath, new Date(backdatedMs), new Date(backdatedMs));

    await core.refreshToday(now);
    expect(Math.floor(statSync(cachePath).mtimeMs)).toBe(backdatedMs);

    writeFileSync(
      file,
      `${writeClaudeLine("1", now - 2000, 100)}\n${writeClaudeLine("2", now - 500, 200)}\n`
    );
    utimesSync(file, new Date(now), new Date(now));
    await core.refreshToday(now + 100);
    core.flushRecordCache();
    expect(statSync(cachePath).mtimeMs).toBeGreaterThan(backdatedMs);
  });

  it("resets touchedPaths per GC sweep so deleted files are evicted later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-10T10:00:00").getTime();
    vi.setSystemTime(t0);

    const home = makeTempHome("tokmeter-cache-gc-");
    const keepFile = join(home, "keep.jsonl");
    const goneFile = join(home, "gone.jsonl");
    writeFileSync(keepFile, "{}\n");
    writeFileSync(goneFile, "{}\n");

    await setCachedRecords(
      keepFile,
      [makeRecord("k1", t0, keepFile)],
      { mtimeMs: 1, sizeBytes: 3 },
      home
    );
    await setCachedRecords(
      goneFile,
      [makeRecord("g1", t0, goneFile)],
      { mtimeMs: 1, sizeBytes: 3 },
      home
    );
    saveRecordCacheToDisk(home, { force: true });

    expect(peekCachedRecords(keepFile, home)).toHaveLength(1);
    expect(peekCachedRecords(goneFile, home)).toHaveLength(1);

    unlinkSync(goneFile);
    vi.setSystemTime(t0 + 6 * 60_000);
    await setCachedRecords(
      keepFile,
      [makeRecord("k1", t0, keepFile)],
      { mtimeMs: 2, sizeBytes: 3 },
      home
    );
    saveRecordCacheToDisk(home, { force: true });

    expect(peekCachedRecords(keepFile, home)).toHaveLength(1);
    expect(peekCachedRecords(goneFile, home)).toBeNull();
  });

  it("isolates concurrent TokmeterCore({ homeDir }) instances without HOME overrides", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-15T12:00:00").getTime();
    vi.setSystemTime(now);
    const homeA = makeTempHome("tokmeter-iso-a-");
    const homeB = makeTempHome("tokmeter-iso-b-");

    const fileA = writeClaudeFile(
      homeA,
      "a.jsonl",
      [writeClaudeLine("A1", now - 1000, 100)],
      now - 1000
    );
    const fileB = writeClaudeFile(
      homeB,
      "b.jsonl",
      [writeClaudeLine("B1", now - 1000, 100)],
      now - 1000
    );
    writeOverrides(
      homeA,
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 100 } },
      now - 5000
    );
    writeOverrides(
      homeB,
      { "claude-x": { inputPerMillion: 50, outputPerMillion: 500 } },
      now - 5000
    );

    const coreA = new TokmeterCore({ homeDir: homeA, skipPricing: false });
    const coreB = new TokmeterCore({ homeDir: homeB, skipPricing: false });

    const [recA, recB] = await Promise.all([coreA.scan(), coreB.scan()]);
    expect(recA).toHaveLength(1);
    expect(recB).toHaveLength(1);
    expect(coreA.getSummary().stats.totalCost).toBeCloseTo(0.0101, 6);
    expect(coreB.getSummary().stats.totalCost).toBeCloseTo(0.0505, 6);
    expect(peekCachedRecords(fileA, homeB)).toBeNull();
    expect(peekCachedRecords(fileB, homeA)).toBeNull();
    expect(existsSync(join(homeA, ".cache", "tokmeter", "scan-cache.json"))).toBe(true);
    expect(existsSync(join(homeB, ".cache", "tokmeter", "scan-cache.json"))).toBe(true);
    expect((coreA as unknown as { parsers: unknown[] }).parsers[0]).not.toBe(
      (coreB as unknown as { parsers: unknown[] }).parsers[0]
    );
  });

  it("synchronizes concurrent MuxParser + ZedParser updates in cumulative-baselines.json", async () => {
    const home = makeTempHome("tokmeter-mux-zed-");
    const dayMs = Date.now();
    const dayIso = new Date(dayMs).toISOString();

    const muxDir = join(home, ".mux", "sessions", "ws-1");
    mkdirSync(muxDir, { recursive: true });
    writeFileSync(
      join(muxDir, "session-usage.json"),
      JSON.stringify({
        timestamp: dayIso,
        byModel: { "anthropic:claude-x": { input: 120, output: 30 } },
      })
    );

    const zedDir = join(home, "Library", "Application Support", "Zed", "threads");
    mkdirSync(zedDir, { recursive: true });
    const dbPath = join(zedDir, "threads.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        summary TEXT,
        updated_at TEXT,
        created_at TEXT,
        data_type TEXT,
        data BLOB,
        folder_paths TEXT,
        folder_paths_order TEXT
      )
    `);
    const payload = Buffer.from(
      JSON.stringify({
        model: { provider: "anthropic", model: "claude-x" },
        cumulative_token_usage: { input_tokens: 240, output_tokens: 60 },
      }),
      "utf-8"
    );
    db.prepare(
      "INSERT INTO threads (id, summary, updated_at, created_at, data_type, data, folder_paths, folder_paths_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "t-1",
      "test",
      dayIso,
      new Date(dayMs).toISOString(),
      "json",
      payload,
      "/tmp/zed-app",
      "0"
    );
    db.close();

    const mux = new MuxParser();
    const zed = new ZedParser();
    const [muxRecords, zedRecords] = await Promise.all([mux.scan(home), zed.scan(home)]);
    expect(muxRecords).toHaveLength(1);
    expect(zedRecords).toHaveLength(1);

    const baselines = readBaselines(home);
    const keys = Object.keys(baselines);
    expect(keys.some((k) => k.startsWith("mux:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("zed:"))).toBe(true);
  });

  it("serializes overlapping scan() and refreshToday() calls without deadlocking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-15T12:00:00").getTime();
    vi.setSystemTime(now);
    const home = makeTempHome("tokmeter-mutex-");
    writeClaudeFile(home, "s.jsonl", [writeClaudeLine("1", now - 1000, 100)], now - 1000);

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    const results = await Promise.all([
      core.refreshToday(now),
      core.scan(),
      core.refreshToday(now + 10),
    ]);

    for (const r of results) expect(r).toHaveLength(1);
    expect(core.getSummary().stats.totalTokens).toBe(110);
  });

  it("TodayJournal preserves carried units across concurrent writers for the same homeDir", () => {
    const home = makeTempHome("tokmeter-journal-lock-");
    const now = new Date("2026-10-15T12:00:00").getTime();
    const fileA = join(home, ".claude", "projects", "a", "a.jsonl");
    const fileB = join(home, ".claude", "projects", "b", "b.jsonl");
    const recA = makeRecord("id-a", now - 1000, fileA, 10);
    const recB = makeRecord("id-b", now - 1000, fileB, 20);

    const writerA = new TodayJournal(home);
    const writerB = new TodayJournal(home);
    writerA.reconcile([recA, recB], now);
    writerB.reconcile([recA, recB], now + 100);

    writerA.reconcile([recB], now + 200);
    writerB.reconcile([recA], now + 300);

    const reader = new TodayJournal(home);
    const merged = reader.reconcile([], now + 400);
    expect(merged.map((r) => r.apiCallId).sort()).toEqual(["id-a", "id-b"]);
    const files = readdirSync(join(home, ".cache", "tokmeter", "today"));
    expect(files.some((f) => f.endsWith(".lock"))).toBe(false);
  });

  it("recordQuotaSamples compacts safely without losing active samples or leaking lock/tmp files", () => {
    const home = makeTempHome("tokmeter-quota-compact-");
    const now = Date.now();
    const oldAt = now - 10 * 86_400_000;

    recordQuotaSamples(
      home,
      [
        {
          agent: "claude-code",
          windowMinutes: 300,
          usedPct: 20,
          resetsAt: Math.floor(oldAt / 1000) + 60,
          at: oldAt,
        },
        {
          agent: "claude-code",
          windowMinutes: 300,
          usedPct: 35,
          resetsAt: Math.floor(now / 1000) + 3600,
          at: now - 1000,
        },
        {
          agent: "claude-code",
          windowMinutes: 300,
          usedPct: 50,
          resetsAt: Math.floor(now / 1000) + 3600,
          at: now,
        },
      ],
      { compactThresholdBytes: 120 }
    );

    const kept = readQuotaStore(home, "claude-code");
    expect(kept.every((s) => s.at >= now - 8 * 86_400_000)).toBe(true);
    expect(kept.map((s) => s.usedPct)).toEqual([35, 50]);
    const quotaFiles = readdirSync(join(home, ".cache", "tokmeter", "quota"));
    expect(quotaFiles).toEqual(["claude-code.jsonl"]);
  });

  it("sealRolledOverDay seals once under lock and preserves immutable existing day files", () => {
    const home = makeTempHome("tokmeter-seal-lock-");
    const yesterday = "2026-10-14";
    const today = "2026-10-15";
    const ts = new Date(`${yesterday}T10:00:00`).getTime();

    const first = new DailyAccumulator(yesterday);
    first.fold(makeRecord("s1", ts, join(home, "s1.jsonl"), 100));
    const sealed = sealRolledOverDay(home, first, today);
    expect(sealed?.outputTokens).toBe(100);

    const contender = new DailyAccumulator(yesterday);
    contender.fold(makeRecord("s2", ts + 1000, join(home, "s2.jsonl"), 999));
    expect(sealRolledOverDay(home, contender, today)).toBeNull();
    expect(readDayFile(home, yesterday)?.outputTokens).toBe(100);

    const aggFiles = readdirSync(join(home, ".cache", "tokmeter", "aggregates"));
    expect(aggFiles.some((f) => f.endsWith(".lock"))).toBe(false);
  });

  it("appendAntigravitySnapshot prunes oversized logs and cleans up its lock", () => {
    const home = makeTempHome("tokmeter-ag-prune-");
    const snap = (i: number) => ({
      timestamp: 1_760_000_000_000 + i * 1000,
      availablePromptCredits: 1000 - i,
      availableFlowCredits: 500,
      models: [{ label: "gemini-pro" }],
    });

    for (let i = 0; i < 6; i++) {
      appendAntigravitySnapshot(snap(i), home, { maxBytes: 400, keepLast: 2 });
    }

    const history = readSnapshotHistory(home);
    expect(history).toHaveLength(2);
    expect(history.map((s) => s.timestamp)).toEqual([
      1_760_000_000_000 + 4000,
      1_760_000_000_000 + 5000,
    ]);
    const cacheFiles = readdirSync(join(home, ".cache", "tokmeter"));
    expect(cacheFiles.some((f) => f.endsWith(".lock"))).toBe(false);
    // Sanity check file is small and readable JSONL
    expect(
      readFileSync(join(home, ".cache", "tokmeter", "antigravity-live-snapshots.jsonl"), "utf8")
        .trim()
        .split("\n")
    ).toHaveLength(2);
  });
});
