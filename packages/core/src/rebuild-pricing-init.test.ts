import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokmeterCore } from "./tokmeter-core.js";

// A window rebuild on a fresh core (`tokmeter backfill`) implied its sealed
// days' price cards before anything had loaded kosha's runtime (scanRawRecords
// inits it, but runs after). Aliases and fuzzy matches live in the runtime, so
// a model like ribhu's "fable" got no card and a forced rebuild billed it $0.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-rebuild-init-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function coreWithSpiedInit(): { core: TokmeterCore; init: ReturnType<typeof vi.fn> } {
  const core = new TokmeterCore({ homeDir: home });
  const pricing = (core as unknown as { pricing: { init: () => Promise<void> } }).pricing;
  const init = vi.fn(async () => {});
  pricing.init = init;
  return { core, init };
}

describe("rebuilds load pricing before they price", () => {
  it("rebuildRecentDays initializes pricing on a fresh core", async () => {
    const { core, init } = coreWithSpiedInit();
    await core.rebuildRecentDays(1);
    expect(init).toHaveBeenCalled();
  });

  it("backfillProvider initializes pricing on a fresh core", async () => {
    const { core, init } = coreWithSpiedInit();
    await core.backfillProvider("ribhu", 1);
    expect(init).toHaveBeenCalled();
  });

  it("neither touches pricing when it is skipped", async () => {
    const core = new TokmeterCore({ homeDir: home, skipPricing: true });
    const pricing = (core as unknown as { pricing: { init: () => Promise<void> } }).pricing;
    const init = vi.fn(async () => {});
    pricing.init = init;
    await core.rebuildRecentDays(1);
    await core.backfillProvider("ribhu", 1);
    expect(init).not.toHaveBeenCalled();
  });
});
