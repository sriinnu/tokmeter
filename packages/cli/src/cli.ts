#!/usr/bin/env node
/**
 * tokmeter — Token usage tracking CLI entrypoint.
 */

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

import { homedir } from "node:os";
import { localDateKey, sanitizeDataLabel, TokmeterCore } from "@sriinnu/tokmeter";
import Table from "cli-table3";
import { olderThanToIsoCutoff, parseArgs } from "./args.js";
import { runBar } from "./commands/bar.js";
import { runGit } from "./commands/git.js";
import { runPricingAudit } from "./commands/pricing-audit.js";
import { runReceipt } from "./commands/receipt.js";
import { runRoutes } from "./commands/routes.js";
import { runCursorSyncCommand } from "./cursor-sync.js";
import { tryServeFromDaemon } from "./daemon-bridge.js";
import { printSummaryTables } from "./formatters.js";
import { loadMcpModule } from "./mcp-bridge.js";

type InstallerModule = typeof import("@sriinnu/tokmeter-mcp/installer.js");

const INSTALLER_COMMANDS: Record<string, (installer: InstallerModule) => void> = {
  "install-statusline": (m) => m.installStatusline(),
  "install-mcp": (m) => m.installMCP(),
  "install-plugin": (m) => m.installPlugin(),
  "uninstall-plugin": (m) => m.uninstallPlugin(),
  "uninstall-statusline": (m) => m.uninstallStatusline(),
  "uninstall-mcp": (m) => m.uninstallMCP(),
  editors: (m) => m.listEditors(),
};

