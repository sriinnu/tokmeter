import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupService, cleanupPreviewDigest } from "./cleanup-service.js";
import type { CleanupPreview } from "./types.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

// ─── Freeze-rule regression tests (restore path) ───────────────────────
// Second freeze leak (commit 3580b40): restore was calling clearRecordCache()
// and re-pricing restored history at current rates. The restore path must
// invalidate the history-snapshot + summary cache while keeping per-record
// frozen costs in the scan-cache untouched.

describe("CleanupService.restore — historical immutability", () => {
  it.todo("does not reprice historical records after restore");
  it.todo("invalidates summary cache + history snapshot without wiping per-record costs");
  it.todo("restored records keep the cost they had at first-scan time, not current kosha rates");
});

describe("CleanupService.execute — cache invalidation is scoped", () => {
  it.todo("invalidateRecordCache is called only with the actually-deleted paths (no full wipe)");

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
});
