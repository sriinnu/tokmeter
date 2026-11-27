import { describe, expect, it, vi } from "vitest";
import { HELP_TEXT, olderThanToIsoCutoff, parseArgs } from "./args.js";

describe("olderThanToIsoCutoff", () => {
  it("parses days, weeks, and months into past ISO timestamps", () => {
    const now = Date.now();
    const d10 = Date.parse(olderThanToIsoCutoff("10d") ?? "");
    const w2 = Date.parse(olderThanToIsoCutoff("2w") ?? "");
    const m1 = Date.parse(olderThanToIsoCutoff("1m") ?? "");

    expect(now - d10).toBeGreaterThan(9.5 * 86_400_000);
    expect(now - d10).toBeLessThan(10.5 * 86_400_000);
    expect(now - w2).toBeGreaterThan(13.5 * 86_400_000);
    expect(now - m1).toBeGreaterThan(29.5 * 86_400_000);
  });

  it("returns undefined for invalid or zero durations", () => {
    expect(olderThanToIsoCutoff("0d")).toBeUndefined();
    expect(olderThanToIsoCutoff("abc")).toBeUndefined();
    expect(olderThanToIsoCutoff("-5d")).toBeUndefined();
  });
});

describe("parseArgs", () => {
  it("parses default options and common filters", () => {
    const args = parseArgs([
      "node",
      "tokmeter",
      "--today",
      "--json",
      "--light",
      "--project",
      "app",
    ]);
    expect(args.command).toBeUndefined();
    expect(args.today).toBe(true);
    expect(args.json).toBe(true);
    expect(args.light).toBe(true);
    expect(args.project).toBe("app");
  });

  it("maps multiple provider flags cleanly", () => {
    const args = parseArgs([
      "node",
      "tokmeter",
      "models",
      "--claude",
      "--codex",
      "--gemini",
      "--antigravity",
      "--kilo",
      "--kilocode",
    ]);
    expect(args.command).toBe("models");
    expect(args.providers).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "antigravity",
      "kilo-cli",
      "kilo",
    ]);
  });

  it("maps digest aliases and subcommands owning remaining argv", () => {
    const weekly = parseArgs(["node", "tokmeter", "weekly", "--period", "month"]);
    expect(weekly.command).toBe("digest");
    expect(weekly.digestPeriod).toBe("month");

    const alias = parseArgs(["node", "tokmeter", "alias", "set", "foo", "Bar", "--json"]);
    expect(alias.command).toBe("alias");
    expect(alias.aliasSub).toBe("set");
    expect(alias.aliasRest).toEqual(["foo", "Bar", "--json"]);
  });

  it("prints help/version and exits cleanly, and rejects unknown options", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    try {
      expect(() => parseArgs(["node", "tokmeter", "--help"])).toThrow("EXIT:0");
      expect(logSpy).toHaveBeenCalledWith(HELP_TEXT);

      expect(() => parseArgs(["node", "tokmeter", "--version"])).toThrow("EXIT:0");

      expect(() => parseArgs(["node", "tokmeter", "--not-a-flag"])).toThrow("EXIT:2");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option --not-a-flag"));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("parses receipt, git, and bar subcommands and their flags", () => {
    const receipt = parseArgs([
      "node",
      "tokmeter",
      "receipt",
      "--style",
      "broadsheet",
      "--svg",
      "out.svg",
      "--include-projects",
      "--week",
    ]);
    expect(receipt.command).toBe("receipt");
    expect(receipt.receiptStyle).toBe("broadsheet");
    expect(receipt.svgPath).toBe("out.svg");
    expect(receipt.includeProjects).toBe(true);
    expect(receipt.week).toBe(true);

    const gitArgs = parseArgs([
      "node",
      "tokmeter",
      "git",
      "--base",
      "main",
      "--lead-minutes",
      "45",
      "--markdown",
    ]);
    expect(gitArgs.command).toBe("git");
    expect(gitArgs.gitBase).toBe("main");
    expect(gitArgs.gitLeadMinutes).toBe(45);
    expect(gitArgs.markdown).toBe(true);

    const barArgs = parseArgs(["node", "tokmeter", "bar", "--format", "waybar"]);
    expect(barArgs.command).toBe("bar");
    expect(barArgs.barFormat).toBe("waybar");
  });
});
