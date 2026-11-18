// Grok Bot's plan meter. The cache shape is the real one on disk in November
// 2026 (schemaVersion 3); account ids here are made up.

import * as fs from "node:fs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});

const {
  decodeBase32Name,
  getQuota,
  grokBotPersistenceDir,
  grokBotQuotaFromCache,
  readGrokBotQuota,
  readQuotaStore,
  resetGrokBotQuotaCache,
} = await import("./quota.js");

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function base32(text: string): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

const ACCOUNT = "x%7Cuser_TESTACCOUNT1";
const weeklyName = (account = ACCOUNT) =>
  `${base32(`sand.client.slice.account.${account}.weekly-usage.cache`)}.blob`;

// The real reading: taken Tue 17 Nov 14:31, resets Wed 18 Nov 21:28 (local).
const READ_AT = 1794922283307;
const RESET_MS = 1795033720768;

function cache(
  over: { schemaVersion?: number; kind?: string; percentUsed?: number; readAtMs?: number } = {}
): string {
  return JSON.stringify({
    schemaVersion: over.schemaVersion ?? 3,
    value: {
      kind: over.kind ?? "present",
      selectedTeamId: null,
      reading: {
        usage: {
          percentUsed: over.percentUsed ?? 99.54,
          nextResetMs: RESET_MS,
          isSandTrial: false,
          hasNonZeroIncludedLimit: true,
          isTeamSeat: false,
          onDemand: null,
          prepaidBalanceCents: 0,
          wouldRefuseSend: false,
          grokPlanLabel: "Grok Bot Plan",
          unifiedPlanName: "Premium",
          readForTeamId: null,
        },
        readAtMs: over.readAtMs ?? READ_AT,
      },
      expiresAtMs: READ_AT + 3_600_000,
    },
  });
}

let home: string;
let dir: string;
const reads = () => vi.mocked(fs.readFileSync).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-grok-"));
  dir = grokBotPersistenceDir(home);
  mkdirSync(dir, { recursive: true });
  resetGrokBotQuotaCache();
  vi.mocked(fs.readFileSync).mockClear();
});

afterEach(() => {
  for (const f of ["sand-secrets.json", "box-secrets-1.json"]) {
    try {
      chmodSync(join(dir, f), 0o600);
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
});

describe("decodeBase32Name", () => {
  test("decodes the app's lowercase unpadded names", () => {
    const key = `sand.client.slice.account.${ACCOUNT}.weekly-usage.cache`;
    expect(decodeBase32Name(base32(key))).toBe(key);
  });
  test("rejects names that aren't base32", () => {
    expect(decodeBase32Name("sand-secrets.json")).toBeNull();
    expect(decodeBase32Name("abc1")).toBeNull();
  });
});

describe("readGrokBotQuota", () => {
  test("reads the weekly cache and opens nothing else in the folder", async () => {
    writeFileSync(join(dir, weeklyName()), cache());
    // Secrets the reader must never open: unreadable, and spied on too.
    for (const f of ["sand-secrets.json", "box-secrets-1.json", "Cookies"]) {
      writeFileSync(join(dir, f), "SECRET");
      if (f !== "Cookies") chmodSync(join(dir, f), 0o000);
    }
    // Another slice of the same account, e.g. a conversation: not opened either.
    const other = `${base32(`sand.client.slice.account.${ACCOUNT}.conversation.cache`)}.blob`;
    writeFileSync(join(dir, other), "{}");

    const notices: string[] = [];
    const got = await readGrokBotQuota(home, (m) => notices.push(m));
    expect(got).toEqual([
      {
        agent: "grok-bot",
        windowMinutes: 10080,
        usedPct: 99.54,
        resetsAt: Math.round(RESET_MS / 1000),
        at: READ_AT,
        plan: "Grok Bot Plan",
      },
    ]);
    expect(notices).toEqual([]);
    expect(reads()).toEqual([join(dir, weeklyName())]);
  });

  test("re-reads the file only when it changes", async () => {
    const file = join(dir, weeklyName());
    writeFileSync(file, cache());
    utimesSync(file, new Date(READ_AT / 1000), new Date(READ_AT / 1000));
    await readGrokBotQuota(home);
    await readGrokBotQuota(home);
    expect(reads()).toHaveLength(1);
    writeFileSync(file, cache({ percentUsed: 12 }));
    utimesSync(file, new Date(READ_AT / 1000 + 60), new Date(READ_AT / 1000 + 60));
    expect((await readGrokBotQuota(home))[0]?.usedPct).toBe(12);
    expect(reads()).toHaveLength(2);
  });

  test("with several accounts the newest reading wins", async () => {
    writeFileSync(join(dir, weeklyName()), cache({ percentUsed: 99.54 }));
    writeFileSync(
      join(dir, weeklyName("x%7Cuser_TESTACCOUNT2")),
      cache({ percentUsed: 7, readAtMs: READ_AT + 60_000 })
    );
    const got = await readGrokBotQuota(home);
    expect(got).toHaveLength(1);
    expect(got[0]?.usedPct).toBe(7);
  });

  test("an unknown schema or no reading gives a notice, not a crash", async () => {
    const notices: string[] = [];
    writeFileSync(join(dir, weeklyName()), cache({ schemaVersion: 4 }));
    writeFileSync(join(dir, weeklyName("x%7Cuser_TESTACCOUNT2")), cache({ kind: "absent" }));
    expect(await readGrokBotQuota(home, (m) => notices.push(m))).toEqual([]);
    expect(notices.sort()).toEqual([
      "Grok Bot has no weekly usage reading yet",
      "Grok Bot's weekly usage cache has schema 4, not 3",
    ]);
    expect(notices.join(" ")).not.toContain("TESTACCOUNT");
  });

  test("bad JSON and missing fields give notices", () => {
    expect(grokBotQuotaFromCache("{not json")).toHaveProperty("notice");
    expect(
      grokBotQuotaFromCache(JSON.stringify({ schemaVersion: 3, value: { kind: "present" } }))
    ).toHaveProperty("notice");
  });

  test("no Grok Bot on the machine reads as nothing", async () => {
    rmSync(join(home, "Library"), { recursive: true });
    expect(await readGrokBotQuota(home)).toEqual([]);
  });
});

describe("getQuota with Grok Bot", () => {
  test("a reading whose week already reset shows as expired, not 99% now", async () => {
    writeFileSync(join(dir, weeklyName()), cache());
    const afterReset = RESET_MS + 3_600_000;
    const ws = await getQuota(home, afterReset);
    const grok = ws.find((w) => w.agent === "grok-bot");
    expect(grok).toMatchObject({ window: "7d", verdict: "expired", plan: "Grok Bot Plan" });

    const stored = readQuotaStore(home, "grok-bot");
    expect(stored).toHaveLength(1);
    const text = readFileSync(join(home, ".cache", "tokmeter", "quota", "grok-bot.jsonl"), "utf8");
    expect(text).not.toContain("TESTACCOUNT");
    expect(text).not.toContain("user_");
  });

  test("before the reset the pace verdict applies like any window", async () => {
    writeFileSync(join(dir, weeklyName()), cache());
    const ws = await getQuota(home, READ_AT + 60_000);
    // 99.54% after 6.7 of 7 days: at that average pace 100% comes before the reset.
    expect(ws.find((w) => w.agent === "grok-bot")).toMatchObject({
      usedPct: 99.54,
      verdict: "hits-limit",
    });
  });
});
