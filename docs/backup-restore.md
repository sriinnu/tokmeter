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
