import { afterEach, describe, expect, it, vi } from "vitest";
import { isInteractiveTerminal, requireInteractiveTerminal } from "./interactive-guard.js";

describe("interactive guard for destructive commands", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("needs a TTY on both stdin and stdout", () => {
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractiveTerminal({}, { isTTY: true })).toBe(false);
    expect(isInteractiveTerminal({ isTTY: true }, {})).toBe(false);
  });

  it("refuses a piped run with a failing exit code and a --dry-run hint", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(requireInteractiveTerminal("cleanup", {}, { isTTY: true })).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.join("\n")).toMatch(/interactive terminal[\s\S]*--dry-run/);
  });

  it("lets a terminal run through untouched", () => {
    expect(requireInteractiveTerminal("restore", { isTTY: true }, { isTTY: true })).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});
