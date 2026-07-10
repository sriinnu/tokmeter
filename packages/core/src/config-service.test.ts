import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFilePath, loadConfig, setConfigValue } from "./config-service.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-service-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function writeConfig(json: unknown): void {
  const path = configFilePath(tmpDir);
  mkdirSync(join(tmpDir, ".tokmeter"), { recursive: true });
  writeFileSync(path, JSON.stringify(json));
}

describe("providerPaths", () => {
  it("defaults to {} when absent from an existing config file", () => {
    writeConfig({ version: 1 });
    expect(loadConfig(tmpDir).providerPaths).toEqual({});
  });

  it("round-trips valid provider path entries", () => {
    writeConfig({
      version: 1,
      providerPaths: {
        antigravity: ["~/custom/antigravity-ide"],
        cursor: ["/opt/cursor-portable"],
      },
    });
    const config = loadConfig(tmpDir);
    expect(config.providerPaths.antigravity).toEqual(["~/custom/antigravity-ide"]);
    expect(config.providerPaths.cursor).toEqual(["/opt/cursor-portable"]);
  });

  it("drops a malformed entry without falling back to defaults for the rest of the file", () => {
    writeConfig({
      version: 1,
      bar: { refreshSeconds: 45, menubarColorSource: "budget" },
      providerPaths: {
        cursor: ["/opt/cursor-portable"],
        "not-an-array": "oops",
        antigravity: [123, null, "/valid/path"],
      },
    });
    const config = loadConfig(tmpDir);
    expect(config.providerPaths.cursor).toEqual(["/opt/cursor-portable"]);
    expect(config.providerPaths["not-an-array"]).toBeUndefined();
    // non-string entries filtered out, valid string kept
    expect(config.providerPaths.antigravity).toEqual(["/valid/path"]);
    // sibling field untouched by the malformed providerPaths entries
    expect(config.bar.refreshSeconds).toBe(45);
  });

  it("returns {} when providerPaths itself is the wrong type", () => {
    writeConfig({ version: 1, providerPaths: "not-an-object" });
    expect(loadConfig(tmpDir).providerPaths).toEqual({});
  });
});

describe("daemon.antigravityLivePolling", () => {
  it("defaults to false when absent from an existing config file", () => {
    writeConfig({ version: 1 });
    expect(loadConfig(tmpDir).daemon.antigravityLivePolling).toBe(false);
  });

  it("stays false for any non-boolean-true value — no truthy coercion", () => {
    for (const garbage of ["true", 1, "yes", {}, [1]]) {
      writeConfig({ version: 1, daemon: { antigravityLivePolling: garbage } });
      expect(loadConfig(tmpDir).daemon.antigravityLivePolling).toBe(false);
    }
  });

  it("turns on only for the literal boolean true", () => {
    writeConfig({ version: 1, daemon: { antigravityLivePolling: true } });
    expect(loadConfig(tmpDir).daemon.antigravityLivePolling).toBe(true);
  });

  it("can be set explicitly via setConfigValue (the CLI path)", () => {
    const config = loadConfig(tmpDir);
    expect(config.daemon.antigravityLivePolling).toBe(false);

    const next = setConfigValue(config, "daemon.antigravityLivePolling", "true");
    expect(next.daemon.antigravityLivePolling).toBe(true);

    expect(() => setConfigValue(config, "daemon.antigravityLivePolling", "sure")).toThrow();
  });
});
