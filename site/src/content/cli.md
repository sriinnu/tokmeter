---
title: "CLI reference"
source: "https://github.com/sriinnu/tokmeter/wiki/CLI-Reference"
---

```sh
tokmeter                 # overview: projects + totals, all time (add --today, --week …)
tokmeter models          # per-model cost/tokens
tokmeter projects        # per-project breakdown
tokmeter daily           # day-by-day
tokmeter stats           # summary stats
tokmeter digest          # narrative report card
tokmeter pricing <model> # price lookup
```

## Filters

- Scope: `--today`, `--week`, `--month`, `--since YYYY-MM-DD --until YYYY-MM-DD`, `--older-than 30d|2w|1m`, `--year N`
- Project: `--project NAME` (substring)
- Provider: `--claude`, `--codex`, `--gemini`, `--cursor`, `--opencode`, `--amp`, `--muse`, `--cline`, `--augment`, `--copilot-cli`, `--kimi`, `--qwen`, `--roocode`, `--kilo`, `--kilocode`, `--droid`, `--openclaw`, `--pi`, `--mux`, `--ribhu`, `--chitragupta`, `--grok`, `--custom`, `--synthetic` (repeatable)
- Output: `--json`, `--light` (skip pricing lookups)

## Backup, snapshot & cleanup

```sh
tokmeter snapshot                 # portable backup, nothing deleted
tokmeter restore --latest         # restore most recent backup
tokmeter restore --id <id>        # restore a specific archive
tokmeter cleanup                  # interactive: pick projects -> dates -> type DELETE
tokmeter cleanup --project app --until 2026-10-04 --dry-run   # preview only
tokmeter cleanup --project app --until 2026-10-04             # prompts for DELETE
```

Cleanup always writes a `.tar.gz` backup to `~/.cache/tokmeter/backups/` before
deleting (no `--no-backup` flag). `--force` skips the prompt, not the backup.
`--dry-run` deletes nothing. Since 1.19.2, each backup has a unique ID even if
two are made in the same second; the archive is validated and synced before
cleanup can remove source files. Restore refuses symlinked destination parents
and archives that exceed its entry, expanded-size or free-space limits. A
configured external path through a symlink may therefore need a direct path
before restoring. See
[Backup, snapshot & restore](https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md).

> **Scope cleanup to `--until` yesterday or older.** Sealed past days live in the
> relay ledger even after raw transcripts age out, but *today* isn't sealed yet —
> deleting today's raw before midnight rollover loses it.

## Checking history

```sh
tokmeter coverage                      # yesterday: files that changed but fed no usage
tokmeter coverage --date 2026-10-19    # any day; --json for the full report
tokmeter backfill --codex --days 30    # add one tool's missing usage to sealed days
```

`coverage` (1.17.0+) lists session files under each tool's data folder that
changed on that day, contain a real token count, and fed nothing into the
ledger — the sign that a tool started writing somewhere tokmeter doesn't read
yet. It exits with code 2 when it finds any. The daemon runs the same check
after every day seals and shows a warning.
