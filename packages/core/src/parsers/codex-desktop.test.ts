/**
 * Codex Desktop parser regression tests.
 *
 * Codex Desktop (the ChatGPT app) writes to the same ~/.codex/sessions store
 * as the codex CLI but never emits a token_count event, so it was previously
 * invisible in tokmeter entirely. These tests pin the discriminator
 * (session_meta.originator === "Codex Desktop") and confirm real CLI
 * sessions are never picked up here — only CodexParser should ever produce
 * records for those, so a session can't be double-counted under two
 * provider ids.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexDesktopParser } from "./codex-desktop.js";
import { CodexParser } from "./codex.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codex-desktop-parser-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function writeRollout(
  fileName: string,
  originator: string,
  opts?: { cwd?: string; model?: string; withTokenCount?: boolean }
): string {
  const sessionsDir = join(tmpDir, ".codex", "sessions", "2026", "07", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);

  const lines: string[] = [
    JSON.stringify({
      timestamp: "2026-07-10T13:18:49.000Z",
      type: "session_meta",
      payload: {
        id: "test-session",
        originator,
        cwd: opts?.cwd ?? "/Users/test/AUriva",
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-10T13:18:50.000Z",
      type: "turn_context",
      payload: { model: opts?.model ?? "gpt-5.6-sol" },
    }),
  ];

  if (opts?.withTokenCount) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-07-10T13:19:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 },
          },
        },
      })
    );
  }

  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("CodexDesktopParser", () => {
  it("surfaces an activity-only record for a Codex Desktop session", async () => {
    writeRollout("rollout-desktop.jsonl", "Codex Desktop");

    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records.length).toBe(1);

    const r = records[0];
    expect(r.provider).toBe("codex-desktop");
    expect(r.model).toBe("gpt-5.6-sol");
    expect(r.project).toBe("AUriva");
    expect(r.timestamp).toBe(new Date("2026-07-10T13:18:49.000Z").getTime());
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.usage).toMatchObject({
      inputTokens: "not_exposed",
      outputTokens: "not_exposed",
      cost: "not_exposed",
    });
  });

  it("finds the model past a 64 KB discriminator read when early events are large", async () => {
    // Real Desktop rollouts pack large response_item events (system prompt,
    // early tool output) between session_meta and the first turn_context —
    // one observed real file put turn_context past the 100 KB mark, which a
    // naive fixed 64 KB read missed entirely (model fell back to "unknown").
    const sessionsDir = join(tmpDir, ".codex", "sessions", "2026", "07", "10");
    mkdirSync(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, "rollout-padded.jsonl");

    const padding = "x".repeat(80_000);
    const lines = [
      JSON.stringify({
        timestamp: "2026-07-10T13:18:49.000Z",
        type: "session_meta",
        payload: { id: "padded-session", originator: "Codex Desktop", cwd: "/Users/test/AUriva" },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T13:18:50.000Z",
        type: "response_item",
        payload: { text: padding },
      }),
      JSON.stringify({
        timestamp: "2026-07-10T13:18:51.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records.length).toBe(1);
    expect(records[0].model).toBe("gpt-5.6-sol");
  });

  it("skips codex_cli_rs / codex-tui originators entirely", async () => {
    writeRollout("rollout-cli.jsonl", "codex_cli_rs");
    writeRollout("rollout-tui.jsonl", "codex-tui");

    const records = await new CodexDesktopParser().scan(tmpDir);
    expect(records.length).toBe(0);
  });

  it("never double-counts a session CodexParser already tracks via token_count", async () => {
    // A real CLI session (has token_count events) must be picked up ONLY by
    // CodexParser, never by CodexDesktopParser, even if it sat in the same dir.
    writeRollout("rollout-cli.jsonl", "codex_cli_rs", { withTokenCount: true });

    const desktopRecords = await new CodexDesktopParser().scan(tmpDir);
    const cliRecords = await new CodexParser().scan(tmpDir);

    expect(desktopRecords.length).toBe(0);
    expect(cliRecords.length).toBe(1);
    expect(cliRecords[0].provider).toBe("codex");
  });

  it("does not pick up a Desktop session under CodexParser", async () => {
    // Confirms the reverse direction: a Desktop file (no token_count) yields
    // zero CodexParser records, so CodexDesktopParser's activity record is
    // the only signal for it anywhere in the system.
    writeRollout("rollout-desktop.jsonl", "Codex Desktop");

    const cliRecords = await new CodexParser().scan(tmpDir);
    expect(cliRecords.length).toBe(0);
  });
});
