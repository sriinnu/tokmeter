import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from "./private-files.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tokmeter-private-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("owner-only Tokmeter storage", () => {
  it("tightens an old directory and file, then replaces the file privately", () => {
    const dir = join(root, "tokmeter");
    const file = join(dir, "scan-cache.json");
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(file, "old", { mode: 0o644 });
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);

    ensurePrivateDirectory(dir);
    ensurePrivateFile(file);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writePrivateFile(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses symlinked directories and linked files", () => {
    const dir = join(root, "real");
    mkdirSync(dir);
    symlinkSync(dir, join(root, "linked-dir"));
    expect(() => ensurePrivateDirectory(join(root, "linked-dir"))).toThrow(/regular directory/);

    const file = join(dir, "file");
    writeFileSync(file, "secret");
    symlinkSync(file, join(dir, "linked-file"));
    linkSync(file, join(dir, "hardlink"));
    expect(() => ensurePrivateFile(join(dir, "linked-file"))).toThrow(/regular file/);
    expect(() => ensurePrivateFile(file)).toThrow(/singly linked/);
  });
});
