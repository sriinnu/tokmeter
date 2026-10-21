import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KimiParser, kimiCodeModel } from "./kimi.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kimi-parser-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const at = (s: string) => new Date(s).getTime();

/** A Kimi Code session: state.json plus one wire.jsonl per agent. */
function codeSession(agents: Record<string, object[]>, cwd = "/work/grimoire"): string {
  const session = join(home, ".kimi-code", "sessions", "wd_grimoire_1", "session_abc");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "state.json"), JSON.stringify({ id: "session_abc", cwd }));
  for (const [agent, lines] of Object.entries(agents)) {
    const dir = join(session, "agents", agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wire.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }
  return session;
}

function usage(agentId: string, model: string, time: number, inputOther: number, output: number) {
  return {
    type: "usage.record",
    agentId,
    model,
    usage: { inputOther, output, inputCacheRead: 1000, inputCacheCreation: 0 },
    usageScope: "turn",
    time,
  };
}

describe("kimiCodeModel", () => {
  it("names generations the way kosha lists them, and leaves plan aliases alone", () => {
    expect(kimiCodeModel("kimi-code/k3")).toBe("kimi-k3");
    expect(kimiCodeModel("kimi-code/k3-256k")).toBe("kimi-k3-256k");
    expect(kimiCodeModel("kimi-code/kimi-for-coding")).toBe("kimi-for-coding");
    expect(kimiCodeModel(undefined)).toBe("kimi");
  });
});

describe("KimiParser — Kimi Code sessions", () => {
  it("counts one record per usage.record, from every agent, under the session's project", async () => {
    codeSession({
      main: [
        {
          type: "llm.request",
          agentId: "main",
          model: "kimi-for-coding",
          time: at("2026-10-20T10:00:00"),
        },
        usage("main", "kimi-code/k3", at("2026-10-20T10:00:05"), 300, 90),
        {
          type: "token_counting.measured",
          agentId: "main",
          tokens: 1390,
          time: at("2026-10-20T10:00:06"),
        },
        usage("main", "kimi-code/kimi-for-coding", at("2026-10-20T11:00:00"), 50, 10),
      ],
      "agent-2": [usage("agent-2", "kimi-code/k3", at("2026-10-20T10:30:00"), 200, 40)],
    });

    const records = await new KimiParser().scan(home);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.model).sort()).toEqual(["kimi-for-coding", "kimi-k3", "kimi-k3"]);
    expect(new Set(records.map((r) => r.project))).toEqual(new Set(["grimoire"]));
    expect(records.reduce((s, r) => s + r.inputTokens, 0)).toBe(550);
    expect(records.reduce((s, r) => s + r.outputTokens, 0)).toBe(140);
    expect(records.reduce((s, r) => s + r.cacheReadTokens, 0)).toBe(3000);
    expect(records.filter((r) => r.isSubagent).map((r) => r.inputTokens)).toEqual([200]);
    expect(new Set(records.map((r) => r.apiCallId)).size).toBe(3);
  });

  it("skips rollup scopes so a turn isn't counted twice", async () => {
    codeSession({
      main: [
        usage("main", "kimi-code/k3", at("2026-10-20T10:00:05"), 300, 90),
        {
          ...usage("main", "kimi-code/k3", at("2026-10-20T10:00:09"), 300, 90),
          usageScope: "session",
        },
      ],
    });
    expect(await new KimiParser().scan(home)).toHaveLength(1);
  });

  it("skips files untouched since the watermark", async () => {
    const session = codeSession({
      main: [usage("main", "kimi-code/k3", at("2026-10-18T10:00:00"), 1, 1)],
    });
    const old = new Date(at("2026-10-18T10:00:00"));
    utimesSync(join(session, "agents", "main", "wire.jsonl"), old, old);
    const parser = new KimiParser();
    expect(await parser.scan(home, { modifiedSinceMs: at("2026-10-20T00:00:00") })).toHaveLength(0);
    expect(await parser.scan(home)).toHaveLength(1);
  });

  it("still reads the Kimi CLI layout", async () => {
    const dir = join(home, ".kimi", "sessions", "g1", "s1");
    mkdirSync(dir, { recursive: true });
    const line = {
      timestamp: at("2026-10-20T10:00:00") / 1000,
      message: { type: "StatusUpdate", payload: { token_usage: { input_other: 7, output: 3 } } },
    };
    writeFileSync(join(dir, "wire.jsonl"), `${JSON.stringify(line)}\n`);
    const records = await new KimiParser().scan(home);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "kimi", inputTokens: 7, outputTokens: 3 });
  });
});
