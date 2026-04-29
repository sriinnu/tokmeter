import { describe, it } from "vitest";

// ─── Freeze-rule regression tests ──────────────────────────────────────
// Cover the $21K → $15K historical reprice bug (commits 662960c + 3580b40).
// Today's rows must reprice when kosha mtime advances; everything older must
// stay frozen at whatever cost was written when it was first scanned.
//
// These are skeletons — TODOs flesh out scenario setup. Filling them in
// requires a small fixtures harness (mock kosha registry on disk + seed
// JSONL files) that we'll layer in as a follow-up.

describe("scan() — kosha mtime change reprices today only", () => {
  it.todo("reprices today's records when kosha mtime advances");
  it.todo("does NOT reprice historical records on kosha mtime change");
  it.todo("preserves cost === 0 records (model not in registry) without flipping their cost");
});

describe("snapshot round-trip preserves cost verbatim", () => {
  it.todo("loads frozen costs without re-pricing on stableThrough match");
  it.todo("rebuilds snapshot from scan-cache (frozen costs) when stableThrough mismatches");
});

describe("enrichCosts skip rule", () => {
  it.todo("skips records where cost > 0 (the freeze-respect line)");
  it.todo("only zero-cost records get priced");
});
