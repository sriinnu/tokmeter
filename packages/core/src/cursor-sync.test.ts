import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CursorSyncError,
  cursorSyncWindows,
  cursorTokenStatus,
  scrubSecrets,
  syncCursorUsage,
} from "./cursor-sync.js";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const HEADER =
  "Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost";
const ROW =
  '"2026-11-12T10:00:00.000Z","","","On-Demand","gpt-5","No","0","10","20","5","35","0.11"';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A fake, unsigned JWT. Never a real credential. */
function fakeJwt(expSec: number, userId = "user_FAKE01ABCDEF"): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      sub: `auth0|${userId}`,
      exp: expSec,
      aud: "fake",
      iss: "fake",
      scope: "x",
      type: "session",
    }),
    "ZmFrZXNpZ25hdHVyZWZha2VzaWduYXR1cmU",
  ].join(".");
}

function makeHome(token?: string | Uint8Array): { home: string; db: string } {
  const home = mkdtempSync(join(tmpdir(), "tokmeter-cursor-sync-"));
  const dir = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "state.vscdb");
  const handle = new DatabaseSync(db);
  handle.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  if (token !== undefined) {
    handle
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run("cursorAuth/accessToken", token);
  }
  handle.close();
  return { home, db };
}

function csvResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/csv" } });
}

afterEach(() => vi.restoreAllMocks());

