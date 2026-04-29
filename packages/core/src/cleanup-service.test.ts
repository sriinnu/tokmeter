import { describe, it } from "vitest";

// ─── Freeze-rule regression tests (restore path) ───────────────────────
// Second freeze leak (commit 3580b40): restore was calling clearRecordCache()
// and re-pricing restored history at current rates. The restore path must
// invalidate the history-snapshot + summary cache while keeping per-record
// frozen costs in the scan-cache untouched.

describe("CleanupService.restore — historical immutability", () => {
  it.todo("does not reprice historical records after restore");
  it.todo(
    "invalidates summary cache + history snapshot without wiping per-record costs"
  );
  it.todo(
    "restored records keep the cost they had at first-scan time, not current kosha rates"
  );
});

describe("CleanupService.execute — cache invalidation is scoped", () => {
  it.todo(
    "invalidateRecordCache is called only with the actually-deleted paths (no full wipe)"
  );
});
