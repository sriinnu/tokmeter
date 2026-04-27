---
name: fix-errors
description: "Fix TypeScript build errors and Biome lint errors in the tokmeter monorepo. Use when: build fails, tsc errors, type errors, lint errors, biome errors, unused imports, unused variables, format errors, CI failing, errors after refactor."
argument-hint: "Optionally specify a package (e.g. core, cli, mcp) or leave blank for the full monorepo"
---

# Fix Build and Lint Errors

**You are an agent executing this skill. Read, act, and iterate — do not just summarise or list steps.**

## Execution Loop

Run these commands now. Do not stop until both exit with code 0.

### Step 1 — Collect all errors

```bash
bun run lint 2>&1
```

Also call `get_errors` (VS Code diagnostics tool) to see inline TypeScript errors.

### Step 2 — Auto-fix everything Biome can fix

```bash
bun run fix
```

(`fix` runs `biome check --write . && biome format --write .`)

Re-run `bun run lint` and `get_errors`. If clean → done. Otherwise continue.

### Step 3 — Fix remaining errors manually

For each remaining error, edit the file directly using the rules below, then re-run lint to confirm.

**Do not add `biome-ignore` suppressions unless the rule genuinely cannot be fixed in code.** Fix first, suppress only as a last resort with an explanation comment.

#### Type errors (`tsc` / `get_errors`)
- Wrong types → fix the type annotation or the value
- Missing property → add it or use optional chaining
- Unresolved import → fix the import path; check `packages/*/src/index.ts` for exports

#### Unused imports (`noUnusedImports`)
- Remove the import if it is genuinely unused
- Change to `import type` if only used as a type

#### Unused variables (`noUnusedVariables`)
- Remove the variable, or rename to `_varName` if intentionally unused

#### Formatting (`format`)
- Never reformat manually — run `bun run format`
- If `biome.json` itself fails to parse: ensure `files.include` uses only positive globs (no `!` negation — use `files.ignore` for exclusions)

#### Control characters in regex (`noControlCharactersInRegex`)
- Replace hex escapes like `[\x00-\x1f]` with Unicode property `\p{Cc}` and add `u` flag

#### Button without explicit type (`useButtonType`)
- Add `type="button"` (or `"submit"` / `"reset"`) to every `<button>` element

#### `delete` operator (`noDelete`)
- Replace `delete obj.key` with destructuring: `const { key: _key, ...rest } = obj; obj = rest`

#### Stale `biome-ignore` suppressions (`suppressions/unused`)
- The suppressed rule is no longer enabled — just remove the comment

#### `noConsole` in user-facing paths
- These are legitimately intentional; use `biome-ignore lint/suspicious/noConsole: user-facing output`

### Step 4 — Verify both pass

```bash
bun run build
bun run lint
```

Both must exit 0. If anything fails, go back to Step 3.

## Monorepo Notes

- Build order: `core → mcp → cli → tui → tokmeter → web`
- Cross-package type errors surface in the *consuming* package, not the source
- `dist/` is excluded from lint via `biome.json` `files.ignore`
- Globally disabled rules (never an error here): `noExplicitAny`, `noNonNullAssertion`
