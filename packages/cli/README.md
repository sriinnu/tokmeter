<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@sriinnu/tokmeter-cli</h1>

<p align="center"><strong>Token usage tracker CLI -- table and JSON output</strong></p>

---

Command-line interface for tokmeter. Scans all local AI agent sessions and displays usage in formatted tables or JSON.

## Install

```bash
# Run directly
npx @sriinnu/tokmeter-cli

# Or install globally
npm install -g @sriinnu/tokmeter-cli
tokmeter
```

## Commands

```bash
tokmeter                          # overview (all projects)
tokmeter models                   # per-model cost breakdown
tokmeter daily                    # daily usage over time
tokmeter projects                 # per-project summary
tokmeter stats                    # overall statistics
tokmeter pricing sonnet           # lookup model pricing
tokmeter cleanup                  # interactive wipe with pre-delete backup
tokmeter snapshot                 # portable backup (no deletion)
tokmeter restore [--latest|--id]  # restore from ~/.cache/tokmeter/backups/
```

See the top-level README for the full cross-machine backup/restore workflow.

## Filters

```bash
tokmeter --project my-app         # specific project
tokmeter --claude --opencode      # specific providers
tokmeter --today                  # today only
tokmeter --week                   # last 7 days
tokmeter --month                  # current month
tokmeter --since 2025-01-01 --until 2025-12-31
```

## Output

```bash
tokmeter --json                   # JSON output (for piping/CI)
tokmeter --light                  # skip pricing (faster)
```

### Example

```
+---------------------------+------------+--------+--------+----------+---------+
| Project                   | Tokens     | Cost   | Models | Providers| Days    |
+---------------------------+------------+--------+--------+----------+---------+
| myapp                     | 2.4M       | $24.20 | 3      | 2        | 14      |
| api-server                | 800.0K     | $8.50  | 2      | 1        | 7       |
+---------------------------+------------+--------+--------+----------+---------+
```

## License

MIT
