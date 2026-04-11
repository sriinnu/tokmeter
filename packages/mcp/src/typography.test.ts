import { describe, expect, it } from "vitest";
import { boldMath, defaultTheme, italicMath, projectName } from "./typography.js";

describe("projectName (Fraktur initial + Script body)", () => {
  it("renders a Fraktur first char + Script rest", () => {
    const result = projectName("vaayu");
    // First char: 𝔳 (Fraktur v), rest: 𝒶𝒶𝓎𝓊 (Script)
    expect(result).not.toBe("vaayu");
    expect(result.length).toBeGreaterThan(0);
    // The first codepoint should be in the Fraktur lowercase block (U+1D51E+)
    const firstCode = result.codePointAt(0)!;
    expect(firstCode).toBeGreaterThanOrEqual(0x1d51e);
    expect(firstCode).toBeLessThanOrEqual(0x1d537);
  });

  it("handles single-character names", () => {
    const result = projectName("a");
    expect(result).toBe("\uD835\uDD1E"); // 𝔞 (Fraktur a)
  });

  it("preserves hyphens and digits", () => {
    const result = projectName("my-app-2");
    expect(result).toContain("-");
    expect(result).toContain("2");
  });

  it("returns empty for empty input", () => {
    expect(projectName("")).toBe("");
  });
});

describe("italicMath", () => {
  it("converts lowercase ASCII to mathematical italic", () => {
    expect(italicMath("today")).toBe("𝑡𝑜𝑑𝑎𝑦");
  });

  it("uses U+210E for italic h (Planck constant)", () => {
    expect(italicMath("h")).toBe("ℎ");
  });

  it("preserves digits and symbols", () => {
    expect(italicMath("v2.0")).toBe("𝑣2.0");
  });
});

describe("boldMath", () => {
  it("converts to mathematical bold", () => {
    expect(boldMath("hi")).toBe("𝐡𝐢");
  });
});

describe("defaultTheme", () => {
  it("maps semantic roles to transforms", () => {
    expect(defaultTheme.name("test")).toBe(projectName("test"));
    expect(defaultTheme.ephemeral("now")).toBe(italicMath("now"));
    expect(defaultTheme.emphasis("ok")).toBe(boldMath("ok"));
  });
});
