/**
 * OpenCode parser tests.
 *
 * The fixture DB mirrors OpenCode's real drizzle schema (verified against a
 * live install): `message.data` is a JSON blob, sessions carry `directory`.
 * The parser previously queried a flat `messages` table that does not exist
 * on this schema, so every DB-era message was silently dropped.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KiloCliParser } from "./kilo-cli.js";
import { OpenCodeParser } from "./opencode.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencode-parser-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;

function seedDb(
  dbPath: string,
  messages: Array<{ id: string; session: string; data: object | string }>
) {
  const sql = [
    "CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL);",
    "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL);",
    "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);",
    "INSERT INTO project VALUES ('p1', '/Users/me/code/alpha');",
    "INSERT INTO session VALUES ('s1', 'p1', '/Users/me/code/alpha');",
    ...messages.map(
      (m) =>
        `INSERT INTO message VALUES (${sq(m.id)}, ${sq(m.session)}, 1790000000000, 1790000000000, ${sq(typeof m.data === "string" ? m.data : JSON.stringify(m.data))});`
    ),
  ].join("\n");
  execFileSync("sqlite3", [dbPath], { input: sql });
}

const assistant = (id: string, extra: object = {}) => ({
  id,
  role: "assistant",
  modelID: "muse-spark-1.3-contributor-free",
  providerID: "opencode",
  cost: 0,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 10 } },
  time: { created: 1790000001000 },
  ...extra,
});

describe("OpenCodeParser", () => {
  it("reads assistant messages from the current message.data schema", async () => {
    const dir = join(home, ".local/share/opencode");
    mkdirSync(dir, { recursive: true });
    seedDb(join(dir, "opencode.db"), [
      { id: "msg_u", session: "s1", data: { id: "msg_u", role: "user", time: { created: 1 } } },
      // The message's own path beats the session directory.
      {
        id: "msg_a",
        session: "s1",
        data: assistant("msg_a", {
          path: { cwd: "/Users/me/code/beta", root: "/Users/me/code/beta" },
        }),
      },
      // No path on the message — project falls back to the session directory.
      { id: "msg_b", session: "s1", data: assistant("msg_b", { cost: 0.25 }) },
      // A non-object row must be skipped, not throw away every other record.
      { id: "msg_null", session: "s1", data: "null" },
    ]);

    const records = await new OpenCodeParser().scan(home);

    expect(records).toHaveLength(2);
    const a = records.find((r) => r.apiCallId === "msg_a");
    expect(a).toMatchObject({
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 10,
      timestamp: 1790000001000,
      cwd: "/Users/me/code/beta",
    });
    const b = records.find((r) => r.apiCallId === "msg_b");
    expect(b?.cwd).toBe("/Users/me/code/alpha");
    // OpenCode's own figure is tool-reported: kept, and never repriced away.
    expect(b?.cost).toBe(0.25);
    expect(b?.usage?.cost).toBe("direct");
  });

  it("merges legacy JSON storage with the DB, deduped on message id", async () => {
    const dir = join(home, ".local/share/opencode");
    const legacy = join(dir, "storage/message/ses_old");
    mkdirSync(legacy, { recursive: true });
    seedDb(join(dir, "opencode.db"), [{ id: "msg_a", session: "s1", data: assistant("msg_a") }]);
    writeFileSync(
      join(legacy, "msg_old.json"),
      JSON.stringify(
        assistant("msg_old", { modelID: "glm-4.7", path: { cwd: "/Users/me/code/beta" } })
      )
    );
    // Same id as a DB row — must not be counted twice.
    writeFileSync(join(legacy, "msg_a.json"), JSON.stringify(assistant("msg_a")));

    const records = await new OpenCodeParser().scan(home);

    expect(records.map((r) => r.apiCallId).sort()).toEqual(["msg_a", "msg_old"]);
    expect(records.find((r) => r.apiCallId === "msg_old")?.model).toBe("glm-4.7");
  });

  it("reports a free-tier $0 as a fact, but leaves a coding-plan $0 to pricing", async () => {
    const dir = join(home, ".local/share/opencode");
    mkdirSync(dir, { recursive: true });
    seedDb(join(dir, "opencode.db"), [
      { id: "msg_free", session: "s1", data: assistant("msg_free") },
      {
        id: "msg_plan",
        session: "s1",
        data: assistant("msg_plan", { modelID: "glm-4.7", providerID: "zai-coding-plan" }),
      },
    ]);

    const records = await new OpenCodeParser().scan(home);

    expect(records.find((r) => r.apiCallId === "msg_free")?.usage?.cost).toBe("direct");
    expect(records.find((r) => r.apiCallId === "msg_plan")?.usage?.cost).not.toBe("direct");
  });
});

describe("KiloCliParser", () => {
  it("reads the shared OpenCode message.data schema", async () => {
    const dir = join(home, ".local/share/kilo");
    mkdirSync(dir, { recursive: true });
    seedDb(join(dir, "kilo.db"), [{ id: "msg_k", session: "s1", data: assistant("msg_k") }]);

    const records = await new KiloCliParser().scan(home);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "kilo-cli",
      apiCallId: "msg_k",
      outputTokens: 20,
    });
  });

  it("still reads the older flat `messages` schema", async () => {
    const dir = join(home, ".local/share/kilo");
    mkdirSync(dir, { recursive: true });
    execFileSync("sqlite3", [join(dir, "kilo.db")], {
      input: [
        "CREATE TABLE sessions (id text, title text, path text, cwd text);",
        "CREATE TABLE messages (id text, role text, model_id text, provider_id text, input_tokens int, output_tokens int, reasoning_tokens int, cache_read int, cache_write int, created_at int, session_id text);",
        "INSERT INTO sessions VALUES ('s1', 't', '/Users/me/code/gamma', NULL);",
        "INSERT INTO messages VALUES ('m1', 'assistant', 'glm-4.7', 'zai', 10, 2, 0, 30, 0, 1790000000000, 's1');",
        "INSERT INTO messages VALUES ('m2', 'user', NULL, NULL, 0, 0, 0, 0, 0, 1790000000000, 's1');",
      ].join("\n"),
    });

    const records = await new KiloCliParser().scan(home);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      apiCallId: "m1",
      model: "glm-4.7",
      inputTokens: 10,
      cacheReadTokens: 30,
    });
    expect(records[0].project).not.toBe("kilo-cli"); // resolved from the session path
  });
});
