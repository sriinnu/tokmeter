import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CleanupService as CleanupServiceType,
  cleanupPreviewDigest as DigestFn,
} from "./cleanup-service.js";
import type { TokmeterCore as CoreType } from "./tokmeter-core.js";
import type { CleanupPreview } from "./types.js";

const realHome = process.env.HOME;
const scratchHome = mkdtempSync(join(tmpdir(), "tokmeter-cleanup-home-"));
let CleanupService: typeof CleanupServiceType;
let cleanupPreviewDigest: typeof DigestFn;
let TokmeterCore: typeof CoreType;
let store: typeof import("./aggregates-store.js");
let clearRecordCache: typeof import("./parsers/utils.js").clearRecordCache;

beforeAll(async () => {
  process.env.HOME = scratchHome;
  ({ CleanupService, cleanupPreviewDigest } = await import("./cleanup-service.js"));
  ({ TokmeterCore } = await import("./tokmeter-core.js"));
  store = await import("./aggregates-store.js");
  ({ clearRecordCache } = await import("./parsers/utils.js"));
});

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

const tempDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(join(scratchHome, ".tokmeter"), { recursive: true, force: true });
  rmSync(join(scratchHome, ".kosha"), { recursive: true, force: true });
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = (s: string) => new Date(s).getTime();

