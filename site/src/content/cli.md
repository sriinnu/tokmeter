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
- Provider: `--claude`, `--codex`, `--gemini`, `--cursor`, `--opencode`, `--amp`, `--muse`, `--cline`, `--augment`, `--copilot-cli`, `--kimi`, `--qwen`, `--roocode`, `--kilo`, `--kilocode`, `--droid`, `--openclaw`, `--pi`, `--mux`, `--ribhu`, `--grok`, `--custom`, `--synthetic` (repeatable)
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
`--dry-run` deletes nothing. See
[Backup, snapshot & restore](https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md).

> **Scope cleanup to `--until` yesterday or older.** Sealed past days live in the
> relay ledger even after raw transcripts age out, but *today* isn't sealed yet —
> deleting today's raw before midnight rollover loses it.
