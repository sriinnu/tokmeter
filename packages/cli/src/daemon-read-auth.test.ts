import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { daemonReadAuthorization } from "./daemon-read.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("CLI fast path requires a private token, otherwise it can scan locally", () => {
  const home = mkdtempSync(join(tmpdir(), "tokmeter-cli-auth-"));
  homes.push(home);
  const dir = join(home, ".tokmeter", "daemon");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, "daemon.token");
  expect(daemonReadAuthorization(home)).toBeNull();
  writeFileSync(token, "b".repeat(64), { mode: 0o600 });
  expect(daemonReadAuthorization(home)).toBe(`Bearer ${"b".repeat(64)}`);
  chmodSync(token, 0o644);
  expect(daemonReadAuthorization(home)).toBeNull();
});
