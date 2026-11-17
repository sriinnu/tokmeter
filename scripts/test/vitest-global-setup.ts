/**
 * One temp root per test run. vitest-setup.ts makes each test file's HOME
 * inside it, and the teardown removes the whole root, including the HOMEs of
 * files whose afterAll never ran (todo-only or skipped files).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  if (process.env.TOKMETER_TEST_REAL_HOME === "1") return () => {};
  const root = mkdtempSync(join(tmpdir(), "tokmeter-test-run-"));
  process.env.TOKMETER_TEST_HOME_ROOT = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
