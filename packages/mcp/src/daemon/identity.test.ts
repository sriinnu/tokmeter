import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  captureDaemonIdentity,
  inspectDaemon,
  readProcessEvidence,
  signalVerifiedDaemon,
} from "./identity.js";

describe("daemon process identity", () => {
  let root: string;
  let pidFile: string;
  let ownerFile: string;
  const evidence = {
    startedAt: "Tue Sep  8 10:00:00 2026",
    command: "node /fixture/cli.js daemon start",
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drishti-identity-"));
    pidFile = join(root, "daemon.pid");
    ownerFile = join(root, "owner.json");
    writeFileSync(pidFile, "4242");
    writeFileSync(ownerFile, JSON.stringify(captureDaemonIdentity(4242, evidence)));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("signals the verified lifetime, not merely an existing PID", () => {
    const signal = vi.fn();
    signalVerifiedDaemon(pidFile, ownerFile, () => evidence, signal);
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
  });

  test("a recycled PID or a changed executable command is not the daemon", () => {
    for (const replacement of [
      { ...evidence, startedAt: "later" },
      { ...evidence, command: "unrelated app" },
    ]) {
      const signal = vi.fn();
      expect(inspectDaemon(pidFile, ownerFile, () => replacement).state).toBe("unverified");
      expect(() => signalVerifiedDaemon(pidFile, ownerFile, () => replacement, signal)).toThrow(
        "refusing"
      );
      expect(signal).not.toHaveBeenCalled();
    }
  });

  test("refuses if the identity changes between lookup and signal", () => {
    const inspect = vi
      .fn()
      .mockReturnValueOnce(evidence)
      .mockReturnValue({ ...evidence, startedAt: "later" });
    const signal = vi.fn();
    expect(() => signalVerifiedDaemon(pidFile, ownerFile, inspect, signal)).toThrow("refusing");
    expect(signal).not.toHaveBeenCalled();
  });

  test("malformed PID and malformed ownership files fail closed", () => {
    writeFileSync(pidFile, "4242junk");
    expect(inspectDaemon(pidFile, ownerFile, () => evidence).state).toBe("unverified");
    writeFileSync(pidFile, "4242");
    writeFileSync(ownerFile, "not json");
    expect(inspectDaemon(pidFile, ownerFile, () => evidence).state).toBe("unverified");
  });

  test("legacy discovery requires the package's real CLI entrypoint, including symlinks", () => {
    rmSync(ownerFile);
    const packageRoot = join(root, "legacy package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    const entry = join(packageRoot, "dist", "cli.js");
    writeFileSync(entry, "");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@sriinnu/drishti", bin: { drishti: "dist/cli.js" } })
    );
    const link = join(root, "drishti");
    symlinkSync(entry, link);
    const legacy = { ...evidence, command: `/opt/node ${link} daemon start` };
    expect(inspectDaemon(pidFile, ownerFile, () => legacy).state).toBe("verified");
    expect(
      inspectDaemon(pidFile, ownerFile, () => ({ ...legacy, command: `${legacy.command} extra` }))
        .state
    ).toBe("unverified");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "unrelated", bin: { drishti: "dist/cli.js" } })
    );
    expect(inspectDaemon(pidFile, ownerFile, () => legacy).state).toBe("unverified");
  });

  test("the bounded native query can identify this test process", () => {
    expect(readProcessEvidence(process.pid)?.startedAt).toBeTruthy();
  });
});
