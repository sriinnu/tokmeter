/**
 * Test hermeticity guard — snapshots the user's tokmeter + kosha state
 * dirs before tests and re-checks after. Fails loudly if any test wrote
 * to ~/.tokmeter, ~/.cache/tokmeter, or ~/.kosha.
 *
 * Why: when tests touch the user's real state directories, two classes
 * of bug appear silently:
 *   - tests wipe the user's pricing manifest (already happened once)
 *   - tests pollute scan-cache/history-snapshot with fake records that
 *     show up forever in the bar UI
 *
 * To intentionally write during a test, set TEST_ALLOW_HOME_WRITES=1.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const ROOTS = [
  join(homedir(), ".tokmeter"),
  join(homedir(), ".cache", "tokmeter"),
  join(homedir(), ".kosha"),
];
const ALLOW = process.env.TEST_ALLOW_HOME_WRITES === "1";

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

let baselines: Map<string, Map<string, FileSnapshot>> | null = null;

function snapshotDir(root: string): Map<string, FileSnapshot> {
  const out = new Map<string, FileSnapshot>();
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const s = statSync(p);
        if (s.isDirectory()) stack.push(p);
        else out.set(p, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // raced with another process — skip
      }
    }
  }
  return out;
}

beforeAll(() => {
  if (ALLOW) return;
  baselines = new Map();
  for (const root of ROOTS) baselines.set(root, snapshotDir(root));
});

afterAll(() => {
  if (ALLOW || !baselines) return;
  const changed: string[] = [];
  for (const [root, before] of baselines) {
    const after = snapshotDir(root);
    for (const [path, snap] of after) {
      const prev = before.get(path);
      if (!prev || prev.mtimeMs !== snap.mtimeMs || prev.size !== snap.size) {
        changed.push(path);
      }
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.push(`${path} (deleted)`);
    }
  }
  if (changed.length > 0) {
    const list = changed.map((p) => `  - ${p}`).join("\n");
    throw new Error(
      `[hermeticity] tests modified the user's real state dirs:\n${list}\n\nUse a tmpdir or set TEST_ALLOW_HOME_WRITES=1 if intentional.`
    );
  }
});