describe("cursorSyncWindows", () => {
  it("splits [since, now) into whole UTC calendar months", () => {
    const since = Date.UTC(2026, 8, 17, 15, 0);
    const w = cursorSyncWindows(since, NOW);
    expect(w.map((x) => x.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(w[0].fromMs).toBe(Date.UTC(2026, 8, 1));
    expect(w[1].fromMs).toBe(Date.UTC(2026, 9, 1));
    expect(w.at(-1)?.toMs).toBe(NOW);
    for (let i = 1; i < w.length; i++) expect(w[i].fromMs).toBe(w[i - 1].toMs);
  });

  it("crosses a year boundary", () => {
    const w = cursorSyncWindows(Date.UTC(2025, 11, 30), Date.UTC(2026, 0, 2));
    expect(w.map((x) => x.month)).toEqual(["2025-12", "2026-01"]);
  });
});

describe("cursorTokenStatus (dry run)", () => {
  it("reports presence and hours to expiry, never the token", async () => {
    const jwt = fakeJwt(NOW / 1000 + 5 * 3600);
    const { home } = makeHome(jwt);
    const status = await cursorTokenStatus({ homeDir: home, now: () => NOW });
    expect(status).toMatchObject({ present: true, expired: false, expiresInHours: 5 });
    expect(JSON.stringify(status)).not.toContain(jwt);
  });

  it("reads a UTF-16LE blob value", async () => {
    const jwt = fakeJwt(NOW / 1000 + 3600);
    const { home } = makeHome(new Uint8Array(Buffer.from(jwt, "utf16le")));
    expect(await cursorTokenStatus({ homeDir: home, now: () => NOW })).toMatchObject({
      present: true,
      expired: false,
    });
  });

  it("reports no token and no database", async () => {
    expect(await cursorTokenStatus({ homeDir: makeHome().home })).toMatchObject({ present: false });
    const empty = mkdtempSync(join(tmpdir(), "tokmeter-cursor-none-"));
    expect(await cursorTokenStatus({ homeDir: empty })).toMatchObject({ present: false });
  });

  it("names an encrypted token as unusable", async () => {
    const { home } = makeHome("cursor-safe-storage:v1:abcdef");
    const status = await cursorTokenStatus({ homeDir: home });
    expect(status.present).toBe(true);
    expect(status.problem).toMatch(/encrypted/);
  });
});

describe("syncCursorUsage", () => {
  it("fetches each window with the session cookie and writes it atomically, owner-only", async () => {
    const jwt = fakeJwt(NOW / 1000 + 3600);
    const { home } = makeHome(jwt);
    const fetchMock = vi.fn(async () => csvResponse(`${HEADER}\n${ROW}\n`));
    const result = await syncCursorUsage({
      homeDir: home,
      now: () => NOW,
      sinceMs: NOW - 40 * 86_400_000,
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // Oct 4 → Nov 13: October and November
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://cursor.com/api/dashboard/export-usage-events-csv");
    expect(u.searchParams.get("strategy")).toBe("tokens");
    expect(Number(u.searchParams.get("startDate"))).toBe(Date.UTC(2026, 9, 1));
    expect(Number(u.searchParams.get("endDate"))).toBe(Date.UTC(2026, 10, 1));
    // A redirect would carry the session cookie somewhere else: never follow one.
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].redirect).toBe("error");
    }
    const headers = init.headers as Record<string, string>;
    expect(headers.Cookie).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent(`user_FAKE01ABCDEF::${jwt}`)}`
    );
    expect(headers.Origin).toBe("https://cursor.com");
    expect(headers["User-Agent"]).toMatch(/Mozilla/);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(result.rows).toBe(2);
    expect(result.windows).toHaveLength(2);
    const dir = join(home, ".cache", "tokmeter", "cursor-usage");
    expect(result.cacheDir).toBe(dir);
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(["usage-2026-10.csv", "usage-2026-11.csv"]);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    const file = result.windows[0].file;
    expect(readFileSync(file, "utf-8")).toContain(ROW);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(file, "utf-8")).not.toContain(jwt);
  });

  it("writes the same file names on later runs, so a month is one file", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 + 3 * 86_400));
    const fetchCsv = (async () => csvResponse(`${HEADER}\n${ROW}\n`)) as typeof fetch;
    await syncCursorUsage({ homeDir: home, now: () => NOW, fetch: fetchCsv });
    const dir = join(home, ".cache", "tokmeter", "cursor-usage");
    const first = readdirSync(dir).sort();
    // A day later, with the default 90-day lookback moving too.
    const later = NOW + 86_400_000;
    await syncCursorUsage({ homeDir: home, now: () => later, fetch: fetchCsv });
    expect(readdirSync(dir).sort()).toEqual(first);
    expect(first).toEqual([
      "usage-2026-08.csv",
      "usage-2026-09.csv",
      "usage-2026-10.csv",
      "usage-2026-11.csv",
    ]);
  });

  it("cuts off a body over the size cap while streaming, and writes nothing", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 + 3600));
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(100).fill(65));
      },
    });
    const err = await syncCursorUsage({
      homeDir: home,
      now: () => NOW,
      sinceMs: NOW - 86_400_000,
      maxBodyBytes: 1000,
      fetch: (async () => new Response(endless, { status: 200 })) as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CursorSyncError);
    expect(err.code).toBe("bad-response");
    expect(pulled).toBeLessThan(20);
    expect(existsSync(join(home, ".cache", "tokmeter", "cursor-usage"))).toBe(false);
  });

  it("never shrinks an existing window file", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 + 3600));
    const opts = { homeDir: home, now: () => NOW, sinceMs: NOW - 86_400_000 };
    await syncCursorUsage({
      ...opts,
      fetch: (async () => csvResponse(`${HEADER}\n${ROW}\n${ROW}\n`)) as typeof fetch,
    });
    const second = await syncCursorUsage({
      ...opts,
      fetch: (async () => csvResponse(`${HEADER}\n`)) as typeof fetch,
    });
    expect(second.windows[0].written).toBe(false);
    expect(readFileSync(second.windows[0].file, "utf-8").split(ROW).length - 1).toBe(2);
  });

  it("refuses an expired token without any request", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 - 7200));
    const fetchMock = vi.fn();
    await expect(
      syncCursorUsage({
        homeDir: home,
        now: () => NOW,
        fetch: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: "expired",
      message: expect.stringMatching(/expired 2h ago.*sign in again/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when there is no session", async () => {
    const { home } = makeHome();
    await expect(
      syncCursorUsage({ homeDir: home, fetch: vi.fn() as unknown as typeof fetch })
    ).rejects.toMatchObject({
      code: "no-token",
    });
  });

  it.each([401, 403])(
    "maps HTTP %i to a sign-in-again message and writes nothing",
    async (status) => {
      const { home } = makeHome(fakeJwt(NOW / 1000 + 3600));
      const err = await syncCursorUsage({
        homeDir: home,
        now: () => NOW,
        sinceMs: NOW - 86_400_000,
        fetch: (async () => csvResponse("unauthorized", status)) as typeof fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(CursorSyncError);
      expect(err.code).toBe("auth");
      expect(err.message).toMatch(/Open Cursor and sign in again/);
      expect(existsSync(join(home, ".cache", "tokmeter", "cursor-usage"))).toBe(false);
    }
  );

  it("rejects a 200 that is not the export (login page / WAF)", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 + 3600));
    await expect(
      syncCursorUsage({
        homeDir: home,
        now: () => NOW,
        sinceMs: NOW - 86_400_000,
        fetch: (async () => csvResponse("<html>Sign in</html>")) as typeof fetch,
      })
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it("reports a timeout as such", async () => {
    const { home } = makeHome(fakeJwt(NOW / 1000 + 3600));
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    await expect(
      syncCursorUsage({
        homeDir: home,
        now: () => NOW,
        sinceMs: NOW - 86_400_000,
        fetch: (async () => {
          throw timeout;
        }) as typeof fetch,
      })
    ).rejects.toMatchObject({ code: "timeout", message: expect.stringMatching(/within 30s/) });
  });

  it("never lets the token, cookie or an email reach an error or a log line", async () => {
    const jwt = fakeJwt(NOW / 1000 + 3600);
    const cookie = encodeURIComponent(`user_FAKE01ABCDEF::${jwt}`);
    const { home } = makeHome(jwt);
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const logged: string[] = [];
    const leakyFetch = (async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      // A transport error that echoes the request, the worst case.
      throw new TypeError(`fetch failed: Cookie: ${h.Cookie} bearer ${jwt} for owner@example.com`);
    }) as unknown as typeof fetch;

    const err = await syncCursorUsage({
      homeDir: home,
      now: () => NOW,
      sinceMs: NOW - 86_400_000,
      fetch: leakyFetch,
      log: (l) => logged.push(l),
    }).catch((e) => e);

    const surfaces = [
      String(err?.message),
      String(err?.stack),
      JSON.stringify(err),
      ...logged,
      ...spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))),
    ].join("\n");
    expect(err).toBeInstanceOf(CursorSyncError);
    expect(err.code).toBe("network");
    for (const secret of [
      jwt,
      cookie,
      ...jwt.split("."),
      "owner@example.com",
      decodeURIComponent(cookie),
    ]) {
      expect(surfaces).not.toContain(secret);
    }
    expect(surfaces).toContain("[redacted");
  });
});

describe("scrubSecrets", () => {
  it("removes JWT-shaped strings, session cookies and emails even when not listed", () => {
    const jwt = fakeJwt(1);
    const out = scrubSecrets(`a ${jwt} b WorkosCursorSessionToken=abc%3A%3Adef; c me@x.io`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("abc%3A%3Adef");
    expect(out).not.toContain("me@x.io");
  });
});
