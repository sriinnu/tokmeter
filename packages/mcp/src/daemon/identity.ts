import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ProcessEvidence {
  startedAt: string;
  command: string;
}

export interface DaemonIdentity {
  pid: number;
  startedAt: string;
  commandHash: string;
}

export type DaemonInspection =
  | { state: "verified"; identity: DaemonIdentity }
  | { state: "absent" | "unverified" };

/** Inspect only the requested PID. Commands are hashed before being stored. */
export function readProcessEvidence(pid: number): ProcessEvidence | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "win32") {
      const script = `$tokmeterProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($tokmeterProcess) { @{ startedAt = $tokmeterProcess.CreationDate.ToUniversalTime().ToString('o'); command = $tokmeterProcess.CommandLine } | ConvertTo-Json -Compress }`;
      const value = JSON.parse(
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          timeout: 1500,
          maxBuffer: 16_384,
          stdio: ["ignore", "pipe", "ignore"],
        })
      );
      return typeof value.startedAt === "string" && typeof value.command === "string"
        ? value
        : null;
    }
    const result = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 16_384,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const match = result.match(
      /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]+)$/
    );
    return match ? { startedAt: match[1], command: match[2] } : null;
  } catch {
    return null;
  }
}

export function captureDaemonIdentity(pid: number, evidence: ProcessEvidence): DaemonIdentity {
  return {
    pid,
    startedAt: evidence.startedAt,
    commandHash: createHash("sha256").update(evidence.command).digest("hex"),
  };
}

/** Compatibility for pre-identity releases: require the actual Drishti entrypoint. */
function isLegacyDaemon(command: string): boolean {
  const match = command.match(/^(?:.+\/(?:node|nodejs|bun)|node|nodejs|bun) (.+) daemon start$/);
  if (!match || !isAbsolute(match[1])) return false;
  try {
    const entrypoint = realpathSync(match[1]);
    const packageRoot = dirname(dirname(entrypoint));
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return (
      manifest.name === "@sriinnu/drishti" &&
      typeof manifest.bin?.drishti === "string" &&
      resolve(packageRoot, manifest.bin.drishti) === entrypoint
    );
  } catch {
    return false;
  }
}

export function inspectDaemon(
  pidFile: string,
  identityFile: string,
  inspect: (pid: number) => ProcessEvidence | null = readProcessEvidence
): DaemonInspection {
  let pid: number;
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) return { state: "unverified" };
    pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "unverified" };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unverified" };
  }
  const evidence = inspect(pid);
  if (!evidence) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "absent" };
    }
    return { state: "unverified" };
  }
  const current = captureDaemonIdentity(pid, evidence);
  try {
    const saved = JSON.parse(readFileSync(identityFile, "utf8")) as DaemonIdentity;
    return saved.pid === current.pid &&
      saved.startedAt === current.startedAt &&
      saved.commandHash === current.commandHash
      ? { state: "verified", identity: current }
      : { state: "unverified" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && isLegacyDaemon(evidence.command)) {
      return { state: "verified", identity: current };
    }
    return { state: "unverified" };
  }
}

/** Recheck lifetime immediately before signalling; never signal from a bare PID file. */
export function signalVerifiedDaemon(
  pidFile: string,
  identityFile: string,
  inspect: (pid: number) => ProcessEvidence | null = readProcessEvidence,
  signal: (pid: number, signal: NodeJS.Signals) => unknown = process.kill
): void {
  const first = inspectDaemon(pidFile, identityFile, inspect);
  const second = inspectDaemon(pidFile, identityFile, inspect);
  if (
    first.state !== "verified" ||
    second.state !== "verified" ||
    JSON.stringify(first.identity) !== JSON.stringify(second.identity)
  ) {
    throw new Error("Daemon identity is unverified or changed; refusing to signal the PID.");
  }
  signal(second.identity.pid, "SIGTERM");
}
