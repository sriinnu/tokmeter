import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// cli.ts runs main() on import, so this reads the source. It guards the bug
// that shipped in 1.23.0: Antigravity had no filter flag, and the parser
// dropped `--antigravity` silently, printing every provider's totals.
const here = dirname(fileURLToPath(import.meta.url));
const cli = readFileSync(join(here, "cli.ts"), "utf8");
const types = readFileSync(join(here, "../../core/src/types.ts"), "utf8");

function providerIds(): string[] {
  const union = types.match(/export type ProviderId =([\s\S]*?);/);
  if (!union) throw new Error("ProviderId union not found in core types.ts");
  return [...union[1].matchAll(/\|\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

describe("CLI provider flags", () => {
  it("every provider can be filtered from the CLI", () => {
    const ids = providerIds();
    expect(ids.length).toBeGreaterThan(20);
    const mapped = new Set([...cli.matchAll(/"([a-z0-9-]+)" as ProviderId/g)].map((m) => m[1]));
    expect(ids.filter((id) => !mapped.has(id))).toEqual([]);
  });

  it("an unknown option is an error, not a silent no-op", () => {
    const fallthrough = cli.match(/default:\s*\n([\s\S]*?)\n\s*break;/);
    expect(fallthrough?.[1]).toMatch(/arg\.startsWith\("-"\)[\s\S]*process\.exit\(2\)/);
  });
});
