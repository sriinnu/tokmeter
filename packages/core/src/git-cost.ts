/**
 * @sriinnu/tokmeter-core — Git branch / PR forensic cost attribution.
 *
 * Correlates a local git branch's commit window and repository root with
 * Tokmeter's local session records so developers can attach honest AI cost &
 * efficiency receipts to pull requests across macOS, Linux, and Windows.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type AliasMap, resolveProjectName } from "./alias-service.js";
import { startOfLocalDay } from "./date-utils.js";
import { sanitizeDataLabel } from "./display-safety.js";
import { canonicalizeProjectName, projectMatchKey } from "./project-name.js";
import type { TokenRecord } from "./types.js";

const SAFE_GIT_REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/~^-]+$/;

export interface GitBranchWindow {
  repoRoot: string;
  repoName: string;
  branch: string;
  headSha: string;
  baseRef: string;
  mergeBase: string;
  commitCount: number;
  commits: Array<{ sha: string; timestampMs: number }>;
  windowStartMs: number;
  windowEndMs: number;
  leadMinutes: number;
  windowBasis: "since-commit" | "branch-commits" | "uncommitted-work";
  caveats: string[];
}

export interface InspectGitBranchOptions {
  base?: string;
  sinceCommit?: string;
  leadMinutes?: number;
  now?: number;
}

export interface AttributeGitBranchOptions {
  aliases?: AliasMap;
  earliestRawRecordMs?: number | null;
}

export interface GitBranchCostReport {
  window: GitBranchWindow;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  matchedRecords: number;
  directCwdMatches: number;
  projectFallbackMatches: number;
  unpricedRecords: number;
  cacheHitRate: number | null;
  subagentCost: number;
  subagentShare: number | null;
  compactionCost: number;
  compactionEvents: number;
  providers: Array<{ provider: string; cost: number; tokens: number; sharePct: number }>;
  models: Array<{
    model: string;
    provider: string;
    cost: number;
    tokens: number;
    sharePct: number;
  }>;
  caveats: string[];
}

function validateGitRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed || !SAFE_GIT_REF_RE.test(trimmed)) {
    throw new Error(`Invalid git ${label}: "${ref}"`);
  }
  return trimmed;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function detectBaseRef(cwd: string, branch: string, explicitBase?: string): string {
  if (explicitBase) {
    const clean = validateGitRef(explicitBase, "base ref");
    if (!gitRefExists(cwd, clean)) {
      throw new Error(`Base git ref not found: ${clean}`);
    }
    return clean;
  }

  try {
    const originHead = runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const stripped = originHead.replace(/^refs\/remotes\//, "");
    if (stripped && stripped !== `origin/${branch}` && gitRefExists(cwd, stripped)) {
      return stripped;
    }
  } catch {
    /* origin/HEAD not configured */
  }

  for (const candidate of ["main", "master", "origin/main", "origin/master"]) {
    if (candidate === branch) continue;
    if (gitRefExists(cwd, candidate)) return candidate;
  }

  if (gitRefExists(cwd, "HEAD~1")) return "HEAD~1";
  return "HEAD";
}

