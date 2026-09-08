# @sriinnu/tokmeter-cli

Private workspace package. Use the public `@sriinnu/tokmeter` distribution.

Command-line interface for token usage tracking. Displays usage in formatted tables or JSON.

## Capabilities

- Overview, models, daily, projects, stats views
- Filter by project, provider, date range
- JSON output for piping and CI integration
- Pricing lookup for any model

## Commands

```bash
tokmeter                    # overview
tokmeter models             # per-model breakdown
tokmeter daily              # daily trend
tokmeter projects           # per-project summary
tokmeter stats              # statistics
tokmeter pricing sonnet     # lookup pricing
tokmeter --json             # JSON output
tokmeter --today            # today only
```

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).
