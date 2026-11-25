/**
 * @sriinnu/tokmeter-core — Synthetic provider registration placeholder.
 *
 * Keeps `"synthetic"` registered in `ProviderId` and `ALL_PROVIDER_IDS` for
 * downstream provenance/display lookups without scanning extra session files.
 */

import type { SessionParser, TokenRecord } from "../types.js";

export class SyntheticParser implements SessionParser {
  readonly providerId = "synthetic" as const;

  async scan(_homeDir: string): Promise<TokenRecord[]> {
    return [];
  }
}
