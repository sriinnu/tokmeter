/** Offline, synthetic data for the native walkthrough. Never reads user logs. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeAllProjectsFromState,
  computeModelCostsFromState,
} from "../packages/core/src/aggregate-consumers.js";
import { DailyAccumulator } from "../packages/core/src/aggregates-store.js";
import { createRecord } from "../packages/core/src/parsers/utils.js";
import { computeStatbarSignals } from "../packages/core/src/signals.js";
const out = resolve("docs/assets/demo");
mkdirSync(out, { recursive: true });
const now = new Date(2026, 8, 6, 12).getTime();
const records = [
  createRecord({
    timestamp: now - 60000,
    provider: "codex",
    model: "gpt-6-astra",
    project: "sample-api",
    inputTokens: 20000,
    cacheReadTokens: 600000,
    outputTokens: 4000,
    reasoningTokens: 1000,
    cost: 1.05,
  }),
  createRecord({
    timestamp: now - 30000,
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    project: "sample-web",
    inputTokens: 20000,
    cacheReadTokens: 300000,
    outputTokens: 30000,
    cost: 1,
    usage: { cost: "calculated" },
  }),
];
const missing = createRecord({
  timestamp: now - 10000,
  provider: "codex",
  model: "new-model",
  project: "sample-api",
  inputTokens: 40000,
  outputTokens: 10000,
  usage: { cost: "not_exposed" },
});
const reported = createRecord({
  timestamp: now - 5000,
  provider: "cursor",
  model: "tool-reported-model",
  project: "sample-web",
  inputTokens: 20000,
  outputTokens: 5000,
  cost: 0.4,
  usage: { cost: "direct" },
});
const scenes = [
  { caption: "Your day starts with a clear usage view", records: [] },
  { caption: "See today's models and projects", records },
  { caption: "Missing prices stay unavailable", records: [...records, missing] },
  { caption: "Tool reports stay separate from estimates", records: [...records, reported] },
];
const snapshots = scenes.map((scene) => {
  const acc = new DailyAccumulator("2026-09-06");
  acc.foldAll(scene.records);
  return {
    caption: scene.caption,
    tokens: scene.records.reduce(
      (n, r) =>
        n +
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheWriteTokens +
        r.reasoningTokens,
      0
    ),
    signals: computeStatbarSignals(scene.records, now),
    models: computeModelCostsFromState(new Map(), acc, {}),
    projects: computeAllProjectsFromState(new Map(), acc, {}),
  };
});
writeFileSync(resolve(out, "snapshots.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
console.log(`Wrote ${snapshots.length} synthetic scenes. No provider or user-data access.`);
