import { describe, expect, it } from "vitest";
import { sanitizeDataLabel } from "./display-safety.js";

describe("sanitizeDataLabel", () => {
  it("strips OSC (BEL and ST terminated), CSI and bidi controls", () => {
    expect(sanitizeDataLabel("\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(sanitizeDataLabel("a\u001b]0;title\u001b\\b")).toBe("ab");
    expect(sanitizeDataLabel("\u001b[31mred\u001b[0m‮")).toBe("red");
  });

  it("drops an unterminated OSC body instead of leaking it, and leaves no ESC", () => {
    const out = sanitizeDataLabel("ok\u001b]0;never-terminated");
    expect(out).toBe("ok");
    expect(out).not.toContain("\u001b");
  });

  it("stays linear on hostile unterminated OSC runs", () => {
    for (const input of [
      "\u001b]a".repeat(32_000),
      `\u001b]${"a".repeat(200_000)}`,
      "\u001b[".repeat(50_000),
    ]) {
      const started = performance.now();
      const out = sanitizeDataLabel(input, 4096);
      expect(performance.now() - started).toBeLessThan(200);
      expect(out).not.toContain("\u001b");
    }
  });

  it("still returns up to maxLength visible characters from a long label", () => {
    expect(sanitizeDataLabel("x".repeat(100_000), 512)).toHaveLength(512);
  });
});
