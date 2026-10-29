/**
 * Destructive commands (cleanup, restore) run only from a real terminal.
 *
 * Their confirmation prompt is what keeps a person in the loop, and a prompt
 * read from a pipe proves nothing: `echo DELETE | tokmeter cleanup` or a
 * `--force` flag typed by an agent would skip it. Requiring a TTY on both
 * ends makes "an agent deleted my sessions" take a deliberate workaround
 * instead of one command. Previews (`--dry-run`, `--json`) stay available
 * everywhere.
 */

interface TtyLike {
  isTTY?: boolean;
}

export function isInteractiveTerminal(
  stdin: TtyLike = process.stdin,
  stdout: TtyLike = process.stdout
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** Print why and set a failing exit code when not on a terminal. */
export function requireInteractiveTerminal(
  command: "cleanup" | "restore",
  stdin: TtyLike = process.stdin,
  stdout: TtyLike = process.stdout
): boolean {
  if (isInteractiveTerminal(stdin, stdout)) return true;
  console.error(
    `\n✋ tokmeter ${command} changes session files, so it only runs in an interactive terminal.\n` +
      `   Run it yourself in a terminal. To see what it would do, use --dry-run.\n`
  );
  process.exitCode = 1;
  return false;
}