async function main() {
  // `tokmeter cursor sync`: opt-in, credentialed, handled on its own path so
  // the shared flag parser never sees its options.
  if (process.argv[2] === "cursor" && process.argv[3] === "sync") {
    process.exit(await runCursorSyncCommand(process.argv.slice(3)));
  }
  if (process.argv[2] === "statusline" || process.argv[2] === "status") {
    const { runStatusline } = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/statusline.js"),
      "statusline"
    );
    await runStatusline(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "slash") {
    const { runSlashCommand } = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/slash.js"),
      "slash"
    );
    await runSlashCommand(process.argv[3], process.argv.slice(4));
    return;
  }
  const args = parseArgs(process.argv);

  if (args.olderThan) {
    const cutoff = olderThanToIsoCutoff(args.olderThan);
    if (!cutoff) {
      console.error(
        `Error: invalid --older-than value "${args.olderThan}" (expected e.g. 30d, 2w, 1m)`
      );
      process.exit(1);
    }
    if (args.until) {
      console.error("Error: --older-than and --until are mutually exclusive; pick one.");
      process.exit(1);
    }
    args.until = cutoff;
  }

  if (args.command === "cursor-hook") {
    const { runCursorHook } = await import("./cursor-hook.js");
    process.exit(
      await runCursorHook({
        sub: args.cursorHookSub ?? "status",
        rest: args.cursorHookRest ?? [],
        json: args.json,
      })
    );
  }

  if (args.command === "tui") {
    const { startTui } = await import("@sriinnu/tokmeter/tui");
    await startTui();
    return;
  }

  if (args.command === "serve") {
    console.log("Web dashboard — run `bun run dev:web` from the repo or open it from TokmeterBar");
    process.exit(0);
  }

  const core = new TokmeterCore({ skipPricing: args.light });

  if (args.command === "live") {
    const { startLive } = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/live.js"),
      "live"
    );
    await startLive();
    return;
  }

  if (args.command === "statusline") {
    const { runStatusline } = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/statusline.js"),
      "statusline"
    );
    await runStatusline();
    return;
  }

  if (args.command === "daemon") {
    const { runDaemonCLI } = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/daemon/server.js"),
      "daemon"
    );
    runDaemonCLI(args.daemonCmd ?? "status");
    return;
  }

  const runInstaller = args.command ? INSTALLER_COMMANDS[args.command] : undefined;
  if (runInstaller) {
    const installer = await loadMcpModule(
      () => import("@sriinnu/tokmeter-mcp/installer.js"),
      args.command!
    );
    runInstaller(installer);
    return;
  }

  if (
    args.command === "install-cron" ||
    args.command === "uninstall-cron" ||
    args.command === "cron-status"
  ) {
    if (process.platform !== "darwin") {
      console.error("Daily cron is currently macOS-only (uses launchd).");
      process.exit(1);
    }
    const { installDailyCron, uninstallDailyCron, cronStatus } = await import("./cron.js");
    if (args.command === "install-cron") installDailyCron();
    else if (args.command === "uninstall-cron") uninstallDailyCron();
    else cronStatus();
    return;
  }

  if (
    args.command === "update" ||
    args.command === "refresh" ||
    args.command === "kosha-refresh" ||
    args.command === "kosha-update"
  ) {
    try {
      const { refreshKoshaRegistry } = await import("@sriinnu/tokmeter");
      console.log("Refreshing kosha registry...");
      await refreshKoshaRegistry();
      console.log("Kosha registry refreshed. Next scan will reprice today's records.");
    } catch (error) {
      console.error(
        `Failed to refresh kosha: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "coverage") {
    const { yesterdayDateKey } = await import("@sriinnu/tokmeter");
    const date = args.date ?? yesterdayDateKey(Date.now());
    const coverageCore = new TokmeterCore({ skipPricing: true });
    if (!args.json) console.error(`Checking ${date}: parsing files changed since then…`);
    const report = await coverageCore.checkCoverage(date);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const home = homedir();
    const tilde = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
    console.log(
      `\n${date} — walked ${report.homes.length} agent folders in ${(report.elapsedMs / 1000).toFixed(1)}s${report.partial ? " (time budget ran out: partial)" : ""}`
    );
    if (report.unread.length === 0) {
      console.log("Every session file that changed that day fed the ledger.\n");
      return;
    }
    console.log(
      `${report.unread.length} file(s) changed that day, carry usage, and fed no record — that usage is not in the ledger:\n`
    );
    for (const f of report.unread.slice(0, 50)) {
      const kb = `${Math.max(1, Math.round(f.bytes / 1024))} KB`.padStart(9);
      console.log(
        `  ${kb}  ${f.kind === "compressed" ? "compressed" : f.kind === "database" ? "database  " : "usage     "}  ${sanitizeDataLabel(tilde(f.path), 4096)}  [${f.providers.map((p) => sanitizeDataLabel(p, 64)).join(", ")}]`
      );
    }
    if (report.unread.length > 50)
      console.log(`  … ${report.unread.length - 50} more (--json for all)`);
    console.log(
      "\nIf these are real sessions, please open an issue with the folder layout: https://github.com/sriinnu/tokmeter/issues/new?template=agent_support.yml\n"
    );
    process.exitCode = 2;
    return;
  }

  if (args.command === "quota") {
    const { getQuota } = await import("@sriinnu/tokmeter");
    const windows = await getQuota(homedir(), Date.now(), (msg) => console.error(`note: ${msg}`));
    if (args.json) {
      console.log(JSON.stringify({ windows }, null, 2));
      return;
    }
    if (windows.length === 0) {
      console.log(
        "No plan windows seen yet. Codex reports them in its session files, Grok Bot in its app cache; Claude Code only to the tokmeter statusline."
      );
      return;
    }
    const when = (sec: number) =>
      new Date(sec * 1000).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    const ago = (ms: number) => {
      const m = Math.round((Date.now() - ms) / 60_000);
      return m < 60
        ? `${m}m ago`
        : m < 2880
          ? `${Math.round(m / 60)}h ago`
          : `${Math.round(m / 1440)}d ago`;
    };
    console.log();
    for (const w of windows) {
      const pace = (w.recentPctPerHour ?? w.avgPctPerHour).toFixed(1);
      const verdict =
        w.verdict === "expired"
          ? `window has reset since the last reading (${w.usedPct.toFixed(0)}% then)`
          : w.verdict === "at-limit"
            ? `at the limit until ${when(w.resetsAt)}`
            : w.verdict === "hits-limit" && w.hitsLimitAt
              ? `at ${pace}%/h you hit 100% ${when(w.hitsLimitAt)}, before the reset`
              : `at ${pace}%/h it resets first`;
      console.log(
        `  ${w.agent.padEnd(12)} ${w.window.padEnd(3)} ${(w.verdict === "expired" ? "-" : `${w.usedPct.toFixed(0)}%`).padStart(4)}  resets ${when(w.resetsAt)}  ${verdict}`
      );
      const extra = [
        `read ${ago(w.sampledAt)}`,
        ...(w.plan ? [`plan ${w.plan}`] : []),
        ...(w.creditsBalance !== undefined ? [`${w.creditsBalance.toFixed(0)} credits`] : []),
        ...(w.agent === "grok-bot" ? ["vendor plan meter: no token data"] : []),
      ];
      console.log(`  ${"".padEnd(17)}${extra.join(" · ")}`);
    }
    console.log();
    return;
  }

  if (args.command === "backfill") {
    const days = args.backfillDays && args.backfillDays > 0 ? args.backfillDays : 30;
    const selected = args.providers ?? [];
    try {
      if (selected.length > 0) {
        for (const provider of selected) {
          console.log(
            `Backfilling ${provider} into the last ${days} sealed day(s) — additive, other providers untouched...`
          );
          await core.backfillProvider(provider, days, Date.now());
        }
        console.log(`Provider backfill complete (${selected.join(", ")}).`);
      } else {
        console.log(
          `Backfilling ALL providers over the last ${days} day(s) (grow-only; only days whose raw still exists can change)...`
        );
        await core.rebuildRecentDays(days, Date.now(), args.force === true);
        console.log(`Backfill complete. Recomputed up to ${days} recent day(s).`);
      }
    } catch (error) {
      console.error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    return;
  }

  if (args.command === "pricing-audit") {
    await runPricingAudit({ json: args.json !== false });
    return;
  }

  if (args.command === "routes") {
    await runRoutes({
      json: args.json === true,
      project: args.project,
    });
    return;
  }

  if (args.command === "receipt") {
    await runReceipt(args);
    return;
  }

  if (args.command === "git") {
    await runGit(args);
    return;
  }

  if (args.command === "bar") {
    await runBar(args);
    return;
  }

  if (args.command === "pricing") {
    const { PricingService } = await import("@sriinnu/tokmeter");
    const pricing = new PricingService();
    await pricing.init();
    const modelId = args.pricingModel;
    if (!modelId) {
      if (args.json) {
        console.log(JSON.stringify({ error: "usage: tokmeter pricing <model-id> [--json]" }));
      } else {
        console.log("Usage: tokmeter pricing <model-id>");
        console.log("Example: tokmeter pricing claude-sonnet-4-20250514");
      }
      process.exit(1);
    }
    const { pricing: p, source } = await pricing.getPricingWithSource(modelId);
    const status = !p ? "unpriced" : pricing.isPricedFree(modelId) ? "free" : "priced";
    const from = source.matchedId ? `${source.tier}, as ${source.matchedId}` : source.tier;
    if (args.json) {
      console.log(JSON.stringify({ model: modelId, status, source, pricing: p }, null, 2));
      if (!p) process.exit(1);
      return;
    }
    if (!p) {
      console.log(`No price for ${modelId}, so its usage counts as $0.`);
      console.log(
        "A catalog's $0 isn't taken as a price, except for a -free or :free model on its route (model@provider)."
      );
      console.log("Add a rate in ~/.tokmeter/pricing-overrides.json to price it.");
      process.exit(1);
    }
    if (status === "free") {
      console.log(`${modelId} is free: $0 in, $0 out (${from}).`);
    } else {
      const usd = (n: number) => {
        if (n === 0 || n >= 1) return `$${n.toFixed(2)}`;
        const decimals = Math.max(2, 2 - Math.floor(Math.log10(Math.abs(n))));
        const s = n.toFixed(Math.min(decimals, 20)).replace(/(\.\d\d)0+$|(\.\d*?[1-9])0+$/, "$1$2");
        return `$${s}`;
      };
      const table = new Table({ head: ["Metric", "Per Million Tokens"], colWidths: [25, 20] });
      table.push(
        ["Input", usd(p.inputPerMillion ?? 0)],
        ["Output", usd(p.outputPerMillion ?? 0)],
        ["Cache Read", p.cacheReadPerMillion != null ? usd(p.cacheReadPerMillion) : "N/A"],
        ["Cache Write", p.cacheWritePerMillion != null ? usd(p.cacheWritePerMillion) : "N/A"]
      );
      console.log(`Pricing for: ${modelId} (${from})`);
      console.log(table.toString());
    }
    return;
  }

  if (args.command === "cleanup") {
    const { runCleanup } = await import("./cleanup.js");
    await runCleanup({
      project: args.project,
      providers: args.providers,
      since: args.since,
      until: args.until,
      today: args.today,
      week: args.week,
      month: args.month,
      dryRun: args.dryRun,
      backup: args.backup,
      force: args.force,
      json: args.json,
      light: args.light,
      scanOptions: args,
    });
    return;
  }

  if (args.command === "restore") {
    const { runRestore } = await import("./restore.js");
    await runRestore({ id: args.restoreId, latest: args.restoreLatest, json: args.json });
    return;
  }

  if (args.command === "alias") {
    const { runAlias } = await import("./alias.js");
    await runAlias({ sub: args.aliasSub ?? "list", rest: args.aliasRest ?? [], json: args.json });
    return;
  }

  if (args.command === "config") {
    const { runConfig } = await import("./config.js");
    await runConfig({
      sub: args.configSub ?? "list",
      rest: args.configRest ?? [],
      json: args.json,
    });
    return;
  }

  if (args.command === "snapshot") {
    const { runSnapshot } = await import("./snapshot.js");
    await runSnapshot({
      project: args.project,
      providers: args.providers,
      since: args.since,
      until: args.until,
      today: args.today,
      week: args.week,
      month: args.month,
      json: args.json,
      light: args.light,
    });
    return;
  }

  if (args.command === "digest") {
    const { runDigest } = await import("./digest.js");
    await runDigest({
      period: args.digestPeriod,
      project: args.project,
      json: args.json,
      light: args.light,
      scanOptions: args,
    });
    return;
  }

  if (args.olderThan && args.until) {
    const cutoff = new Date(args.until);
    cutoff.setDate(cutoff.getDate() - 1);
    args.until = localDateKey(cutoff.getTime());
  }

  const reportCmd = args.command || "overview";
  if (await tryServeFromDaemon(reportCmd, args)) return;

  core.getSummary(args);
  await core.scan({ today: args.today, rescanHistory: args.rescanHistory });
  const summary = core.getSummary(args);

  if (args.json) {
    switch (reportCmd) {
      case "models":
        console.log(JSON.stringify(summary.models, null, 2));
        break;
      case "daily":
        console.log(JSON.stringify(summary.daily, null, 2));
        break;
      case "projects":
        console.log(JSON.stringify(summary.projects, null, 2));
        break;
      case "stats":
        console.log(JSON.stringify(summary.stats, null, 2));
        break;
      default:
        console.log(JSON.stringify(summary, null, 2));
    }
    return;
  }

  printSummaryTables(reportCmd, summary);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
