/**
 * tokmeter alias — Project alias management CLI.
 *
 * Subcommands:
 *   list                     Pretty table of current aliases.
 *   set <raw> <display>      Set (or overwrite) one alias.
 *   merge <display> <raw>... Group several canonical keys under one display.
 *   remove <raw>             Delete a single alias entry.
 *   tag add <display> <tag>...     Add free-form tags to all entries of a display.
 *   tag remove <display> <tag>...
 *   tag set <display> <tag>...
 *   hide <display>           Mark project hidden from per-project tables.
 *   unhide <display>
 *   suggest                  Interactive: auto-detects candidates, walks through
 *                            each with keep / edit / reject.
 *
 * All user-set entries carry `modifiedBy: "user"` which auto-suggest leaves alone.
 */

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  type AliasMap,
  TokmeterCore,
  applyTagOp,
  loadAliases,
  mergeAliases,
  removeAlias,
  saveAliases,
  setAlias,
  setHidden,
  suggestAliases,
} from "@sriinnu/tokmeter";
import chalk from "chalk";
import Table from "cli-table3";

export interface AliasArgs {
  sub: string;
  rest: string[];
  json?: boolean;
}

// ─── Entry ─────────────────────────────────────────────────────────────────

export async function runAlias(args: AliasArgs): Promise<void> {
  const map = loadAliases();

  switch (args.sub) {
    case "list":
      return cmdList(map, Boolean(args.json));
    case "set":
      return cmdSet(map, args.rest);
    case "merge":
      return cmdMerge(map, args.rest);
    case "remove":
    case "rm":
      return cmdRemove(map, args.rest);
    case "tag":
      return cmdTag(map, args.rest);
    case "hide":
      return cmdHide(map, args.rest, true);
    case "unhide":
      return cmdHide(map, args.rest, false);
    case "suggest":
      return cmdSuggest(map);
    default:
      printHelp();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function writeAndPrint(map: AliasMap, note: string): void {
  saveAliases(map);
  console.log(chalk.green(`✓ ${note}`));
}

/**
 * Reject display names that would corrupt the CLI table renderer or be
 * meaningless. Trims whitespace, disallows control characters, caps length.
 * Prints a friendly error and exits when invalid — callers assume valid.
 */
function sanitizeDisplay(input: string, label = "display"): string {
  const trimmed = input.trim();
  if (!trimmed) {
    console.log(chalk.red(`${label} name cannot be empty.`));
    process.exit(2);
  }
  // Control chars including \n \r \t break table rendering and logs. Reject.
  if (/\p{Cc}/u.test(trimmed)) {
    console.log(chalk.red(`${label} name cannot contain control characters.`));
    process.exit(2);
  }
  if (trimmed.length > 200) {
    console.log(chalk.red(`${label} name too long (max 200 chars).`));
    process.exit(2);
  }
  return trimmed;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function printHelp(): void {
  console.log(`
${chalk.bold("tokmeter alias")} — manage project display names, tags, and hidden flags.

Usage:
  tokmeter alias list
  tokmeter alias set     <raw-key> <display>
  tokmeter alias merge   <display> <raw-key1> <raw-key2> ...
  tokmeter alias remove  <raw-key>
  tokmeter alias tag     add|remove|set <display> <tag> [<tag> ...]
  tokmeter alias hide    <display>
  tokmeter alias unhide  <display>
  tokmeter alias suggest

Auto-suggest proposes case-insensitive duplicates (e.g. Vaayu vs vaayu) and
path-tail collisions. You can keep / edit / reject each proposal.
`);
}

// ─── list ──────────────────────────────────────────────────────────────────

function cmdList(map: AliasMap, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }

  const entries = Object.entries(map);
  if (entries.length === 0) {
    console.log(
      chalk.dim("\nNo aliases configured. Run `tokmeter alias suggest` to get started.\n")
    );
    return;
  }

  // Group by display so merges render as one row with multiple sources.
  const byDisplay = new Map<string, { raws: string[]; sample: AliasMap[string] }>();
  for (const [raw, entry] of entries) {
    const g = byDisplay.get(entry.display) ?? { raws: [], sample: entry };
    g.raws.push(raw);
    byDisplay.set(entry.display, g);
  }

  const table = new Table({
    head: ["Display", "Raw keys", "Hidden", "Tags", "By"],
    colWidths: [26, 40, 9, 20, 10],
    wordWrap: true,
  });
  for (const [display, { raws, sample }] of Array.from(byDisplay.entries()).sort()) {
    table.push([
      chalk.bold(display),
      raws.join("\n"),
      sample.hidden ? chalk.yellow("yes") : "no",
      (sample.tags ?? []).join(", "),
      sample.modifiedBy === "user" ? chalk.green("user") : chalk.dim("tokmeter"),
    ]);
  }
  console.log(`\n${table.toString()}\n`);
}

// ─── set ───────────────────────────────────────────────────────────────────

function cmdSet(map: AliasMap, rest: string[]): void {
  const [rawIn, displayIn, ...extra] = rest;
  if (!rawIn || displayIn === undefined) {
    console.log(chalk.red("Usage: tokmeter alias set <raw-key> <display>"));
    process.exit(2);
  }
  const raw = rawIn.trim();
  if (!raw) {
    console.log(chalk.red("raw-key cannot be empty."));
    process.exit(2);
  }
  const display = sanitizeDisplay(displayIn, "display");
  if (extra.length > 0) {
    console.log(chalk.dim("(extra arguments ignored — use `alias tag` to set tags after)"));
  }
  const next = setAlias(map, raw, { display }, "user");
  writeAndPrint(next, `"${raw}" → "${display}"`);
}

// ─── merge ─────────────────────────────────────────────────────────────────

function cmdMerge(map: AliasMap, rest: string[]): void {
  const [displayIn, ...keys] = rest;
  if (!displayIn || keys.length < 1) {
    console.log(chalk.red("Usage: tokmeter alias merge <display> <raw-key1> [<raw-key2> ...]"));
    process.exit(2);
  }
  const display = sanitizeDisplay(displayIn, "display");
  const cleanKeys = keys.map((k) => k.trim()).filter((k) => k.length > 0);
  if (cleanKeys.length === 0) {
    console.log(chalk.red("At least one non-empty raw-key required."));
    process.exit(2);
  }
  const next = mergeAliases(map, display, cleanKeys, "user");
  writeAndPrint(next, `merged ${cleanKeys.length} key(s) → "${display}"`);
}

// ─── remove ────────────────────────────────────────────────────────────────

function cmdRemove(map: AliasMap, rest: string[]): void {
  const [raw] = rest;
  if (!raw) {
    console.log(chalk.red("Usage: tokmeter alias remove <raw-key>"));
    process.exit(2);
  }
  if (!(raw in map)) {
    console.log(chalk.yellow(`No alias for "${raw}"`));
    return;
  }
  const next = removeAlias(map, raw);
  writeAndPrint(next, `removed "${raw}"`);
}

// ─── tag ───────────────────────────────────────────────────────────────────

function cmdTag(map: AliasMap, rest: string[]): void {
  const [op, displayIn, ...tags] = rest;
  if (!op || !displayIn) {
    console.log(chalk.red("Usage: tokmeter alias tag add|remove|set <display> <tag>..."));
    process.exit(2);
  }
  if (op !== "add" && op !== "remove" && op !== "set") {
    console.log(chalk.red("op must be one of: add | remove | set"));
    process.exit(2);
  }
  // add/remove require at least one tag; `set` with no tags == clear (intentional).
  if ((op === "add" || op === "remove") && tags.length === 0) {
    console.log(chalk.red(`Usage: tokmeter alias tag ${op} <display> <tag>...`));
    process.exit(2);
  }
  const display = sanitizeDisplay(displayIn, "display");
  // Split comma-separated tag lists too: `work,client` == `work client`.
  const expanded = tags.flatMap((t) =>
    t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const next = applyTagOp(map, display, op, expanded);
  writeAndPrint(next, `tag ${op} "${display}" → ${expanded.join(", ") || "(cleared)"}`);
}

// ─── hide / unhide ─────────────────────────────────────────────────────────

function cmdHide(map: AliasMap, rest: string[], hidden: boolean): void {
  const [displayIn] = rest;
  if (!displayIn) {
    console.log(chalk.red(`Usage: tokmeter alias ${hidden ? "hide" : "unhide"} <display>`));
    process.exit(2);
  }
  const display = sanitizeDisplay(displayIn, "display");
  const next = setHidden(map, display, hidden);
  writeAndPrint(next, `${hidden ? "hid" : "un-hid"} "${display}"`);
}

// ─── suggest ───────────────────────────────────────────────────────────────

/**
 * Interactive walk-through of every unaliased project.
 *
 * Phase 1 — auto-detected merge groups: case-insensitive dupes and path-tail
 * collapses. For each group: K (keep the merge), E (edit display), R (reject
 * the merge — leave each key on its own).
 *
 * Phase 2 — every remaining solo project, one by one. For each: K (keep as-is,
 * no alias written), E (rename to a custom display), H (hide from tables), S
 * (skip — same as K but explicit).
 *
 * User can Ctrl-C at any point; everything confirmed so far is saved on a
 * normal exit at the end. (A future improvement would save mid-loop; for now
 * interrupts lose the session's edits.)
 */
async function cmdSuggest(initialMap: AliasMap): Promise<void> {
  console.log(chalk.dim("\nScanning current project names...\n"));
  const core = new TokmeterCore({ skipPricing: true });
  await core.scan();
  const rawNames = core.getRawProjectNames();
  const records = core.getRecords();
  const suggestions = suggestAliases(rawNames, initialMap);

  // ─ Build per-project metadata so each prompt can show context ─────────
  // Sample sourceFile (first seen), date range, record count, providers.
  // Helps identify "which `personal` is this?" when reviewing 40+ projects.
  type RawMeta = {
    cwd: string;
    sample: string;
    first: number;
    last: number;
    count: number;
    providers: Set<string>;
  };
  const metaByRaw = new Map<string, RawMeta>();
  for (const r of records) {
    let m = metaByRaw.get(r.project);
    if (!m) {
      m = {
        cwd: r.cwd ?? "",
        sample: r.sourceFile ?? "",
        first: r.timestamp,
        last: r.timestamp,
        count: 0,
        providers: new Set(),
      };
      metaByRaw.set(r.project, m);
    }
    // Prefer the first non-empty cwd we find. Rare drift (someone ran the same
    // project from two paths) still surfaces one of the real paths.
    if (!m.cwd && r.cwd) m.cwd = r.cwd;
    m.count++;
    if (r.timestamp < m.first) m.first = r.timestamp;
    if (r.timestamp > m.last) m.last = r.timestamp;
    m.providers.add(r.provider);
  }

  // Backfill cwd for records loaded from a pre-cwd history snapshot. Cheap:
  // claude-code is pure string math on the slug; codex reads the first 64 KB
  // of one source file per project (session_meta is always near the top).
  // Skipped for projects that already have cwd from the live parse.
  await Promise.all(
    Array.from(metaByRaw.entries()).map(async ([raw, m]) => {
      if (m.cwd || !m.sample) return;
      const cc = decodeClaudeSlugFromPath(m.sample);
      if (cc) {
        m.cwd = cc;
        return;
      }
      if (m.sample.includes("/.codex/sessions/")) {
        const fromMeta = await readCodexCwd(m.sample);
        if (fromMeta) m.cwd = fromMeta;
      }
      // other providers: leave empty, pathHint falls back to sourceFile dirname.
      void raw;
    })
  );

  // Show the actual project cwd when parsers captured it (codex session_meta,
  // claude-code slug-decoded). Fall back to the session log's parent dir only
  // when cwd is absent — that path is still better than nothing.
  const HOME = homedir();
  const prettify = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
  const pathHint = (raw: string): string => {
    const m = metaByRaw.get(raw);
    if (m?.cwd) return chalk.dim(prettify(m.cwd));
    if (m?.sample) return chalk.dim(prettify(dirname(m.sample)));
    return chalk.dim("(no path)");
  };
  // Short YYYY-MM-DD date.
  const d = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const metaLine = (raw: string): string => {
    const m = metaByRaw.get(raw);
    if (!m) return "";
    const span = m.first === m.last ? d(m.first) : `${d(m.first)} → ${d(m.last)}`;
    const provs = Array.from(m.providers).join(", ");
    return chalk.dim(`${m.count} records · ${span} · ${provs}`);
  };

  // ─ Solo = projects not in a merge group and not user-aliased ──────────
  const groupedKeys = new Set(suggestions.flatMap((s) => s.keys));
  const solo = rawNames
    .filter((r) => !groupedKeys.has(r))
    .filter((r) => initialMap[r]?.modifiedBy !== "user")
    .sort();

  const total = suggestions.length + solo.length;
  if (total === 0) {
    console.log(chalk.green("✓ All projects already aliased or nothing to review.\n"));
    return;
  }

  console.log(
    `Walking ${chalk.bold(String(total))} item(s): ${chalk.cyan(String(suggestions.length))} auto-detected merge group(s) + ${chalk.cyan(String(solo.length))} solo project(s).\n`
  );
  console.log(chalk.dim("Merge: [K]eep to confirm merge, [E]dit display, [R]eject merge."));
  console.log(chalk.dim("Solo:  [K]eep as-is, [E]dit display, [H]ide, [S]kip (= keep)."));
  console.log(
    chalk.dim(
      "Each decision is saved to disk immediately — Ctrl-C preserves what you've done so far.\n"
    )
  );

  // Track counts for the final tally. workingMap is used for the in-memory
  // view; every change is also persisted immediately via persist().
  let workingMap = initialMap;
  let kept = 0;
  let edited = 0;
  let hidden = 0;
  let skipped = 0;
  let idx = 0;

  // Atomic save that merges current in-memory workingMap with whatever is
  // on disk now — so mid-run edits by a concurrent process are preserved.
  // Called after every decision so Ctrl-C leaves the file consistent.
  const persist = () => {
    const fresh = loadAliases();
    const merged: AliasMap = { ...fresh };
    for (const [k, v] of Object.entries(workingMap)) {
      merged[k] = v;
    }
    saveAliases(merged);
  };

  // ─ Phase 1: merge groups ──────────────────────────────────────────────
  for (const s of suggestions) {
    idx++;
    console.log(chalk.bold(`(${idx}/${total})`) + chalk.dim(`  merge · ${s.reason}`));
    for (const k of s.keys) {
      const existing = initialMap[k];
      const lockTag = existing?.modifiedBy === "user" ? chalk.green(" [locked]") : "";
      console.log(`  ${chalk.cyan(k)}${lockTag}`);
      console.log(`    ${pathHint(k)}`);
      console.log(`    ${metaLine(k)}`);
    }
    console.log(`  ${chalk.dim("proposed →")} ${chalk.bold(s.proposed)}`);

    const answer = (await ask("  [K]eep / [E]dit / [R]eject > ")).toLowerCase();

    if (answer === "r" || answer === "reject") {
      skipped++;
      console.log(chalk.dim("  rejected.\n"));
      continue;
    }

    let display = s.proposed;
    if (answer === "e" || answer === "edit") {
      const custom = await ask(`  custom display (default "${s.proposed}"): `);
      if (custom.trim()) display = custom.trim();
      edited++;
    } else {
      kept++;
    }
    workingMap = mergeAliases(workingMap, display, s.keys, "user");
    persist();
    console.log(chalk.green(`  ✓ saved "${display}"\n`));
  }

  // ─ Phase 2: solo projects ─────────────────────────────────────────────
  for (const raw of solo) {
    idx++;
    console.log(chalk.bold(`(${idx}/${total})`) + chalk.dim("  solo"));
    console.log(`  ${chalk.cyan(raw)}`);
    console.log(`    ${pathHint(raw)}`);
    console.log(`    ${metaLine(raw)}`);
    console.log(`  ${chalk.dim("current display →")} ${chalk.bold(raw)}`);

    const answer = (await ask("  [K]eep / [E]dit / [H]ide / [S]kip > ")).toLowerCase();

    if (answer === "e" || answer === "edit") {
      const custom = await ask("  new display: ");
      if (custom.trim()) {
        workingMap = setAlias(workingMap, raw, { display: custom.trim() }, "user");
        edited++;
        persist();
        console.log(chalk.green(`  ✓ renamed to "${custom.trim()}"\n`));
      } else {
        skipped++;
        console.log(chalk.dim("  empty — skipped.\n"));
      }
    } else if (answer === "h" || answer === "hide") {
      workingMap = setAlias(workingMap, raw, { display: raw, hidden: true }, "user");
      hidden++;
      persist();
      console.log(chalk.green("  ✓ hidden\n"));
    } else {
      // K / S / Enter / anything else = keep as-is. Nothing to persist.
      skipped++;
    }
  }

  console.log(
    `Done. ${chalk.green(`${kept} merged`)}, ${chalk.yellow(`${edited} edited`)}, ${chalk.magenta(`${hidden} hidden`)}, ${chalk.dim(`${skipped} skipped`)}.`
  );
  console.log("File: ~/.tokmeter/aliases.json");
}

// ─── cwd derivation fallbacks ─────────────────────────────────────────────

/**
 * Claude Code stores sessions under `~/.claude/projects/<slug>/` where `<slug>`
 * is the cwd with `/` replaced by `-`. We reverse the encoding on a best-effort
 * basis — literal dashes in real dir names get folded into slashes, but for
 * identification-hint purposes the result is still usable.
 */
function decodeClaudeSlugFromPath(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  const idx = parts.indexOf("projects");
  const slug = idx >= 0 ? parts[idx + 1] : undefined;
  if (!slug || !slug.startsWith("-")) return undefined;
  // Only treat this as a claude-code slug if the path has `.claude/projects` —
  // avoids misfiring on unrelated "projects" dirs.
  if (!filePath.includes("/.claude/projects/")) return undefined;
  return `/${slug.slice(1).replace(/-/g, "/")}`;
}

/**
 * Read `session_meta.cwd` from a codex rollout. `session_meta` is always one of
 * the first events emitted, so we cap the read at 64 KB — cheap even on the
 * 86 MB rollouts codex has been known to produce.
 */
async function readCodexCwd(file: string): Promise<string | undefined> {
  try {
    const st = await stat(file);
    const fd = await open(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(65_536, st.size));
      await fd.read(buf, 0, buf.length, 0);
      const text = buf.toString("utf-8");
      for (const line of text.split("\n").slice(0, 20)) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            payload?: { cwd?: string };
          };
          if (evt.type === "session_meta" && evt.payload?.cwd) return evt.payload.cwd;
        } catch {
          // partial line — ignore
        }
      }
    } finally {
      await fd.close();
    }
  } catch {
    // file gone / unreadable — no hint
  }
  return undefined;
}
