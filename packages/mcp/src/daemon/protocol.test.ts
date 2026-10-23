import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { daemonAuthHeader } from "./protocol.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("daemon clients read only an owner-private canonical token", () => {
  const root = mkdtempSync(join(tmpdir(), "tokmeter-daemon-auth-"));
  roots.push(root);
  const dir = join(root, "daemon");
  const tokenFile = join(dir, "daemon.token");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(tokenFile, "a".repeat(64), { mode: 0o600 });
  expect(daemonAuthHeader(tokenFile, dir)).toBe(`Bearer ${"a".repeat(64)}`);

  chmodSync(tokenFile, 0o644);
  expect(daemonAuthHeader(tokenFile, dir)).toBeNull();
  chmodSync(tokenFile, 0o600);
  chmodSync(dir, 0o755);
  expect(daemonAuthHeader(tokenFile, dir)).toBeNull();
  chmodSync(dir, 0o700);

  const link = join(dir, "link.token");
  symlinkSync(tokenFile, link);
  expect(daemonAuthHeader(link, dir)).toBeNull();
});
