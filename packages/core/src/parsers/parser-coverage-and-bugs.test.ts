import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, saveConfig } from "../config-service.js";
import type { ScanFaultDetail, TokenRecord } from "../types.js";
import { AmpParser } from "./amp.js";
import { AntigravityParser } from "./antigravity.js";
import { readProtoFields } from "./antigravity-conversations.js";
import { AugmentParser } from "./augment.js";
import { ClaudeCodeParser, isSubagentTranscriptPath } from "./claude-code.js";
import { ClineParser } from "./cline.js";
import { CodexParser } from "./codex.js";
import { CursorParser } from "./cursor.js";
import { CustomSourceParser } from "./custom-source.js";
import { GeminiParser } from "./gemini.js";
import { OpenClawParser } from "./openclaw.js";
import { QwenParser } from "./qwen.js";
import { RooCodeParser } from "./roo-code.js";
import { clearRecordCache, openReadonlySqlite } from "./utils.js";

const tempDirs: string[] = [];

function makeHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function warningSink() {
  const warnings: Array<{ message: string; detail?: ScanFaultDetail }> = [];
  return {
    warnings,
    onWarning: (message: string, detail?: ScanFaultDetail) => {
      warnings.push({ message, detail });
    },
  };
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    clearRecordCache(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parser coverage, bug fixes, and fault isolation (#291)", () => {
  it("GeminiParser parses .jsonl and .json, extracts model/project, honors modifiedSinceMs, and isolates corrupt files", async () => {
    const home = makeHome("gemini-p-");
    const tOld = new Date("2026-10-10T10:00:00Z").getTime();
    const tNew = new Date("2026-10-15T12:00:00Z").getTime();

    const jsonFile = join(home, ".gemini", "tmp", "geminiapp", "chats", "old.json");
    mkdirSync(dirname(jsonFile), { recursive: true });
    writeFileSync(
      jsonFile,
      JSON.stringify({
        timestamp: new Date(tOld).toISOString(),
        messages: [
          {
            type: "gemini",
            model: "gemini-2.5-flash",
            tokens: { input: 500, output: 100, cached: 200, thoughts: 20 },
          },
        ],
      })
    );
    utimesSync(jsonFile, new Date(tOld), new Date(tOld));

    const jsonlFile = join(
      home,
      ".gemini",
      "tmp",
      "abcd1234abcd1234abcd1234abcd1234",
      "session.jsonl"
    );
    mkdirSync(dirname(jsonlFile), { recursive: true });
    writeFileSync(
      jsonlFile,
      `${[
        JSON.stringify({
          type: "gemini",
          model: "gemini-2.5-pro",
          cwd: "/Users/dev/repos/alpha-app",
          timestamp: new Date(tNew).toISOString(),
          tokens: { input: 300, output: 60, cached: 100, thoughts: 15 },
        }),
        JSON.stringify({
          model: "gemini-2.5-flash-lite",
          project: "beta-app",
          timestamp: new Date(tNew + 1000).toISOString(),
          usageMetadata: {
            promptTokenCount: 150,
            candidatesTokenCount: 30,
            cachedContentTokenCount: 50,
          },
        }),
      ].join("\n")}\n`
    );
    utimesSync(jsonlFile, new Date(tNew), new Date(tNew));

    // Corrupt JSON file triggers a read failure beside valid files
    const brokenPath = join(home, ".gemini", "tmp", "broken", "chats", "bad.json");
    mkdirSync(dirname(brokenPath), { recursive: true });
    writeFileSync(brokenPath, "{corrupt json");

    const parser = new GeminiParser();
    const fullSink = warningSink();
    const all = await parser.scan(home, { onWarning: fullSink.onWarning });
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.model === "gemini-2.5-flash")).toMatchObject({
      model: "gemini-2.5-flash",
      project: "geminiapp",
      inputTokens: 300,
      cacheReadTokens: 200,
    });
    expect(all.find((r) => r.model === "gemini-2.5-pro")).toMatchObject({
      model: "gemini-2.5-pro",
      project: "alpha-app",
      inputTokens: 200,
    });
    expect(all.find((r) => r.model === "gemini-2.5-flash-lite")).toMatchObject({
      model: "gemini-2.5-flash-lite",
      project: "beta-app",
      inputTokens: 100,
    });
    expect(fullSink.warnings.some((w) => w.detail?.file === brokenPath)).toBe(true);

    const recent = await parser.scan(home, { modifiedSinceMs: tNew - 1000 });
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => r.model).sort()).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-pro"]);
  });

  it("ClaudeCodeParser supports Windows subagent paths, scanStreaming, and cross-day fork dedup past modifiedSinceMs", async () => {
    expect(
      isSubagentTranscriptPath(
        "C:\\Users\\me\\.claude\\projects\\slug\\sess\\subagents\\agent-1.jsonl"
      )
    ).toBe(true);
    expect(isSubagentTranscriptPath("C:\\Users\\me\\.claude\\projects\\slug\\sess.jsonl")).toBe(
      false
    );

    const home = makeHome("claude-fork-");
    const tParent = new Date("2026-10-10T10:00:00Z").getTime();
    const tSub = new Date("2026-10-15T10:00:00Z").getTime();
    const dir = join(home, ".claude", "projects", "-tmp-app");
    const parentFile = join(dir, "sess-1.jsonl");
    const subFile = join(dir, "sess-1", "subagents", "agent-1.jsonl");
    mkdirSync(dirname(subFile), { recursive: true });

    const mkMsg = (id: string, ts: number, out: number) =>
      JSON.stringify({
        type: "assistant",
        requestId: `req_${id}`,
        timestamp: new Date(ts).toISOString(),
        message: {
          id,
          model: "claude-x",
          usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 500 },
          content: [{ type: "text" }],
        },
      });

    writeFileSync(parentFile, `${mkMsg("msg_shared", tParent, 40)}\n`);
    utimesSync(parentFile, new Date(tParent), new Date(tParent));

    // Subagent replays msg_shared from old parent PLUS its own msg_child
    writeFileSync(
      subFile,
      `${[mkMsg("msg_shared", tSub, 40), mkMsg("msg_child", tSub + 1000, 90)].join("\n")}\n`
    );
    utimesSync(subFile, new Date(tSub), new Date(tSub));

    const parser = new ClaudeCodeParser();
    const batches: TokenRecord[][] = [];
    await parser.scanStreaming(home, { modifiedSinceMs: tSub - 1000 }, (batch) => {
      batches.push(batch);
    });
    const streamed = batches.flat();
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.apiCallId).toBe("msg_child");
    expect(streamed[0]?.outputTokens).toBe(90);
    expect(streamed[0]?.isSubagent).toBe(true);
  });

  it("CursorParser invalidates localCache on -wal growth, parses quoted CSV fields, and falls through past stale CSV dates", async () => {
    const home = makeHome("cursor-wal-");
    const dbPath = join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const put = db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const insertTurn = (cid: string, uid: string, bid: string, iso: string, inp: number) => {
      put.run(
        `bubbleId:${cid}:${uid}`,
        JSON.stringify({
          type: 1,
          createdAt: iso,
          requestId: `r-${uid}`,
          modelInfo: { modelName: "gpt-5" },
        })
      );
      put.run(
        `bubbleId:${cid}:${bid}`,
        JSON.stringify({
          type: 2,
          createdAt: iso,
          tokenCount: { inputTokens: inp, outputTokens: 20 },
        })
      );
    };
    insertTurn("c1", "u1", "b1", "2026-06-01T10:00:00Z", 1000);
    db.close();

    // Re-open in WAL mode with autocheckpoint disabled so a new turn stays in state.vscdb-wal
    const walDb = new DatabaseSync(dbPath);
    walDb.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    const walPut = walDb.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");

    const parser = new CursorParser();
    const first = await parser.scan(home);
    expect(first).toHaveLength(1);
    const mainMtime = statSync(dbPath);

    walPut.run(
      "bubbleId:c1:u2",
      JSON.stringify({
        type: 1,
        createdAt: "2026-06-02T10:00:00Z",
        requestId: "r-u2",
        modelInfo: { modelName: "gpt-5" },
      })
    );
    walPut.run(
      "bubbleId:c1:b2",
      JSON.stringify({
        type: 2,
        createdAt: "2026-06-02T10:01:00Z",
        tokenCount: { inputTokens: 2000, outputTokens: 30 },
      })
    );
    // Keep main db mtime identical to verify -wal invalidation triggers re-read
    utimesSync(dbPath, mainMtime.atime, mainMtime.mtime);

    const second = await parser.scan(home);
    walDb.close();
    expect(second.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([1000, 2000]);

    // Seed a stale legacy CSV from May with quoted commas in project name; June DB records must still appear!
    const csvDir = join(home, ".config", "tokscale", "cursor-cache");
    mkdirSync(csvDir, { recursive: true });
    writeFileSync(
      join(csvDir, "legacy.csv"),
      'timestamp,model,project,inputTokens,outputTokens,cost\n2026-05-01T12:00:00Z,gpt-5,"apps, alpha",500,50,0.02\n'
    );
    const merged = await parser.scan(home);
    const modelsAndProj = merged.map((r) => `${r.project}:${r.inputTokens}`).sort();
    expect(modelsAndProj).toEqual(["apps, alpha:500", "cursor:1000", "cursor:2000"]);
  });

  it("Antigravity shared readProtoFields handles 64-bit varints and wire types 1/5, and isolates corrupt stores", async () => {
    // Field 1: wireType 1 (64-bit fixed skipped), Field 2: wireType 5 (32-bit fixed skipped), Field 3: >32-bit varint 5_000_000_000
    const payload = new Uint8Array([
      (1 << 3) | 1,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      (2 << 3) | 5,
      9,
      10,
      11,
      12,
      (3 << 3) | 0,
      ...encodeVarint(5_000_000_000),
    ]);
    const decoded = readProtoFields(payload);
    expect(decoded.find((f) => f.num === 3)?.varint).toBe(5_000_000_000);

    const home = makeHome("ag-warn-");
    const convDir = join(home, ".gemini", "antigravity", "conversations");
    mkdirSync(convDir, { recursive: true });
    const badConv = join(convDir, "corrupt.db");
    writeFileSync(badConv, "not a sqlite db");

    const vscdb = join(
      home,
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    mkdirSync(dirname(vscdb), { recursive: true });
    writeFileSync(vscdb, "not sqlite");

    const sink = warningSink();
    const parser = new AntigravityParser();
    const records = await parser.scan(home, { onWarning: sink.onWarning });
    expect(records).toEqual([]);
    expect(sink.warnings.some((w) => w.detail?.file === badConv)).toBe(true);
    expect(sink.warnings.some((w) => w.detail?.file === vscdb)).toBe(true);

    // modifiedSinceMs in the future skips state.vscdb without warning
    const skippedSink = warningSink();
    const futureMs = statSync(vscdb).mtimeMs + 60_000;
    await parser.scan(home, { modifiedSinceMs: futureMs, onWarning: skippedSink.onWarning });
    expect(skippedSink.warnings.some((w) => w.detail?.file === vscdb)).toBe(false);
  });

  it("CodexParser preserves subagent cwd/project across replayed parent session_meta and attaches { file } warnings", async () => {
    const home = makeHome("codex-subagent-cwd-");
    const sessDir = join(home, ".codex", "sessions", "2026", "10", "15");
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, "rollout-2026-10-15T10-00-00-sub.jsonl");
    writeFileSync(
      file,
      `${[
        JSON.stringify({
          type: "session_meta",
          payload: { id: "sub-id", thread_source: "subagent", cwd: "/work/sub-app" },
        }),
        // Replayed parent session_meta must NOT overwrite subagent cwd/project
        JSON.stringify({
          type: "session_meta",
          payload: { id: "parent-id", cwd: "/work/parent-app" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5-codex" },
        }),
        JSON.stringify({
          type: "token_usage_record",
          timestamp: "2026-10-15T10:01:00Z",
          payload: {
            thread_id: "sub-id",
            response_id: "resp-1",
            usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 },
          },
        }),
      ].join("\n")}\n`
    );

    const records = await new CodexParser().scan(home);
    expect(records).toHaveLength(1);
    expect(records[0]?.project).toBe("sub-app");
    expect(records[0]?.cwd).toBe("/work/sub-app");
    expect(records[0]?.isSubagent).toBe(true);

    // Corrupt rollout telemetry triggers { file }-scoped warning in parseCodexFile
    const broken = join(sessDir, "rollout-broken.jsonl");
    writeFileSync(broken, '{"type":"token_usage_record", broken}\n');
    const sink = warningSink();
    await new CodexParser().scan(home, { onWarning: sink.onWarning });
    expect(sink.warnings.some((w) => w.detail?.file === broken)).toBe(true);
  });

  it("openReadonlySqlite surfaces the real SQLite failure on Node >= 22.5 instead of missing better-sqlite3", async () => {
    const home = makeHome("sqlite-err-");
    const missing = join(home, "nonexistent.db");
    await expect(openReadonlySqlite(missing)).rejects.toThrow(
      /Unable to open SQLite database .*nonexistent\.db/
    );
    await expect(openReadonlySqlite(missing)).rejects.not.toThrow(/better-sqlite3/);
  });

  it("enforces modifiedSinceMs and per-file { file } warnings across active parsers", async () => {
    const home = makeHome("multi-parser-iso-");
    const tOld = new Date("2026-10-10T10:00:00Z").getTime();
    const tNew = new Date("2026-10-15T12:00:00Z").getTime();
    const since = tNew - 1000;

    // 1. QwenParser: modifiedSinceMs skips old file, warns on unreadable path
    const qOld = join(home, ".qwen", "projects", "p1", "chats", "old.jsonl");
    const qNew = join(home, ".qwen", "projects", "p1", "chats", "new.jsonl");
    const qBad = join(home, ".qwen", "projects", "p1", "chats", "bad.jsonl");
    mkdirSync(dirname(qOld), { recursive: true });
    writeFileSync(
      qOld,
      `${JSON.stringify({ model: "qwen", timestamp: new Date(tOld).toISOString(), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\n`
    );
    writeFileSync(
      qNew,
      `${JSON.stringify({ model: "qwen", timestamp: new Date(tNew).toISOString(), usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } })}\n`
    );
    writeFileSync(qBad, "{not valid json}\n");
    utimesSync(qOld, new Date(tOld), new Date(tOld));
    utimesSync(qNew, new Date(tNew), new Date(tNew));
    utimesSync(qBad, new Date(tNew), new Date(tNew));
    const qSink = warningSink();
    const qRes = await new QwenParser().scan(home, {
      modifiedSinceMs: since,
      onWarning: qSink.onWarning,
    });
    expect(qRes).toHaveLength(1);
    expect(qRes[0]?.outputTokens).toBe(10);
    expect(qSink.warnings.some((w) => w.detail?.file === qBad)).toBe(true);

    // 2. RooCodeParser: modifiedSinceMs + per-file warning isolation (no throw on corrupt JSON)
    const rTask1 = join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "tasks",
      "t1",
      "ui_messages.json"
    );
    const rTask2 = join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "rooveterinaryinc.roo-cline",
      "tasks",
      "t2",
      "ui_messages.json"
    );
    mkdirSync(dirname(rTask1), { recursive: true });
    mkdirSync(dirname(rTask2), { recursive: true });
    writeFileSync(rTask1, "{corrupt json");
    writeFileSync(
      rTask2,
      JSON.stringify([
        {
          type: "say",
          say: "api_req_started",
          ts: new Date(tNew).toISOString(),
          text: JSON.stringify({ model: "roo-m", tokensIn: 11, tokensOut: 22 }),
        },
      ])
    );
    utimesSync(rTask1, new Date(tOld), new Date(tOld));
    utimesSync(rTask2, new Date(tNew), new Date(tNew));
    const rSink = warningSink();
    const rFull = await new RooCodeParser().scan(home, { onWarning: rSink.onWarning });
    expect(rFull).toHaveLength(1);
    expect(rSink.warnings.some((w) => w.detail?.file === rTask1)).toBe(true);
    const rRecent = await new RooCodeParser().scan(home, { modifiedSinceMs: since });
    expect(rRecent).toHaveLength(1);

    // 3. ClineParser, AugmentParser, AmpParser: modifiedSinceMs + fault isolation
    const clineBad = join(home, ".cline", "apps", "kanban", "sessions", "bad.jsonl");
    const clineGood = join(home, ".cline", "apps", "kanban", "sessions", "good.jsonl");
    mkdirSync(dirname(clineBad), { recursive: true });
    writeFileSync(
      clineBad,
      `${JSON.stringify({ ts: tOld, stream: "chat_usage", chunk: "{bad" })}\n`
    );
    writeFileSync(
      clineGood,
      `${JSON.stringify({ ts: tNew, stream: "chat_usage", chunk: JSON.stringify({ inputTokens: 30, outputTokens: 40 }) })}\n`
    );
    utimesSync(clineBad, new Date(tOld), new Date(tOld));
    utimesSync(clineGood, new Date(tNew), new Date(tNew));
    const cSink = warningSink();
    expect(
      await new ClineParser().scan(home, { modifiedSinceMs: since, onWarning: cSink.onWarning })
    ).toHaveLength(1);
    await new ClineParser().scan(home, { onWarning: cSink.onWarning });
    expect(cSink.warnings.some((w) => w.detail?.file === clineBad)).toBe(true);

    const augOld = join(home, ".augment", "sessions", "old.json");
    const augBad = join(home, ".augment", "sessions", "bad.json");
    mkdirSync(dirname(augOld), { recursive: true });
    writeFileSync(
      augOld,
      JSON.stringify({
        created: tOld,
        chatHistory: [
          {
            exchange: {
              request_id: "r1",
              response_nodes: [{ token_usage: { input_tokens: 5, output_tokens: 6 } }],
            },
          },
        ],
      })
    );
    writeFileSync(augBad, "{not valid json");
    utimesSync(augOld, new Date(tOld), new Date(tOld));
    utimesSync(augBad, new Date(tNew), new Date(tNew));
    const aSink = warningSink();
    expect(
      await new AugmentParser().scan(home, { modifiedSinceMs: since, onWarning: aSink.onWarning })
    ).toEqual([]);
    expect(aSink.warnings.some((w) => w.detail?.file === augBad)).toBe(true);

    const ampDir = join(home, ".local", "share", "amp", "threads");
    mkdirSync(ampDir, { recursive: true });
    const ampOld = join(ampDir, "old.jsonl");
    writeFileSync(
      ampOld,
      `${JSON.stringify({ role: "assistant", model: "a", timestamp: tOld, usage: { input: 1, output: 2 } })}\n`
    );
    utimesSync(ampOld, new Date(tOld), new Date(tOld));
    expect(await new AmpParser().scan(home, { modifiedSinceMs: since })).toEqual([]);

    // 4. CustomSourceParser & OpenClawParser: modifiedSinceMs
    const customDir = join(home, "custom-logs");
    mkdirSync(customDir, { recursive: true });
    const custOld = join(customDir, "old.jsonl");
    const custNew = join(customDir, "new.jsonl");
    writeFileSync(
      custOld,
      `${JSON.stringify({ ts: tOld, model: "m1", input_tokens: 1, output_tokens: 1 })}\n`
    );
    writeFileSync(
      custNew,
      `${JSON.stringify({ ts: tNew, model: "m2", input_tokens: 2, output_tokens: 3 })}\n`
    );
    utimesSync(custOld, new Date(tOld), new Date(tOld));
    utimesSync(custNew, new Date(tNew), new Date(tNew));
    saveConfig(
      {
        ...DEFAULT_CONFIG,
        customSources: [{ path: customDir, provider: "ribhu", format: "tokmeter-usage-jsonl" }],
        modifiedBy: "user",
      },
      home
    );
    const custRecent = await new CustomSourceParser().scan(home, { modifiedSinceMs: since });
    expect(custRecent).toHaveLength(1);
    expect(custRecent[0]?.model).toBe("m2");

    const clawDir = join(home, ".openclaw", "agents", "a1", "sessions");
    mkdirSync(clawDir, { recursive: true });
    const clawSessOld = join(clawDir, "old.jsonl");
    const clawSessNew = join(clawDir, "new.jsonl");
    writeFileSync(
      clawSessOld,
      `${JSON.stringify({ type: "message", message: { role: "assistant", timestamp: tOld, usage: { input: 1, output: 1 } } })}\n`
    );
    writeFileSync(
      clawSessNew,
      `${JSON.stringify({ type: "message", message: { role: "assistant", timestamp: tNew, usage: { input: 8, output: 9 } } })}\n`
    );
    utimesSync(clawSessOld, new Date(tOld), new Date(tOld));
    utimesSync(clawSessNew, new Date(tNew), new Date(tNew));
    writeFileSync(
      join(clawDir, "sessions.json"),
      JSON.stringify({ s1: { sessionFile: "old.jsonl" }, s2: { sessionFile: "new.jsonl" } })
    );
    const clawRecent = await new OpenClawParser().scan(home, { modifiedSinceMs: since });
    expect(clawRecent).toHaveLength(1);
    expect(clawRecent[0]?.outputTokens).toBe(9);
  });
});
