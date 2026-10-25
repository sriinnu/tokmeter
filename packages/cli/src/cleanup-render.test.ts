import { afterEach, describe, expect, test, vi } from "vitest";
import { renderResult, shortPath } from "./cleanup-render.js";

describe("cleanup terminal rendering", () => {
  afterEach(() => vi.restoreAllMocks());

  test("sanitizes control sequences without changing filesystem identity upstream", () => {
    expect(
      shortPath("/tmp/\u001b]8;;https://example.test\u0007session\u001b]8;;\u0007.jsonl")
    ).toBe("tmp/session.jsonl");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    renderResult({
      deletedCount: 0,
      failedCount: 1,
      bytesFreed: 0,
      backupPath: "/tmp/\u001b[31mbackup",
      errors: [{ target: "/tmp/\u001b]0;owned\u0007file", error: "bad\u202emessage" }],
    });
    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
    expect(output).toContain("/tmp/file: bad message");
  });
});