function parseCommitTimestampMs(cwd: string, ref: string): number | null {
  try {
    const out = runGit(cwd, ["show", "-s", "--format=%ct", ref]);
    const sec = Number.parseInt(out, 10);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Inspect the git branch state at `cwd` and derive an honest `[windowStartMs, windowEndMs]`
 * attribution window from its branch divergence and commits.
 */
export function inspectGitBranch(
  cwd: string = process.cwd(),
  opts: InspectGitBranchOptions = {}
): GitBranchWindow {
  const now = opts.now ?? Date.now();
  const leadRaw = opts.leadMinutes ?? 30;
  const leadMinutes = Math.max(0, Math.min(240, Math.round(leadRaw)));

  const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const headSha = runGit(cwd, ["rev-parse", "--short=8", "HEAD"]);
  const baseRef = opts.sinceCommit
    ? validateGitRef(opts.sinceCommit, "sinceCommit")
    : detectBaseRef(repoRoot, branch, opts.base);

  if (opts.sinceCommit && !gitRefExists(repoRoot, baseRef)) {
    throw new Error(`Git commit ref not found: ${baseRef}`);
  }

  const mergeBase = opts.sinceCommit
    ? runGit(repoRoot, ["rev-parse", baseRef])
    : runGit(repoRoot, ["merge-base", "HEAD", baseRef]);

  const rawLog = runGit(repoRoot, ["log", "--format=%H%x09%ct", `${mergeBase}..HEAD`]);
  const commits: Array<{ sha: string; timestampMs: number }> = [];
  if (rawLog) {
    for (const line of rawLog.split(/\r?\n/)) {
      const [sha, ct] = line.split("\t");
      const sec = Number.parseInt(ct ?? "", 10);
      if (sha && Number.isFinite(sec) && sec > 0) {
        commits.push({ sha, timestampMs: sec * 1000 });
      }
    }
  }

  const caveats: string[] = [];
  let windowStartMs: number;
  let windowEndMs = now;
  let windowBasis: GitBranchWindow["windowBasis"];

  if (commits.length > 0) {
    const earliestCommitMs = Math.min(...commits.map((c) => c.timestampMs));
    const latestCommitMs = Math.max(...commits.map((c) => c.timestampMs));
    windowStartMs = earliestCommitMs - leadMinutes * 60_000;
    windowEndMs = Math.max(now, latestCommitMs);
    windowBasis = opts.sinceCommit ? "since-commit" : "branch-commits";
    caveats.push(
      `Window spans earliest branch commit minus ${leadMinutes}m lead time through ${new Date(windowEndMs).toISOString().slice(0, 16)} UTC.`
    );
  } else {
    const baseCommitMs = parseCommitTimestampMs(repoRoot, mergeBase);
    const todayFloor = startOfLocalDay(now);
    windowStartMs = baseCommitMs ? Math.max(baseCommitMs, todayFloor) : todayFloor;
    windowBasis = "uncommitted-work";
    caveats.push(
      `No commits ahead of ${baseRef}; attributing repo usage from ${new Date(windowStartMs).toISOString().slice(0, 16)} UTC through now.`
    );
  }

  return {
    repoRoot,
    repoName: canonicalizeProjectName(repoRoot, "") || "repo",
    branch: sanitizeDataLabel(branch, 120) || "HEAD",
    headSha,
    baseRef: sanitizeDataLabel(baseRef, 120) || "HEAD",
    mergeBase: mergeBase.slice(0, 12),
    commitCount: commits.length,
    commits,
    windowStartMs,
    windowEndMs,
    leadMinutes,
    windowBasis,
    caveats,
  };
}

function stripWindowsLongPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${p.slice(8)}`;
  }
  if (p.startsWith("\\\\?\\") || p.startsWith("//?/")) {
    return p.slice(4);
  }
  return p;
}

function safeRealpath(p: string): string | null {
  try {
    const resolved = realpathSync.native ? realpathSync.native(p) : realpathSync(p);
    return stripWindowsLongPrefix(resolved);
  } catch {
    return null;
  }
}

function resolveExistingAncestorRealpath(candidate: string): string | null {
  let cur = resolve(candidate);
  const trailing: string[] = [];

  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) {
      return null;
    }
    trailing.push(basename(cur));
    cur = parent;
  }

  const realAncestor = safeRealpath(cur);
  if (!realAncestor) {
    return null;
  }
  return trailing.length > 0 ? join(realAncestor, ...trailing.reverse()) : realAncestor;
}

function normalizeForMatch(p: string): string {
  const normalized = stripWindowsLongPrefix(resolve(p)).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function expandRootVariants(repoRoot: string): string[] {
  const variants = new Set<string>([normalizeForMatch(repoRoot)]);
  const real = safeRealpath(repoRoot);
  if (real) {
    variants.add(normalizeForMatch(real));
  }
  return [...variants];
}

function isPathInsideRoot(candidateCwd: string, rootVariants: string[]): boolean {
  const norm = normalizeForMatch(candidateCwd);
  for (const root of rootVariants) {
    if (norm === root || norm.startsWith(`${root}/`)) return true;
  }
  const real = resolveExistingAncestorRealpath(candidateCwd);
  if (real) {
    const resolvedNorm = normalizeForMatch(real);
    for (const root of rootVariants) {
      if (resolvedNorm === root || resolvedNorm.startsWith(`${root}/`)) return true;
    }
  }
  return false;
}

/**
 * Attribute local session {@link TokenRecord} entries to a git branch window by matching
 * the record timestamp (`[windowStartMs, windowEndMs]`) and repository root (with a
 * canonicalized project-name fallback when a provider record omits `cwd`).
 */
export function attributeGitBranchCost(
  records: TokenRecord[],
  window: GitBranchWindow,
  opts: AttributeGitBranchOptions = {}
): GitBranchCostReport {
  const roots = expandRootVariants(window.repoRoot);
  const targetKey = projectMatchKey(canonicalizeProjectName(window.repoRoot, ""));
  const aliases = opts.aliases ?? {};

  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let matchedRecords = 0;
  let directCwdMatches = 0;
  let projectFallbackMatches = 0;
  let unpricedRecords = 0;
  let subagentCost = 0;
  let compactionCost = 0;
  let compactionEvents = 0;

  const byProvider = new Map<string, { cost: number; tokens: number }>();
  const byModel = new Map<
    string,
    { model: string; provider: string; cost: number; tokens: number }
  >();

  for (const r of records) {
    if (r.timestamp < window.windowStartMs || r.timestamp > window.windowEndMs) continue;

    let matchedByCwd = false;
    let matchedByProject = false;
    if (r.cwd) {
      matchedByCwd = isPathInsideRoot(r.cwd, roots);
    } else {
      const resolved = resolveProjectName(r.project, aliases);
      const recordKey = projectMatchKey(canonicalizeProjectName(resolved, r.provider));
      matchedByProject = targetKey.length > 0 && recordKey === targetKey;
    }
    if (!matchedByCwd && !matchedByProject) continue;

    matchedRecords++;
    if (matchedByCwd) directCwdMatches++;
    else projectFallbackMatches++;

    totalCost += r.cost;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheWriteTokens += r.cacheWriteTokens;
    reasoningTokens += r.reasoningTokens;

    if (r.isSubagent) subagentCost += r.cost;
    if (r.kind === "compaction") {
      compactionCost += r.cost;
      compactionEvents++;
    }
    if (r.cost === 0 && r.inputTokens + r.outputTokens > 0 && r.usage?.cost !== "calculated") {
      unpricedRecords++;
    }

    const tok =
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
    const pvKey = sanitizeDataLabel(r.provider, 48) || "unknown";
    const pv = byProvider.get(pvKey) ?? { cost: 0, tokens: 0 };
    pv.cost += r.cost;
    pv.tokens += tok;
    byProvider.set(pvKey, pv);

    const modelName = sanitizeDataLabel(r.model, 64) || "unknown";
    const mKey = `${pvKey}\0${modelName}`;
    const mv = byModel.get(mKey) ?? { model: modelName, provider: pvKey, cost: 0, tokens: 0 };
    mv.cost += r.cost;
    mv.tokens += tok;
    byModel.set(mKey, mv);
  }

  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
  const totalCanonicalInput = inputTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitRate = totalCanonicalInput > 0 ? cacheReadTokens / totalCanonicalInput : null;
  const subagentShare = totalCost > 0 ? subagentCost / totalCost : null;

  const providers = [...byProvider.entries()]
    .map(([provider, v]) => ({
      provider,
      cost: v.cost,
      tokens: v.tokens,
      sharePct: totalCost > 0 ? (v.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const models = [...byModel.values()]
    .map((m) => ({
      ...m,
      sharePct: totalCost > 0 ? (m.cost / totalCost) * 100 : 0,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const caveats = [...window.caveats];
  if (projectFallbackMatches > 0) {
    caveats.push(
      `${projectFallbackMatches} record(s) lacked cwd and were matched by canonical project name.`
    );
  }
  if (
    opts.earliestRawRecordMs !== undefined &&
    opts.earliestRawRecordMs !== null &&
    opts.earliestRawRecordMs > window.windowStartMs
  ) {
    caveats.push(
      `Raw session transcripts on disk only reach back to ${new Date(opts.earliestRawRecordMs).toISOString().slice(0, 10)}; earlier branch turns may have rotated out.`
    );
  }
  caveats.push(
    "Matched by repo working directory and branch commit window; concurrent branches in the same working tree overlap."
  );

  return {
    window,
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    matchedRecords,
    directCwdMatches,
    projectFallbackMatches,
    unpricedRecords,
    cacheHitRate,
    subagentCost,
    subagentShare,
    compactionCost,
    compactionEvents,
    providers,
    models,
    caveats,
  };
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(ratio: number | null): string {
  if (ratio === null) return "n/a";
  const pct = ratio * 100;
  return `${pct.toFixed(pct >= 10 || pct === 0 ? 1 : 2)}%`;
}

export function renderGitCostText(
  report: GitBranchCostReport,
  opts: { color?: boolean } = {}
): string {
  const color = opts.color === true;
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);

  const { window: w } = report;
  const lines = [
    bold(`∞ Tokmeter Git Attribution · ${w.repoName} (${w.branch} vs ${w.baseRef})`),
    dim(
      `${w.commitCount} commit(s) · HEAD ${w.headSha} · window ${new Date(w.windowStartMs).toISOString().slice(0, 16)} -> ${new Date(w.windowEndMs).toISOString().slice(0, 16)} UTC`
    ),
    "",
    `  Est. API Cost   ${bold(fmtUsd(report.totalCost))}`,
    `  Total Tokens    ${fmtTokens(report.totalTokens)} (in ${fmtTokens(report.inputTokens)} / out ${fmtTokens(report.outputTokens)} / cache ${fmtTokens(report.cacheReadTokens)})`,
    `  Cache Hit       ${fmtPct(report.cacheHitRate)}`,
    `  Matched Calls   ${report.matchedRecords.toLocaleString()}`,
  ];

  if (report.subagentShare !== null && report.subagentCost > 0) {
    lines.push(
      `  Subagent Share  ${fmtUsd(report.subagentCost)} (${fmtPct(report.subagentShare)})`
    );
  }
  if (report.compactionEvents > 0) {
    lines.push(
      `  Compaction Tax  ${fmtUsd(report.compactionCost)} (${report.compactionEvents} event(s))`
    );
  }

  if (report.providers.length > 0) {
    lines.push("", bold("Agents"));
    for (const p of report.providers) {
      lines.push(
        `  ${p.provider.padEnd(18)} ${fmtUsd(p.cost).padStart(9)}  ${fmtTokens(p.tokens).padStart(8)}  (${p.sharePct.toFixed(1)}%)`
      );
    }
  }

  if (report.models.length > 0) {
    lines.push("", bold("Models"));
    for (const m of report.models.slice(0, 8)) {
      lines.push(
        `  ${m.model.padEnd(32)} ${m.provider.padEnd(14)} ${fmtUsd(m.cost).padStart(9)}  ${fmtTokens(m.tokens).padStart(8)}`
      );
    }
  }

  lines.push("", dim("Caveats:"));
  for (const c of report.caveats) lines.push(dim(`  - ${c}`));
  return lines.join("\n");
}

/** Render a paste-ready GitHub PR Markdown snippet summarizing branch AI cost. */
export function renderGitCostMarkdown(report: GitBranchCostReport): string {
  const { window: w } = report;
  const parts = [
    `Branch \`${w.branch}\``,
    `**${fmtTokens(report.totalTokens)} tokens**`,
    `**${fmtUsd(report.totalCost)}** est. API`,
  ];
  if (report.cacheHitRate !== null) parts.push(`**${fmtPct(report.cacheHitRate)}** cache hit`);
  if (report.subagentShare !== null && report.subagentCost > 0) {
    parts.push(`${fmtPct(report.subagentShare)} subagents`);
  }
  if (report.compactionEvents > 0) {
    parts.push(`${fmtUsd(report.compactionCost)} compaction`);
  }
  if (report.providers.length > 0) {
    parts.push(report.providers.map((p) => p.provider).join(" + "));
  }

  const lines = [
    `<details>`,
    `<summary>AI Engineering Cost (Tokmeter): ${parts.join(" · ")}</summary>`,
    "",
    `- **Branch:** \`${w.branch}\` (\`${w.headSha}\` vs \`${w.baseRef}\`, ${w.commitCount} commit(s))`,
    `- **Matched calls:** ${report.matchedRecords.toLocaleString()} (${report.directCwdMatches} direct cwd, ${report.projectFallbackMatches} project-name fallback)`,
    "",
  ];

  if (report.models.length > 0) {
    lines.push("| Model | Agent | Est. Cost | Tokens |", "| --- | --- | ---: | ---: |");
    for (const m of report.models.slice(0, 10)) {
      lines.push(`| ${m.model} | ${m.provider} | ${fmtUsd(m.cost)} | ${fmtTokens(m.tokens)} |`);
    }
    lines.push("");
  }

  lines.push(
    `<sub>Caveats: ${report.caveats.join(" ")} — generated locally with \`npx @sriinnu/tokmeter git --markdown\`</sub>`
  );
  lines.push(`</details>`);
  return lines.join("\n");
}
