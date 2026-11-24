function isMissingMcpError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const msg = typeof e.message === "string" ? e.message : "";
  return (
    (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND") &&
    msg.includes("@sriinnu/tokmeter-mcp")
  );
}

/**
 * Load an optional module from `@sriinnu/tokmeter-mcp` for CLI subcommands
 * that delegate to it (`live`, `statusline`, `daemon`, installers).
 * Standalone `@sriinnu/tokmeter` installs omit `@sriinnu/tokmeter-mcp` to avoid
 * a circular dependency, so exit cleanly with install instructions when absent.
 */
export async function loadMcpModule<T>(
  load: () => Promise<T>,
  command: string,
  onMissing: (message: string) => void = (msg) => console.error(msg),
  exit: (code: number) => never = (code) => process.exit(code)
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isMissingMcpError(err)) {
      onMissing(
        `\`tokmeter ${command}\` requires @sriinnu/tokmeter-mcp, which is not installed.\n` +
          "Install it with: npm install -g @sriinnu/tokmeter-mcp (or npx @sriinnu/tokmeter-mcp " +
          `${command})`
      );
      return exit(1);
    }
    throw err;
  }
}
