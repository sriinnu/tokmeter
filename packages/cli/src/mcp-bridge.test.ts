import { describe, expect, it, vi } from "vitest";
import { loadMcpModule } from "./mcp-bridge.js";

describe("loadMcpModule", () => {
  it("returns the loaded module when present", async () => {
    const mod = await loadMcpModule(async () => ({ ok: true }), "live");
    expect(mod).toEqual({ ok: true });
  });

  it("prints actionable install guidance and exits 1 when @sriinnu/tokmeter-mcp is missing", async () => {
    const missing = Object.assign(
      new Error("Cannot find package '@sriinnu/tokmeter-mcp' imported from cli.js"),
      { code: "ERR_MODULE_NOT_FOUND" }
    );
    const messages: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("EXITED");
    }) as unknown as (code: number) => never;

    await expect(
      loadMcpModule(
        async () => {
          throw missing;
        },
        "daemon",
        (m) => messages.push(m),
        exit
      )
    ).rejects.toThrow("EXITED");

    expect(exit).toHaveBeenCalledWith(1);
    expect(messages[0]).toContain("npm install -g @sriinnu/tokmeter-mcp");
    expect(messages[0]).toContain("tokmeter daemon");
  });

  it("rethrows unrelated module errors", async () => {
    await expect(
      loadMcpModule(async () => {
        throw new Error("unexpected load fault");
      }, "live")
    ).rejects.toThrow("unexpected load fault");
  });
});
