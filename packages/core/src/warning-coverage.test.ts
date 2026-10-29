import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ScanWarning } from "./types.js";
import { faultTouchesDay, warningsBlockDay } from "./warning-coverage.js";

const at = (s: string) => new Date(s).getTime();
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warning-coverage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileWithMtime(name: string, mtime: number): string {
  const file = join(dir, name);
  writeFileSync(file, "x");
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

const fault = (extra: Partial<ScanWarning> = {}): ScanWarning => ({
  scope: "provider",
  provider: "claude-code",
  message: "claude-code partial scan: boom",
  partial: true,
  ...extra,
});

describe("faultTouchesDay", () => {
  test("a fault without a file touches every day", () => {
    expect(faultTouchesDay(fault(), "2026-10-28")).toBe(true);
  });

  test("notices and non-provider warnings never block", () => {
    expect(faultTouchesDay(fault({ notice: true }), "2026-10-28")).toBe(false);
    expect(faultTouchesDay({ scope: "history", message: "x" }, "2026-10-28")).toBe(false);
  });

  test("a file last written before the day began can't hold it", () => {
    const file = fileWithMtime("old.jsonl", at("2026-10-27T18:00:00"));
    expect(faultTouchesDay(fault({ file }), "2026-10-28")).toBe(false);
    expect(faultTouchesDay(fault({ file }), "2026-10-27")).toBe(true);
  });

  test("an unread tail newer than the day can't hold it", () => {
    const file = fileWithMtime("active.jsonl", at("2026-10-29T00:00:03"));
    const w = fault({ file, readThroughMs: at("2026-10-29T00:00:01") });
    expect(faultTouchesDay(w, "2026-10-28")).toBe(false);
    expect(faultTouchesDay(w, "2026-10-29")).toBe(true);
    // Read only through 23:40: the unread tail may still be the 28th.
    expect(
      faultTouchesDay(fault({ file, readThroughMs: at("2026-10-28T23:40:00") }), "2026-10-28")
    ).toBe(true);
  });

  test("a vanished file can't be placed, so it blocks", () => {
    expect(faultTouchesDay(fault({ file: join(dir, "gone.jsonl") }), "2026-10-28")).toBe(true);
  });

  test("warningsBlockDay is any-of", () => {
    const old = fileWithMtime("old.jsonl", at("2026-10-20T12:00:00"));
    expect(warningsBlockDay([fault({ file: old })], "2026-10-28")).toBe(false);
    expect(warningsBlockDay([fault({ file: old }), fault()], "2026-10-28")).toBe(true);
  });
});