function claudeLine(id: string, ts: number, out: number, cwd = "/tmp/demo"): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req_${id}`,
    cwd,
    timestamp: new Date(ts).toISOString(),
    message: {
      id: `msg_${id}`,
      model: "claude-x",
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text" }],
    },
  });
}

function writeHermeticPricing(
  overrides: Record<string, { inputPerMillion: number; outputPerMillion: number }>,
  mtimeMs: number
): void {
  const koshaDir = join(scratchHome, ".kosha");
  const tokmeterDir = join(scratchHome, ".tokmeter");
  mkdirSync(koshaDir, { recursive: true });
  mkdirSync(tokmeterDir, { recursive: true });
  const regPath = join(koshaDir, "registry.json");
  writeFileSync(regPath, "{}");
  utimesSync(regPath, new Date(mtimeMs), new Date(mtimeMs));
  const overridePath = join(tokmeterDir, "pricing-overrides.json");
  writeFileSync(overridePath, JSON.stringify(overrides));
  utimesSync(overridePath, new Date(mtimeMs), new Date(mtimeMs));
}

function writeClaudeSession(
  home: string,
  projFolder: string,
  filename: string,
  lines: string[],
  mtimeMs: number
): string {
  const file = join(home, ".claude", "projects", projFolder, filename);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function preview(path = "/tmp/one.jsonl"): CleanupPreview {
  return {
    recordCount: 1,
    sourceFileCount: 1,
    targets: [
      {
        path,
        type: "file",
        sizeBytes: 10,
        provider: "codex",
        description: "session transcript",
      },
    ],
    totalBytes: 10,
    byProvider: [],
    byProject: [],
    partialFileWarnings: [],
  };
}

describe("CleanupService.restore — relay + historical immutability", () => {
  it("surfaces restored historical files on next scan even when relay already reaches yesterday and preserves frozen rates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-29T12:00:00"));
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 100 } },
      at("2026-10-29T11:00:00")
    );

    const home = mkdtempSync(join(tmpdir(), "tokmeter-restore-e2e-"));
    tempDirs.push(home);
    clearRecordCache();

    // Two projects on 2026-10-27 plus an active day on 2026-10-28 (yesterday).
    writeClaudeSession(
      home,
      "-tmp-alpha",
      "alpha.jsonl",
      [claudeLine("A1", at("2026-10-27T10:00:00"), 100, "/tmp/alpha")],
      at("2026-10-27T10:00:00")
    );
    writeClaudeSession(
      home,
      "-tmp-beta",
      "beta.jsonl",
      [claudeLine("B1", at("2026-10-27T11:00:00"), 200, "/tmp/beta")],
      at("2026-10-27T11:00:00")
    );
    writeClaudeSession(
      home,
      "-tmp-yest",
      "yest.jsonl",
      [claudeLine("Y1", at("2026-10-28T15:00:00"), 50, "/tmp/yest")],
      at("2026-10-28T15:00:00")
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: false });
    await core.scan();
    // 2026-10-27: (10+10)*10 + (100+200)*100 per M = 0.0302.
    expect(store.readDayFile(home, "2026-10-27")?.outputTokens).toBe(300);
    expect(store.readDayFile(home, "2026-10-27")?.cost).toBeCloseTo(0.0302, 6);

    // Delete alpha while beta stays on disk and 2026-10-28 stays on disk (maxOnDisk === yesterday).
    const service = new CleanupService(core, home);
    const result = await service.execute({ project: "alpha" }, { backup: true });
    expect(result.deletedCount).toBe(1);
    expect(store.readDayFile(home, "2026-10-27")?.outputTokens).toBe(200);

    // Now change rates: restored records on 2026-10-27 must keep the day's stored 100/M rate.
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 500 } },
      at("2026-10-29T12:05:00")
    );
    vi.setSystemTime(at("2026-10-29T12:06:00"));

    const backupId = result
      .backupPath!.split("/")
      .at(-1)!
      .replace(/\.tar\.gz$/, "");
    const restored = service.restore(backupId);
    expect(restored.errors).toEqual([]);

    // Next scan in a fresh TokmeterCore (simulating separate CLI run after `tokmeter restore`)
    // must pick up alpha despite maxOnDisk === 2026-10-28 >= yesterday, billed at 100/M not 500/M.
    const freshCore = new TokmeterCore({ homeDir: home, skipPricing: false });
    await freshCore.scan();
    const day27 = store.readDayFile(home, "2026-10-27");
    expect(day27?.outputTokens).toBe(300);
    expect(day27?.recordCount).toBe(2);
    expect(day27?.cost).toBeCloseTo(0.0302, 6);
    expect(freshCore.getDailyAggregates().find((d) => d.date === "2026-10-27")?.cost).toBeCloseTo(
      0.0302,
      6
    );
  });

  it("preserves scan-cache frozen costs on snapshot + restore without wiping per-record costs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-29T12:00:00"));
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 100 } },
      at("2026-10-29T11:00:00")
    );

    const home = mkdtempSync(join(tmpdir(), "tokmeter-snap-restore-"));
    tempDirs.push(home);
    clearRecordCache();

    const file = writeClaudeSession(
      home,
      "-tmp-snap",
      "snap.jsonl",
      [claudeLine("S1", at("2026-10-27T10:00:00"), 400, "/tmp/snap")],
      at("2026-10-27T10:00:00")
    );
    const core = new TokmeterCore({ homeDir: home, skipPricing: false });
    await core.scan();
    expect(store.readDayFile(home, "2026-10-27")?.cost).toBeCloseTo(0.0401, 6);

    const service = new CleanupService(core, home);
    const snap = await service.snapshot({ project: "snap" });
    expect(snap.recordCount).toBe(1);

    // Wipe raw file & sealed day, change rates drastically, then restore from snapshot.
    rmSync(file);
    store.deleteDayFile(home, "2026-10-27");
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 900 } },
      at("2026-10-29T12:10:00")
    );

    const backupId = snap.archivePath
      .split("/")
      .at(-1)!
      .replace(/\.tar\.gz$/, "");
    const restored = service.restore(backupId);
    expect(restored.errors).toEqual([]);

    await core.scan();
    expect(store.readDayFile(home, "2026-10-27")?.outputTokens).toBe(400);
    // Cost came from untouched scan-cache entry at first-scan rate (100/M), not 900/M.
    expect(store.readDayFile(home, "2026-10-27")?.cost).toBeCloseTo(0.0401, 6);
  });
});

describe("CleanupService.execute — journal, relay, and metadata accounting", () => {
  it("prevents TodayJournal from resurrecting deleted today session files across scans and refreshes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-29T14:00:00"));

    const home = mkdtempSync(join(tmpdir(), "tokmeter-clean-today-"));
    tempDirs.push(home);
    clearRecordCache();

    writeClaudeSession(
      home,
      "-tmp-delproj",
      "del.jsonl",
      [claudeLine("D1", at("2026-10-29T13:00:00"), 300, "/tmp/delproj")],
      at("2026-10-29T13:00:00")
    );
    writeClaudeSession(
      home,
      "-tmp-keepproj",
      "keep.jsonl",
      [claudeLine("K1", at("2026-10-29T13:30:00"), 50, "/tmp/keepproj")],
      at("2026-10-29T13:30:00")
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();
    expect(core.getTodayAggregate()?.outputTokens).toBe(350);

    const service = new CleanupService(core, home);
    const res = await service.execute({ project: "delproj" }, { backup: false });
    expect(res.deletedCount).toBe(1);

    await core.refreshToday(at("2026-10-29T14:01:00"));
    expect(core.getTodayAggregate()?.outputTokens).toBe(50);

    // A brand-new TokmeterCore reading persisted TodayJournal from disk also stays clean.
    const nextCore = new TokmeterCore({ homeDir: home, skipPricing: true });
    await nextCore.scan();
    expect(nextCore.getTodayAggregate()?.outputTokens).toBe(50);
  });

  it("updates or removes sealed past relay day files and records actual recordCount in backup metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-29T14:00:00"));

    const home = mkdtempSync(join(tmpdir(), "tokmeter-clean-past-"));
    tempDirs.push(home);
    clearRecordCache();

    writeClaudeSession(
      home,
      "-tmp-projA",
      "a.jsonl",
      [
        claudeLine("A1", at("2026-10-27T09:00:00"), 100, "/tmp/projA"),
        claudeLine("A2", at("2026-10-27T09:05:00"), 150, "/tmp/projA"),
      ],
      at("2026-10-27T09:05:00")
    );
    writeClaudeSession(
      home,
      "-tmp-projB",
      "b.jsonl",
      [claudeLine("B1", at("2026-10-27T10:00:00"), 40, "/tmp/projB")],
      at("2026-10-27T10:00:00")
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    await core.scan();
    expect(store.readDayFile(home, "2026-10-27")?.outputTokens).toBe(290);

    const service = new CleanupService(core, home);
    const resA = await service.execute({ project: "projA" }, { backup: true });
    expect(resA.deletedCount).toBe(1);

    // Backup sidecar counts actual records (2), not target file count (1).
    const metaPath = `${resA.backupPath!.replace(/\.tar\.gz$/, ".meta.json")}`;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { recordCount: number };
    expect(meta.recordCount).toBe(2);

    // Day file shrinks cleanly to projB only.
    const afterA = store.readDayFile(home, "2026-10-27");
    expect(afterA?.outputTokens).toBe(40);
    expect(afterA?.recordCount).toBe(1);
    expect(Object.keys(afterA?.projects ?? {})).toEqual(["projB"]);
    expect(core.getDailyAggregates().find((d) => d.date === "2026-10-27")?.outputTokens).toBe(40);

    // Deleting the last remaining file deletes the day file cleanly.
    const resB = await service.execute({ project: "projB" }, { backup: false });
    expect(resB.deletedCount).toBe(1);
    expect(store.readDayFile(home, "2026-10-27")).toBeNull();
    expect(core.getDailyAggregates().find((d) => d.date === "2026-10-27")).toBeUndefined();
    const backups = service.listBackups();
    expect(backups).toHaveLength(1);
  });

  it("subtracts deleted records at the sealed day's stored price cards even if scan-cache misses and rates rose later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-29T12:00:00"));
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 100 } },
      at("2026-10-29T11:00:00")
    );

    const home = mkdtempSync(join(tmpdir(), "tokmeter-clean-pricecard-"));
    tempDirs.push(home);
    clearRecordCache();

    // Sealed day 2026-10-27: projA (100 out -> $0.0101) + projB (200 out -> $0.0201) = $0.0302.
    writeClaudeSession(
      home,
      "-tmp-projA",
      "a.jsonl",
      [claudeLine("A1", at("2026-10-27T09:00:00"), 100, "/tmp/projA")],
      at("2026-10-27T09:00:00")
    );
    writeClaudeSession(
      home,
      "-tmp-projB",
      "b.jsonl",
      [claudeLine("B1", at("2026-10-27T10:00:00"), 200, "/tmp/projB")],
      at("2026-10-27T10:00:00")
    );

    const core = new TokmeterCore({ homeDir: home, skipPricing: false });
    await core.scan();
    expect(store.readDayFile(home, "2026-10-27")?.cost).toBeCloseTo(0.0302, 6);

    // Simulate cache eviction + rate spike to 500/M (projA would re-price to $0.0501 > $0.0302!).
    clearRecordCache();
    writeHermeticPricing(
      { "claude-x": { inputPerMillion: 10, outputPerMillion: 500 } },
      at("2026-10-29T12:05:00")
    );
    vi.setSystemTime(at("2026-10-29T12:06:00"));

    const service = new CleanupService(core, home);
    const res = await service.execute({ project: "projA" }, { backup: false });
    expect(res.deletedCount).toBe(1);

    const remaining = store.readDayFile(home, "2026-10-27");
    expect(remaining?.outputTokens).toBe(200);
    // Must subtract $0.0101 (stored 100/M card), keeping projB at $0.0201 — NOT clamped to $0.
    expect(remaining?.cost).toBeCloseTo(0.0201, 6);
  });

  it("refuses when the fresh target set differs from the approved preview", async () => {
    const service = new CleanupService({} as never, "/tmp");
    vi.spyOn(service, "preview").mockResolvedValue(preview("/tmp/two.jsonl"));
    await expect(
      service.execute(
        { project: "demo" },
        { backup: false, expectedPreviewDigest: cleanupPreviewDigest(preview()) }
      )
    ).rejects.toThrow(/changed after preview/i);
  });

  it("binds the digest to collateral warnings as well as target paths", () => {
    const first = preview();
    const second = preview();
    second.partialFileWarnings.push({
      file: "/tmp/one.jsonl",
      matchedRecords: 1,
      otherRecords: 2,
      otherDateRange: "2026-01-01..2026-01-02",
    });
    expect(cleanupPreviewDigest(first)).not.toBe(cleanupPreviewDigest(second));
  });
});

describe("CleanupService.listBackups — metadata validation", () => {
  it("lists and restores the UUID backup shape produced by snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-backup-roundtrip-"));
    tempDirs.push(home);
    const source = join(home, ".codex", "sessions", "2026", "10", "25", "rollout.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, '{"type":"session_meta"}\n');
    const service = new CleanupService({} as never, home);
    vi.spyOn(service, "preview").mockResolvedValue(preview(source));

    const result = await service.snapshot({ project: "demo" });
    const id = result.archivePath
      .split("/")
      .at(-1)
      ?.replace(/\.tar\.gz$/, "");
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(service.listBackups().map((backup) => backup.id)).toContain(id);

    rmSync(source);
    const restored = service.restore(id as string);
    expect(restored.errors).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });

  it("skips oversized and malformed sidecars and sanitizes rendered labels", () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-backup-meta-"));
    tempDirs.push(home);
    const dir = join(home, ".cache", "tokmeter", "backups");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = "2026-10-25T12-00-00";
    writeFileSync(
      join(dir, `${id}.meta.json`),
      JSON.stringify({
        id,
        path: "/attacker/chosen.tar.gz",
        createdAt: "2026-10-25T12:00:00Z",
        sizeBytes: 10,
        filter: { project: "demo" },
        recordCount: 1,
        providers: ["codex"],
        projects: ["demo\u001b]8;;https://example.invalid\u0007click\u001b]8;;\u0007"],
      })
    );
    writeFileSync(join(dir, "bad.meta.json"), "{".repeat(1024 * 1024 + 1));

    const backups = new CleanupService({} as never, home).listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].path).toBe(join(dir, `${id}.tar.gz`));
    expect(backups[0].projects[0]).toBe("democlick");
  });

  it("preserves matched recordCount for directory cleanup targets instead of counting 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokmeter-backup-dir-"));
    tempDirs.push(home);
    const taskDir = join(home, ".gemini", "tmp", "task-123");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "session.json"), '{"ok":true}\n');
    const service = new CleanupService({} as never, home);
    vi.spyOn(service, "preview").mockResolvedValue({
      ...preview(taskDir),
      recordCount: 4,
      targets: [
        {
          path: taskDir,
          type: "directory",
          sizeBytes: 12,
          provider: "gemini",
          description: "session directory",
        },
      ],
    });

    const snap = await service.snapshot({ project: "demo" });
    expect(snap.recordCount).toBe(4);
    const meta = JSON.parse(
      readFileSync(snap.archivePath.replace(/\.tar\.gz$/, ".meta.json"), "utf-8")
    ) as {
      recordCount: number;
    };
    expect(meta.recordCount).toBe(4);
  });
});
