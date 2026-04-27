/**
 * @sriinnu/tokmeter-core — Project alias service.
 *
 * Lets users collapse two or more canonical project names into a single
 * display label (e.g. "Vaayu" + "vaayu" from different machines → "Vaayu"),
 * hide projects from aggregations, and tag them for grouping.
 *
 * File location: ~/.tokmeter/aliases.json
 *
 * Shape:
 *
 *   {
 *     "Vaayu": {
 *       "display": "Vaayu",
 *       "hidden": false,
 *       "tags": ["self"],
 *       "modifiedBy": "user",
 *       "modifiedAt": "2026-04-24T13:22:00Z"
 *     },
 *     "vaayu": {
 *       "display": "Vaayu",  // same display → merges with above in aggregations
 *       "modifiedBy": "tokmeter",
 *       "modifiedAt": "2026-04-24T13:22:00Z"
 *     }
 *   }
 *
 * Keys are the CANONICAL project name emitted by canonicalizeProjectName()
 * (what TokenRecord.project already carries). No raw slug gymnastics needed
 * at the alias layer — that's done by the parsers.
 *
 * modifiedBy semantics:
 *   - "user"      — set explicitly by the user; never touched by auto-suggest
 *   - "tokmeter"  — produced by `alias suggest` auto-detection; can be
 *                   re-generated / overwritten on subsequent suggest runs
 *                   (until the user confirms, which flips it to "user")
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

/** A single alias entry keyed by canonical project name. */
export interface AliasEntry {
  /** Display label shown everywhere in the UI. */
  display: string;
  /** Remove the project from per-project aggregations (totals still include it). */
  hidden?: boolean;
  /** Free-form tags (e.g. "work", "client", "self"). */
  tags?: string[];
  /** Who last changed this entry. User-flagged never touched by auto-suggest. */
  modifiedBy: "user" | "tokmeter";
  /** ISO timestamp of last write. */
  modifiedAt: string;
}

/** Alias map keyed by canonical project name. */
export type AliasMap = Record<string, AliasEntry>;

/** Result of a single auto-suggest finding. */
export interface AliasSuggestion {
  /** Raw canonical project names that should merge. */
  keys: string[];
  /** Proposed display label for the merged group. */
  proposed: string;
  /** Why this group was flagged (case-insensitive match, substring, etc). */
  reason: "case-insensitive" | "path-tail";
}

// ─── Paths ─────────────────────────────────────────────────────────────────

/**
 * Default alias file path. Splits out the tokmeter config dir so it survives
 * `bun run clean` / cache wipes — the cache is for derived data; aliases are
 * user state.
 */
export function aliasFilePath(home: string = homedir()): string {
  return join(home, ".tokmeter", "aliases.json");
}

// ─── Load / Save ───────────────────────────────────────────────────────────

/**
 * Load aliases from disk. Returns empty map if missing.
 *
 * If the file exists but is malformed (JSON parse fails or the root isn't an
 * object), we move it aside to `aliases.json.bak-<ISO>` and log to stderr, so
 * the user's work isn't silently overwritten by the next save. Entries that
 * parse but lack a valid `display` are skipped individually (partial tolerance).
 */
export function loadAliases(home: string = homedir()): AliasMap {
  const path = aliasFilePath(home);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupBrokenAliasFile(path, `JSON parse error: ${(err as Error).message}`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    backupBrokenAliasFile(path, "root is not an object");
    return {};
  }
  const clean: AliasMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const e = v as Partial<AliasEntry>;
    if (typeof e?.display === "string" && e.display.length > 0) {
      clean[k] = {
        display: e.display,
        hidden: Boolean(e.hidden),
        tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
        modifiedBy: e.modifiedBy === "user" ? "user" : "tokmeter",
        modifiedAt: typeof e.modifiedAt === "string" ? e.modifiedAt : new Date().toISOString(),
      };
    }
  }
  return clean;
}

/**
 * Persist the map atomically via write-to-tmp + rename. POSIX rename is
 * atomic on the same filesystem so readers either see the old file or the
 * new one — never a half-written mix. Protects against power loss and
 * concurrent CLI invocations.
 */
export function saveAliases(map: AliasMap, home: string = homedir()): void {
  const path = aliasFilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, path);
}

/** Move a broken aliases.json out of the way; write a sibling .bak with a timestamp. */
function backupBrokenAliasFile(path: string, reason: string): void {
  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(path, backupPath);
    console.error(
      `⚠  tokmeter: ~/.tokmeter/aliases.json is malformed (${reason}). Saved a copy at ${backupPath} and continuing with an empty alias set.`
    );
  } catch {
    // If we can't even copy the broken file, continue — at least don't crash.
  }
}

// ─── Resolve ───────────────────────────────────────────────────────────────

/**
 * Resolve a canonical project name through the alias map. Returns the alias
 * display if present, else the original name. Hidden entries still resolve
 * to their display — hiding is applied separately at aggregation time.
 */
export function resolveProjectName(project: string, map: AliasMap): string {
  return map[project]?.display ?? project;
}

/** Is this project hidden by alias? */
export function isProjectHidden(project: string, map: AliasMap): boolean {
  return Boolean(map[project]?.hidden);
}

// ─── Mutations (pure; caller saves) ────────────────────────────────────────

/** Set (or overwrite) a single alias keyed on canonical project name. */
export function setAlias(
  map: AliasMap,
  key: string,
  patch: Partial<Omit<AliasEntry, "modifiedAt" | "modifiedBy">> & {
    display: string;
  },
  flag: "user" | "tokmeter" = "user"
): AliasMap {
  // Don't clobber user-flagged with tokmeter-flagged — that's the whole rule.
  const existing = map[key];
  if (existing?.modifiedBy === "user" && flag === "tokmeter") return map;
  return {
    ...map,
    [key]: {
      display: patch.display,
      hidden: patch.hidden ?? existing?.hidden ?? false,
      tags: patch.tags ?? existing?.tags ?? [],
      modifiedBy: flag,
      modifiedAt: new Date().toISOString(),
    },
  };
}

