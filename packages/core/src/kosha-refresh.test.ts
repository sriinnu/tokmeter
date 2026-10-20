// The daemon calls maybeBackgroundRefresh on every 12s tick. It must refresh a
// stale registry, leave a fresh one alone, and never retry a failed refresh
// on every tick.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const refresh = vi.fn<() => Promise<void>>();
vi.mock("@sriinnu/kosha-discovery", () => ({
  createKosha: async () => ({ refresh }),
}));

const HOUR = 3_600_000;
let home: string;
let prevHome: string | undefined;

async function load() {
  vi.resetModules(); // fresh module state (in-flight + last-attempt) per test
  return import("./pricing.js");
}
function registryAged(ms: number): number {
  const file = join(home, ".kosha", "registry.json");
  mkdirSync(join(home, ".kosha"), { recursive: true });
  writeFileSync(file, "{}");
  const when = new Date(Date.now() - ms);
  utimesSync(file, when, when);
  return Date.now();
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("maybeBackgroundRefresh", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-kosha-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    refresh.mockReset();
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a fresh registry is left alone", async () => {
    const { maybeBackgroundRefresh } = await load();
    const now = registryAged(2 * HOUR);
    maybeBackgroundRefresh({ now });
    expect(refresh).not.toHaveBeenCalled();
  });

  test("a registry older than a day is refreshed once, however many ticks ask", async () => {
    const { maybeBackgroundRefresh } = await load();
    refresh.mockResolvedValue();
    const now = registryAged(25 * HOUR);
    for (let i = 0; i < 5; i++) maybeBackgroundRefresh({ now: now + i * 12_000 });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a failed refresh is retried after an hour, not on the next tick", async () => {
    const { maybeBackgroundRefresh } = await load();
    refresh.mockRejectedValue(new Error("offline"));
    const now = registryAged(25 * HOUR);
    maybeBackgroundRefresh({ now });
    await settle();
    await settle();
    maybeBackgroundRefresh({ now: now + 12_000 });
    maybeBackgroundRefresh({ now: now + 59 * 60_000 });
    expect(refresh).toHaveBeenCalledTimes(1);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    maybeBackgroundRefresh({ now: now + HOUR + 1 });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("no registry at all is treated as stale", async () => {
    const { maybeBackgroundRefresh } = await load();
    refresh.mockResolvedValue();
    maybeBackgroundRefresh({ now: Date.now() });
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
