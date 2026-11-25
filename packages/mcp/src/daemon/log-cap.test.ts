import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capDaemonLogs, capLogFile } from "./log-cap.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-cap-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = (n: number, tag = "line") =>
  Array.from({ length: n }, (_, i) => `${tag} ${String(i).padStart(5, "0")}\n`).join("");

describe("capLogFile", () => {
  it("leaves a log at or under the cap alone", () => {
    const log = join(dir, "daemon.err.log");
    writeFileSync(log, lines(10));
    expect(capLogFile(log, 1024)).toEqual({ rotated: false });
    expect(readFileSync(log, "utf8")).toBe(lines(10));
    expect(() => statSync(`${log}.1`)).toThrow();
  });

  it("keeps the newest whole lines in .1 and empties the log", () => {
    const log = join(dir, "daemon.err.log");
    const body = lines(1000); // 11 bytes per line
    writeFileSync(log, body);
    expect(capLogFile(log, 100)).toEqual({ rotated: true, kept: true });

    const kept = readFileSync(`${log}.1`, "utf8");
    expect(kept.length).toBeLessThanOrEqual(100);
    expect(kept.startsWith("line ")).toBe(true); // no partial first line
    expect(kept.endsWith("line 00999\n")).toBe(true); // newest line survives
    expect(body.endsWith(kept)).toBe(true);
    expect(statSync(log).size).toBe(0);
    if (process.platform !== "win32") {
      expect(statSync(`${log}.1`).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an older .1 rather than appending to it", () => {
    const log = join(dir, "daemon.out.log");
    writeFileSync(`${log}.1`, "stale\n");
    writeFileSync(log, lines(50, "new"));
    capLogFile(log, 64);
    expect(readFileSync(`${log}.1`, "utf8")).not.toContain("stale");
  });

  it("a tail with no line break is kept raw, not dropped", () => {
    const log = join(dir, "daemon.err.log");
    writeFileSync(log, "x".repeat(5000));
    capLogFile(log, 100);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(100));
  });

  // The disk-full case: .1 can't be written. The log must still be emptied
  // (leaving it would retry and fail forever), and the loss must be reported.
  // A read-only directory stands in for a full disk: no new file can be made.
  it.skipIf(process.platform === "win32")(
    "empties the log even when .1 can't be written, and says the tail was lost",
    () => {
      const ro = join(dir, "ro");
      mkdirSync(ro);
      const log = join(ro, "daemon.err.log");
      writeFileSync(log, lines(500));
      chmodSync(ro, 0o500);
      try {
        expect(capLogFile(log, 100)).toMatchObject({ rotated: true, kept: false });
        expect(statSync(log).size).toBe(0);
      } finally {
        chmodSync(ro, 0o700);
      }
    }
  );

  it("a missing log is not an error", () => {
    expect(capLogFile(join(dir, "nope.log"), 10)).toEqual({ rotated: false });
  });

  // launchd holds the log open with O_APPEND for the daemon's whole life. A
  // rename would leave it writing into .1; a truncate under a non-append fd
  // would leave a run of NUL bytes before the next line. Neither may happen.
  it("an O_APPEND writer held open across the rotation keeps writing to a clean log", () => {
    const log = join(dir, "daemon.err.log");
    const fd = openSync(log, "a");
    try {
      writeSync(fd, lines(500, "old"));
      expect(capLogFile(log, 200).rotated).toBe(true);
      writeSync(fd, "after rotation\n");
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, "utf8")).toBe("after rotation\n");
    expect(readFileSync(`${log}.1`, "utf8")).not.toContain("after rotation");
  });
});

describe("capDaemonLogs", () => {
  it("caps only the launchd logs and points the emptied one at .1", () => {
    writeFileSync(join(dir, "daemon.out.log"), lines(5));
    writeFileSync(join(dir, "daemon.err.log"), lines(500));
    writeFileSync(join(dir, "other.log"), lines(500));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(capDaemonLogs(dir, 300)).toEqual(["daemon.err.log"]);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("daemon.err.log.1"));
    } finally {
      err.mockRestore();
    }
    expect(statSync(join(dir, "other.log")).size).toBe(lines(500).length);
  });

  it("never throws: a log it can't read is reported and the other still rotates", () => {
    mkdirSync(join(dir, "daemon.out.log")); // reading a directory fails
    writeFileSync(join(dir, "daemon.err.log"), lines(500));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(capDaemonLogs(dir, 0)).toEqual(["daemon.err.log"]);
      expect(err).toHaveBeenCalledWith(
        "log cap: could not rotate daemon.out.log:",
        expect.anything()
      );
    } finally {
      err.mockRestore();
    }
  });
});