/** Merge multiple canonical projects into one display, writing entries for each. */
export function mergeAliases(
  map: AliasMap,
  display: string,
  keys: string[],
  flag: "user" | "tokmeter" = "user"
): AliasMap {
  let next = map;
  for (const k of keys) {
    next = setAlias(next, k, { display }, flag);
  }
  return next;
}

/** Remove an alias. The project reverts to its canonical name. */
export function removeAlias(map: AliasMap, key: string): AliasMap {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Apply a tag op (add | remove | set) across all entries sharing a display. */
export function applyTagOp(
  map: AliasMap,
  display: string,
  op: "add" | "remove" | "set",
  tags: string[]
): AliasMap {
  const now = new Date().toISOString();
  const normalizedTags = tags.map((t) => t.trim()).filter(Boolean);
  const next: AliasMap = { ...map };
  for (const [k, v] of Object.entries(map)) {
    if (v.display !== display) continue;
    let newTags = v.tags ?? [];
    switch (op) {
      case "add":
        newTags = Array.from(new Set([...newTags, ...normalizedTags]));
        break;
      case "remove": {
        const drop = new Set(normalizedTags);
        newTags = newTags.filter((t) => !drop.has(t));
        break;
      }
      case "set":
        newTags = normalizedTags;
        break;
    }
    next[k] = { ...v, tags: newTags, modifiedAt: now };
  }
  return next;
}

/** Flip hidden flag across all entries sharing a display. */
export function setHidden(map: AliasMap, display: string, hidden: boolean): AliasMap {
  const now = new Date().toISOString();
  const next: AliasMap = { ...map };
  for (const [k, v] of Object.entries(map)) {
    if (v.display !== display) continue;
    next[k] = { ...v, hidden, modifiedAt: now };
  }
  return next;
}

// ─── Auto-suggest ──────────────────────────────────────────────────────────

/**
 * Scan a set of canonical project names and propose merges based on simple
 * heuristics. The caller runs this on `TokenRecord[].map(r => r.project)` and
 * lets the user confirm each suggestion interactively.
 *
 * Heuristics (v1):
 *   1. Case-insensitive match — "Vaayu" vs "vaayu" → merge as "Vaayu" (the
 *      variant that appears more often, or the properly cased one).
 *   2. Path-tail collapse — two names that share the same final segment
 *      (e.g. "Linsinger/CustomerCockpit" vs "CustomerCockpit") merge to the
 *      shared tail. (Conservative: only triggers when the shared tail is
 *      ≥ 4 chars to avoid false positives on short generic names.)
 *
 * Entries already set by the user are skipped — we never propose over a
 * user-locked alias.
 */
export function suggestAliases(projectNames: string[], existing: AliasMap): AliasSuggestion[] {
  const unique = Array.from(new Set(projectNames)).filter((p) => !isUserLocked(p, existing));
  const suggestions: AliasSuggestion[] = [];
  const consumed = new Set<string>();

  // ─ Heuristic 1: case-insensitive grouping ─────────────────────────────
  const byLower = new Map<string, string[]>();
  for (const name of unique) {
    const k = name.toLowerCase();
    const list = byLower.get(k) ?? [];
    list.push(name);
    byLower.set(k, list);
  }
  for (const [, variants] of byLower) {
    if (variants.length < 2) continue;
    // Prefer the most-capitalized variant (most uppercase letters); ties go to shortest.
    const proposed = variants.slice().sort((a, b) => {
      const upA = (a.match(/[A-Z]/g) || []).length;
      const upB = (b.match(/[A-Z]/g) || []).length;
      if (upA !== upB) return upB - upA;
      return a.length - b.length;
    })[0];
    suggestions.push({
      keys: variants,
      proposed: proposed ?? variants[0] ?? "",
      reason: "case-insensitive",
    });
    for (const v of variants) consumed.add(v);
  }

  // ─ Heuristic 2: path-tail collapse — conservative version ─────────────
  // Only propose merging "X/Y" with "Y" (where one variant IS the bare tail).
  // This covers the common "rename `CustomerCockpit/frontend` → `CustomerCockpit`"
  // case without false-positive merging of unrelated repos that happen to
  // share a directory name (e.g. `acme/api-gateway` + `bob/api-gateway`).
  const remaining = unique.filter((n) => !consumed.has(n));
  const byTail = new Map<string, string[]>();
  for (const name of remaining) {
    const tail = name.split("/").at(-1) ?? name;
    if (tail.length < 4) continue; // avoid "api", "ui" false positives
    const list = byTail.get(tail.toLowerCase()) ?? [];
    list.push(name);
    byTail.set(tail.toLowerCase(), list);
  }
  for (const [tailLower, variants] of byTail) {
    if (variants.length < 2) continue;
    // Require at least one variant to be the bare tail (no "/"). That signals
    // intentional rename rather than unrelated parents sharing a child dir.
    const bareVariants = variants.filter((v) => !v.includes("/"));
    if (bareVariants.length === 0) continue;
    // Proposed = a bare variant whose casing matches the tail; fall back to
    // any bare variant.
    const proposed =
      bareVariants.find((v) => v.toLowerCase() === tailLower) ?? bareVariants[0] ?? "";
    suggestions.push({
      keys: variants,
      proposed,
      reason: "path-tail",
    });
  }

  return suggestions;
}

function isUserLocked(key: string, map: AliasMap): boolean {
  return map[key]?.modifiedBy === "user";
}
