import { describe, expect, it } from "vitest";
import { boldMath, italicMath, smallCaps } from "./typography.js";

describe("smallCaps", () => {
  it("converts lowercase ASCII to small caps", () => {
    expect(smallCaps("tokmeter")).toBe("ᴛᴏᴋᴍᴇᴛᴇʀ");
  });

  it("preserves digits, hyphens, and slashes", () => {
    expect(smallCaps("auth-service-v2")).toBe("ᴀᴜᴛʜ-sᴇʀᴠɪᴄᴇ-ᴠ2");
  });

  it("handles uppercase by treating as lowercase", () => {
    // Small caps lowercase A-Z is the convention
    expect(smallCaps("API")).toBe("ᴀᴘɪ");
  });

  it("returns empty string for empty input", () => {
    expect(smallCaps("")).toBe("");
  });
});

describe("italicMath", () => {
  it("converts lowercase ASCII to mathematical italic", () => {
    expect(italicMath("today")).toBe("𝑡𝑜𝑑𝑎𝑦");
  });

  it("uses U+210E for italic h (Planck constant)", () => {
    // U+1D455 is reserved as undefined in the math italic block;
    // U+210E (Planck constant) is the canonical italic h.
    expect(italicMath("h")).toBe("ℎ");
    expect(italicMath("hello")).toContain("ℎ");
  });

  it("converts uppercase ASCII to mathematical italic capitals", () => {
    expect(italicMath("AB")).toBe("𝐴𝐵");
  });

  it("preserves digits and symbols", () => {
    expect(italicMath("v2.0")).toBe("𝑣2.0");
  });
});

describe("boldMath", () => {
  it("converts lowercase ASCII to mathematical bold", () => {
    expect(boldMath("hi")).toBe("𝐡𝐢");
  });

  it("converts uppercase ASCII to mathematical bold capitals", () => {
    expect(boldMath("AB")).toBe("𝐀𝐁");
  });
});
