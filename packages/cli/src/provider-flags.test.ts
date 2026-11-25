import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_FLAG_MAP, parseArgs } from "./args.js";

// Guards the bug that shipped in 1.23.0: Antigravity had no filter flag, and
// the parser dropped `--antigravity` silently, printing every provider's totals.
const here = dirname(fileURLToPath(import.meta.url));
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
    const flagForProvider = new Map(Object.entries(PROVIDER_FLAG_MAP).map(([f, id]) => [id, f]));
    expect(ids.filter((id) => !flagForProvider.has(id as never))).toEqual([]);
    for (const id of ids) {
      const flag = flagForProvider.get(id as never)!;
      expect(parseArgs(["node", "tokmeter", flag]).providers).toEqual([id]);
    }
  });

  it("an unknown option is an error, not a silent no-op", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      expect(() => parseArgs(["node", "tokmeter", "--no-such-provider"])).toThrow("EXIT:2");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option"));
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
