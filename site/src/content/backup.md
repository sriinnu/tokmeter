---
title: "Backup, Snapshot & Restore"
source: "https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md"
---

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

## What restore will and won't write

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
cleanup** — and agents driving the MCP server over stdio can only preview.

### CLI

```bash
tokmeter cleanup                                     # interactive: prompts "type DELETE"
tokmeter cleanup --project app --until 2026-10-04    # flag-driven, still prompts
tokmeter cleanup --project app --until 2026-10-04 --dry-run   # preview only
tokmeter cleanup --project app --until 2026-10-04 --force     # skip the prompt (still needs a terminal)
```

- **Interactive and flag-driven runs both prompt** `Type DELETE to confirm`
  before deleting. `--dry-run` previews and deletes nothing. `--force` skips the
  prompt (for scripts) — it does **not** skip the backup.
- **Backup is always on in the CLI.** A `.tar.gz` is written to
  `~/.cache/tokmeter/backups/` before the first file is removed; there is no
  `--no-backup` flag.

### MCP (preview only)

An agent calling over stdio never sees a terminal prompt, so the MCP server
doesn't delete or restore anything:

- **`tokmeter_cleanup_preview`** reports the exact files, bytes,
  per-project/provider breakdown and partial-file warnings, then tells the user
  to run `tokmeter cleanup` with the same filters. It deletes nothing.
- **`tokmeter_backups`** lists backups. There is no MCP restore; the user runs
  `tokmeter restore`.
- Deleting and restoring always go through a human, at a terminal or in the
  TUI. See [MCP tool reference](/mcp/#tokmeter_cleanup_preview) for what earlier releases exposed.

From 1.15.0, an **empty filter is refused**, in core, for every caller (CLI,
TUI, daemon HTTP). With no project, no providers and no date range, a cleanup
would match every session of every provider. Name at least one of: `project`,
`providers`, `since`/`until`, or a `today`/`week`/`month` scope. Provider-only
and date-only cleanups still work. The interactive CLI's "all" choice is
unaffected, because it passes the explicit list of projects.
