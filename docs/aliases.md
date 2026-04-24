# Project Aliases

> Merge variants of the same project across machines, rename noisy canonical
> names, tag projects (`work`/`client`/`self`), and hide archived ones — all
> without touching your session files.

## Why

When the same project is opened on different machines, the canonical project
name tokmeter derives from the cwd can drift:

| Machine | cwd | Canonical name |
| --- | --- | --- |
| Mac | `/Users/bob/Sriinnu/Personal/Vortex` | `Vortex` |
| Linux office PC | `/mnt/c/sriinnu/personal/vortex` | `vortex` |

After restoring the Linux snapshot onto the Mac, tokmeter shows **two** rows
(`Vortex` and `vortex`) for what is, in your head, one project. Similar stories
for long path names (`WeatherApp/frontend` when the `/frontend` is just a
subdir you want to collapse away) and for archived projects you don't want to
see in the default table but still want counted in totals.

Aliases solve all three cases with a single user-editable file.

---

## File location

```
~/.tokmeter/aliases.json
```

- Separate from `~/.cache/tokmeter/` so it survives `bun run clean` / cache
  wipes — this is user state, not derived data.
- Automatically included in every `tokmeter snapshot` bundle, so your project
  renames and tags travel with your data across machines.

## File format

A flat object keyed by the **canonical project name** tokmeter already knows
about (what you see in the `Project` column). The resolver is fed these keys;
the `display` field is what the UI shows.

```json
{
  "Vortex": {
    "display": "Vortex",
    "hidden": false,
    "tags": ["self"],
    "modifiedBy": "user",
    "modifiedAt": "2026-04-24T13:22:00Z"
  },
  "vortex": {
    "display": "Vortex",
    "hidden": false,
    "tags": ["self"],
    "modifiedBy": "user",
    "modifiedAt": "2026-04-24T13:22:00Z"
  },
  "WeatherApp/frontend": {
    "display": "WeatherApp",
    "hidden": false,
    "tags": ["work", "client"],
    "modifiedBy": "user",
    "modifiedAt": "2026-04-24T13:20:00Z"
  }
}
```

### Fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `display` | string | — | What the CLI/menubar shows in place of the canonical name. Same `display` across entries = merge into one row. |
| `hidden` | bool | `false` | Drop the project from per-project tables. Totals still reflect it. A display stays visible as long as at least one of its raw keys is not hidden. |
| `tags` | string[] | `[]` | Free-form tags. Rendered as pills on the macOS menubar. Common: `work`, `client`, `self`, `archive`. |
| `modifiedBy` | `"user"` \| `"tokmeter"` | — | Who last wrote the entry. Auto-suggest never overwrites `user` entries. |
| `modifiedAt` | ISO timestamp | — | Last write time. Restore merges use this to resolve conflicts. |

### Merge behavior

- Two or more keys sharing the same `display` → their records roll up into a
  single project row in every aggregation (CLI, menubar, API, digest).
- `hidden` on a single raw key doesn't hide the display if another raw key
  contributing to that display is visible. All raws must be hidden for the row
  to disappear.
- Tags are applied by **display name** and propagated to every raw key
  mapping to it.

---

## CLI

All subcommands operate on `~/.tokmeter/aliases.json` and write atomically
(temp file + rename), so an interrupted command never leaves the file in a
half-written state.

### List

```bash
tokmeter alias list
```

Prints a table grouped by `display`, showing which raw canonical names map to
it, whether it's hidden, its tags, and who last wrote the entry.

`--json` returns the file content verbatim.

### Rename a single canonical project

```bash
tokmeter alias set "WeatherApp/frontend" "WeatherApp"
```

### Merge variants under one display

```bash
tokmeter alias merge "Vortex" "Vortex" "vortex"
```

Accepts any number of raw-key arguments after the display. Writes an entry
per key with the same `display` and `modifiedBy: "user"`.

### Tags

Keyed by display — changes propagate to every raw key mapping to that display.

```bash
tokmeter alias tag add    "WeatherApp" work client
tokmeter alias tag remove "WeatherApp" client
tokmeter alias tag set    "Vortex" self           # overwrite
tokmeter alias tag set    "Vortex"                # clear (no args with `set`)
```

Comma-separated lists are accepted: `work,client` is equivalent to `work client`.

### Hide / unhide

```bash
tokmeter alias hide   "old-scratch"
tokmeter alias unhide "old-scratch"
```

### Remove a single entry

