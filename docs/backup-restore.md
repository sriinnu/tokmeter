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

**UUID collision handling**: if a restored session would overwrite a session
that already exists locally (same UUID from working on both machines), the
restored copy gets a freshly-minted UUID instead — propagated consistently
across all seven associated paths (transcript, subagents, file-history, tasks,
todos, session-env, and the project index entry). Local sessions with the
same id stay put; the restored ones land alongside them with new ids.

**Caveat**: JSONL-based providers (Claude Code, Codex, OpenCode, Gemini, Kimi,
Qwen, etc.) restore end-to-end. SQLite-backed providers (Cursor, VS Code,
Roo/Kilo) are backed up at the row level but not re-injected on restore —
their data shows up in tokmeter stats once re-indexed, but isn't written back
into the editor's SQLite DB.

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
