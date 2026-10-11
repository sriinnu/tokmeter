# Backup, Snapshot & Restore

Three commands handle everything from reclaiming disk space to carrying your
session history across machines. Every destructive operation writes a tar
archive to `~/.cache/tokmeter/backups/` first, and `restore` auto-remaps paths
when the source and target homedirs differ (different user, different OS).

```bash
tokmeter cleanup                  # interactive stepper: pick projects → dates → confirm
tokmeter snapshot                 # non-destructive backup (nothing is deleted)
tokmeter restore                  # list all local backups
tokmeter restore --latest         # restore the most recent backup
tokmeter restore --id <backup-id> # restore a specific archive
```

**Interactive cleanup** walks you through three steps: pick one or more
projects, pick the dates to wipe (or "all"), then confirm. A backup archive is
created before anything is deleted; restores replay that archive back into
place.

**Snapshot** is the same machinery without the deletion — use it when you just
want a portable copy of your session data. It drops a `.tar.gz` plus a
`.meta.json` beside it; copy both files to another machine's
`~/.cache/tokmeter/backups/` and run `tokmeter restore --latest` there.

**Cross-machine restore** works without configuration. The archive records the
source `$HOME`, username, and platform. On restore, if the target homedir
differs, paths are transparently remapped (e.g. `/home/alice/.claude/...` →
`/Users/bob/.claude/...`) and the confirmation prompt shows
`Source → Target → Mode` so you know exactly what will happen.

**UUID collision handling** (cross-machine restores): if a restored session
would overwrite a session that already exists locally (same UUID from working
on both machines), the restored copy gets a freshly-minted UUID instead — propagated consistently
across all seven associated paths (transcript, subagents, file-history, tasks,
todos, session-env, and the project index entry). Local sessions with the
same id stay put; the restored ones land alongside them with new ids. A
same-machine restore (same home directory) extracts the archive back to the
original paths instead, replacing any file currently at the same path.

**Caveat**: JSONL-based providers (Claude Code, Codex, OpenCode, Gemini, Kimi,
Qwen, etc.) restore end-to-end. SQLite-backed providers (Cursor, VS Code,
Roo/Kilo) are backed up at the row level but not re-injected on restore —
their data shows up in tokmeter stats once re-indexed, but isn't written back
into the editor's SQLite DB.

## What restore will and won't write (next release)

Snapshots are made to move between machines, so restore treats an archive as
untrusted input:

- **Entry types are checked first.** Only regular files and directories may
  come out of a backup. Symlink, hardlink, device and fifo entries, and any
  path with a `..` segment, are refused before anything is extracted.
- **Extraction happens in a private temp directory** (mode 0700), never at
  `/`. The extracted tree is checked again with `lstat`: no symlinks, regular
  files only, no multiply-linked files. The temp directory is always removed.
- **Files are copied into place only inside an allowlist.** The allowlist is
  the session paths tokmeter's own scanner reads, plus the Claude Code side
  directories (`file-history`, `tasks`, `todos`, `session-env`), tokmeter's
  `aliases.json` and `config.json`, and the backup's own SQL-dump directory.
  The scanner paths come from each provider's `sessionRoots`, the same
  function its scan uses, including any `providerPaths` and custom sources in
  `~/.tokmeter/config.json`. A configured path that is `$HOME` itself, or one
  of its parents, is ignored.
- **A cross-home remap must stay inside `$HOME`** and inside that allowlist.
  Entries outside the source home are ignored, as before.
- **All or nothing.** If any file fails a check, the restore stops before
  anything is written and reports which entry was refused.
- File modes (without setuid/setgid) and mtimes are kept, as `tar -x` kept
  them. UUID re-minting on cross-home collisions works as described above.
- A snapshot whose meta file records another machine's archive path restores
  from the `<id>.tar.gz` that sits next to the meta file.

If a restore you expect to work is refused, the error names the entry. Usually
it's a file outside every provider's session path, such as a session directory
you moved and pointed tokmeter at only on the old machine. Add that location
under `providerPaths` in `~/.tokmeter/config.json`, then restore again.

## Confirmation and backup: where the gate lives

Cleanup deletes raw session files, so every path has a confirmation step and a
pre-delete backup. **Where that confirmation comes from depends on how you call
cleanup** — a common question for agents driving the MCP server over stdio,
where there is no terminal prompt to see.

### CLI

```bash
tokmeter cleanup                                     # interactive: prompts "type DELETE"
tokmeter cleanup --project app --until 2026-10-04    # flag-driven, still prompts
tokmeter cleanup --project app --until 2026-10-04 --dry-run   # preview only
tokmeter cleanup --project app --until 2026-10-04 --force     # skip the prompt
```

- **Interactive and flag-driven runs both prompt** `Type DELETE to confirm`
  before deleting. `--dry-run` previews and deletes nothing. `--force` skips the
  prompt (for scripts) — it does **not** skip the backup.
- **Backup is always on in the CLI.** A `.tar.gz` is written to
  `~/.cache/tokmeter/backups/` before the first file is removed; there is no
  `--no-backup` flag.

### MCP (`tokmeter_cleanup_execute`)

An agent calling over stdio never sees a terminal prompt, so the gate is
enforced **inside the server**, not left to the client:

- `tokmeter_cleanup_execute` **refuses to run unless it is passed
  `confirm: "DELETE"`** — checked in the tool handler before `CleanupService`
  runs; any other value returns an error and deletes nothing.
- **Backup is on by default** (`backup: true`); pass `backup: false` to opt out.
  **(next release)** Over MCP the backup is mandatory: `backup: false` is
  accepted for compatibility, but it's ignored and the result says so.
- **(next release)** An **empty filter is refused**, in core, for every caller
  (CLI, TUI, MCP, daemon HTTP). With no project, no providers and no date
  range, a cleanup would match every session of every provider. Name at least
  one of: `project`, `providers`, `since`/`until`, or a `today`/`week`/`month`
  scope. Provider-only and date-only cleanups still work. The interactive
  CLI's "all" choice is unaffected, because it passes the explicit list of
  projects.
- Always call **`tokmeter_cleanup_preview`** first; it reports the exact files,
  bytes, and per-project/provider breakdown that `execute` would delete.
- `tokmeter_restore` has the same shape, guarded by `confirm: "RESTORE"`.

One honest distinction worth internalising: `confirm: "DELETE"` is a
**deliberate-action guard, not proof a human agreed** — an autonomous agent can
supply the string itself. The actual human "are you sure?" comes from your **MCP
client/host's tool-approval UI** (the same layer that approves any tool call),
not from inside the server. The CLI's `type DELETE` prompt and the MCP's
`confirm` argument are two renderings of the same gate: one for a human at a
terminal, one for a programmatic caller. The pre-delete backup is the
recoverability net in both paths.