```bash
tokmeter alias remove "vortex"
```

The key reverts to its canonical name. Other keys in a merge group stay intact.

### Auto-suggest (interactive)

```bash
tokmeter alias suggest
```

Scans the records your current tokmeter setup sees, proposes two kinds of
merge candidates, and walks you through each with `keep` / `edit` / `reject`:

1. **Case-insensitive duplicates** — `Vortex` + `vortex` → proposes the
   most-capitalised variant as the canonical display.
2. **Path-tail collapse** — `WeatherApp/frontend` + `WeatherApp` →
   proposes the bare tail. Conservative: triggers only when at least one
   variant is already the bare tail, so unrelated repos sharing a directory
   name (e.g. `acme/api-gateway` + `bob/api-gateway`) are **not** proposed.

Keys that already have a `modifiedBy: "user"` entry are skipped — the tool
never argues with a decision you've made.

#### Keep / edit / reject flow

```
(1/1)  reason: case-insensitive
  Vortex
  vortex
  proposed → Vortex
  [K]eep / [E]dit / [R]eject >
```

- **K** — confirm the proposal. Entries are written with `modifiedBy: "user"`.
- **E** — enter a custom display name. Written as `user`.
- **R** — reject. Nothing is written; the proposal is forgotten (re-runs
  will propose again if the data still warrants it).

---

## Cross-machine restore

When you `tokmeter snapshot` on one machine and `tokmeter restore` on another,
the alias file rides along. On restore, current and restored alias maps are
merged (not overwritten) with this precedence:

1. `modifiedBy: "user"` wins over `modifiedBy: "tokmeter"`.
2. Within the same flag class, the later `modifiedAt` wins.
3. Keys only in one side are kept verbatim.

So you can safely take a snapshot from your work PC, set new aliases on your
Mac, then restore the snapshot — your Mac's user-set aliases are preserved,
and the work PC's unique aliases are added.

---

## Error handling

- **Malformed JSON** — if `aliases.json` exists but doesn't parse, tokmeter
  copies it to `aliases.json.bak-<ISO>` (so your edits aren't lost), warns to
  stderr, and proceeds with an empty map. Fix and re-save, or edit the
  `.bak-*` file directly.
- **Partial entries** — entries missing a valid `display` are silently
  skipped during load. Subsequent writes do not preserve them.
- **Empty/invalid input** — the CLI rejects empty displays, control
  characters, and display strings over 200 characters with a clear error.

---

## FAQ

**Q: What's the difference between `alias set` and `alias merge`?**

`set` rewrites a single raw-key → display mapping. `merge` bulk-assigns
several raw-keys to the same display in one call. Both produce identical
entries; `merge` is just sugar.

**Q: Can I edit `aliases.json` directly?**

Yes. It's a plain JSON file. The CLI re-reads on every invocation. If you
break the JSON while editing, tokmeter will back it up and start fresh —
your editing session won't be destroyed silently.

**Q: Does hiding a project affect the grand totals?**

No. `hidden: true` only drops the project from per-project **tables**. All
token + cost totals, streaks, and active-day counts still include hidden
projects. If you want a project's costs excluded from totals too, delete its
records with `tokmeter cleanup` instead of aliasing them away.

**Q: Will auto-suggest ever overwrite my choices?**

Never. Entries you confirm (or `alias set` / `alias merge` directly) carry
`modifiedBy: "user"`. Auto-suggest's scan explicitly filters those out before
proposing anything.

**Q: What happens when I restore a backup from before aliases existed?**

Nothing bad. Older backups don't include `aliases.json`; restore leaves your
current alias file untouched. You keep all your aliases; the older snapshot
just doesn't add any.

**Q: Can I carry tags and hide flags across machines?**

Yes — they live in the same `aliases.json`, which is included in every
snapshot. Set tags once on one machine, restore elsewhere, and they follow.

---

## Scripting

For automation, use `alias list --json` (reads file verbatim) and raw file
edits. Example: promote all `tokmeter`-flagged entries to `user` in one shot
by mutating the JSON directly — the CLI re-reads on next invocation.

```bash
# Promote every tokmeter-flagged alias to user-flagged.
jq '(.[] | select(.modifiedBy == "tokmeter")).modifiedBy = "user"' \
   ~/.tokmeter/aliases.json > ~/.tokmeter/aliases.json.tmp && \
   mv ~/.tokmeter/aliases.json.tmp ~/.tokmeter/aliases.json
```
