/**
 * `tokmeter git` — Per-branch / per-PR AI engineering cost & efficiency attribution.
 */

import {
  attributeGitBranchCost,
  inspectGitBranch,
  loadAliases,
  localDateKey,
  renderGitCostMarkdown,
  renderGitCostText,
  TokmeterCore,
} from "@sriinnu/tokmeter";
import type { CliArgs } from "../args.js";

export async function runGit(args: CliArgs): Promise<void> {
  const dir = args.gitDir ?? process.cwd();
  const win = inspectGitBranch(dir, {
    base: args.gitBase,
    sinceCommit: args.gitSinceCommit,
    leadMinutes: args.gitLeadMinutes,
  });

  const core = new TokmeterCore({ skipPricing: args.light });
  const records = await core.scan({
    since: localDateKey(win.windowStartMs),
    until: localDateKey(win.windowEndMs),
    ...(args.providers?.length ? { providers: args.providers } : {}),
  });

  const earliestRawRecordMs =
    records.length > 0 ? Math.min(...records.map((r) => r.timestamp)) : null;

  const report = attributeGitBranchCost(records, win, {
    aliases: loadAliases(core.getHomeDir()),
    earliestRawRecordMs,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.markdown) {
    console.log(renderGitCostMarkdown(report));
    return;
  }

  console.log(renderGitCostText(report, { color: process.stdout.isTTY }));
}
