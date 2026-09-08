import { describe, expect, test, vi } from "vitest";
import { RefreshCoordinator } from "./refresh-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("refresh coalescing", () => {
  test("a burst during an incremental refresh shares exactly one later full scan", async () => {
    const incremental = deferred<string>();
    const full = deferred<string>();
    const work = vi.fn((scan: boolean) => (scan ? full.promise : incremental.promise));
    const gate = new RefreshCoordinator(work);
    const read = gate.run(false);
    const rescans = Array.from({ length: 10 }, () => gate.run(true));
    expect(new Set(rescans).size).toBe(1);
    expect(gate.busy).toBe(true);
    incremental.resolve("incremental");
    expect(await read).toBe("incremental");
    await Promise.resolve();
    expect(gate.run(true)).toBe(rescans[0]);
    full.resolve("full");
    expect(await Promise.all(rescans)).toEqual(Array(10).fill("full"));
    expect(work.mock.calls).toEqual([[false], [true]]);
    expect(gate.busy).toBe(false);
  });

  test("a running full scan satisfies concurrent forced and ordinary callers", async () => {
    const full = deferred<number>();
    const work = vi.fn(() => full.promise);
    const gate = new RefreshCoordinator(work);
    const first = gate.run(true);
    expect(gate.run(true)).toBe(first);
    expect(gate.run(false)).toBe(first);
    full.resolve(1);
    await first;
    expect(work).toHaveBeenCalledTimes(1);
  });

  test("a failed incremental refresh does not poison the queued full scan", async () => {
    const incremental = deferred<number>();
    const work = vi.fn((full: boolean) => (full ? Promise.resolve(2) : incremental.promise));
    const gate = new RefreshCoordinator(work);
    const read = gate.run(false);
    const failed = expect(read).rejects.toThrow("refresh failed");
    const queued = gate.run(true);
    incremental.reject(new Error("refresh failed"));
    await failed;
    expect(await queued).toBe(2);
    expect(work.mock.calls).toEqual([[false], [true]]);
    expect(gate.busy).toBe(false);
  });

  test("a rejected full scan permits a later explicit retry", async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error("scan failed")).mockResolvedValueOnce(3);
    const gate = new RefreshCoordinator<number>(work);
    await expect(gate.run(true)).rejects.toThrow("scan failed");
    expect(gate.busy).toBe(false);
    expect(await gate.run(true)).toBe(3);
  });
});
