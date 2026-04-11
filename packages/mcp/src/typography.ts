/**
 * @sriinnu/drishti — Unicode typography engine
 *
 * Three-register visual hierarchy for terminal statuslines.
 * No font configuration needed — all glyphs present in SF Mono,
 * Cascadia, JetBrains Mono, Hack, Iosevka, Menlo.
 *
 * Registers:
 *   projectName()  : Fraktur initial + Math Script body
 *                    𝔳𝒶𝒶𝓎𝓊  𝔰𝓅𝒶𝓃𝒹𝒶  𝔨𝒶𝓇𝓎𝒶
 *                    Carved first char, flowing body.
 *                    Illuminated manuscript logic — the scribe drew
 *                    the initial with ceremony, wrote the rest in
 *                    running hand. Semantically correct for Sanskrit
 *                    names with open vowels and flowing phonemes.
 *
 *   italicMath()   : Math Italic (U+1D44E / U+1D434)
 *                    𝑡𝑜𝑑𝑎𝑦  𝑛𝑜𝑤  𝑠𝑡𝑎𝑙𝑒
 *                    Ephemeral, transient, changing. Thin strokes
 *                    signal "this value will be different soon."
 *
 *   boldMath()     : Math Bold (U+1D41A / U+1D400)
 *                    Reserved for hero emphasis. Available for theme
 *                    variants that need a heavier weight signal.
 *
 * Pixar magazine rule: never more than 3 typefaces in one composition.
 * We use exactly 3. Each earns its place.
 *
 * Full statusline example:
 *   𝔳𝒶𝒶𝓎𝓊  ·  𝑡𝑜𝑑𝑎𝑦  ·  3 tasks  ·  𝑛𝑜𝑤
 *   𝔰𝓅𝒶𝓃𝒹𝒶  ·  𝑠𝑡𝑎𝑙𝑒  ·  idle  ·  2h ago
 */

// ─── Core abstraction ────────────────────────────────────────────────────────

type CharTransform = (char: string) => string;

/**
 * Build a transform from contiguous Unicode Math block offsets.
 * Handles surrogate pairs correctly via codePointAt / fromCodePoint.
 * Exceptions map specific codepoints to their out-of-band replacements
 * (Unicode reserves certain slots and places the glyph elsewhere).
 */
function mathBlockTransform(
  lowercaseBase: number,
  uppercaseBase: number,
  exceptions: ReadonlyMap<number, string> = new Map()
): CharTransform {
  return (char: string): string => {
    const code = char.codePointAt(0) ?? 0;

    if (exceptions.has(code)) return exceptions.get(code)!;

    if (code >= 0x61 && code <= 0x7a) {
      return String.fromCodePoint(lowercaseBase + (code - 0x61));
    }
    if (code >= 0x41 && code <= 0x5a) {
      return String.fromCodePoint(uppercaseBase + (code - 0x41));
    }

    return char;
  };
}

/**
 * Apply a CharTransform to every grapheme in a string.
 * Spread operator on a string iterates by codepoint — safe for
 * characters outside the BMP (which all math blocks are).
 */
function applyTransform(transform: CharTransform, s: string): string {
  return [...s].map(transform).join("");
}

// ─── Exception maps ──────────────────────────────────────────────────────────

/**
 * Math Italic: U+1D455 is undefined. Lowercase 'h' maps to
 * U+210E (Planck constant ℎ) per Unicode spec.
 */
const ITALIC_EXCEPTIONS: ReadonlyMap<number, string> = new Map([
  [0x68, "\u210E"], // h → ℎ
]);

/**
 * Math Script: several uppercase letters are placed outside the
 * main block. None of these hit the current project namespace
 * (vaayu, chitragupta, pakt, spanda, karya, smriti) but declared
 * for correctness.
 */
const SCRIPT_EXCEPTIONS: ReadonlyMap<number, string> = new Map([
  [0x42, "\u212C"], // B → ℬ
  [0x45, "\u2130"], // E → ℰ
  [0x46, "\u2131"], // F → ℱ
  [0x48, "\u210B"], // H → ℋ
  [0x49, "\u2110"], // I → ℐ
  [0x4c, "\u2112"], // L → ℒ
  [0x4d, "\u2133"], // M → ℳ
  [0x52, "\u211B"], // R → ℛ
]);

/**
 * Math Fraktur: exception slots for uppercase.
 * C, H, I, R, Z are placed outside the main block.
 * None hit the current project namespace.
 */
const FRAKTUR_EXCEPTIONS: ReadonlyMap<number, string> = new Map([
  [0x43, "\u212D"], // C → ℭ
  [0x48, "\u210C"], // H → ℌ
  [0x49, "\u2111"], // I → ℑ
  [0x52, "\u211C"], // R → ℜ
  [0x5a, "\u2128"], // Z → ℨ
]);

// ─── Transforms ──────────────────────────────────────────────────────────────

const italicTransform = mathBlockTransform(0x1d44e, 0x1d434, ITALIC_EXCEPTIONS);
const boldTransform = mathBlockTransform(0x1d41a, 0x1d400);
const scriptTransform = mathBlockTransform(0x1d4b6, 0x1d49c, SCRIPT_EXCEPTIONS);
const frakturTransform = mathBlockTransform(0x1d51e, 0x1d504, FRAKTUR_EXCEPTIONS);
const sansBoldTransform = mathBlockTransform(0x1d5ee, 0x1d5d4); // 𝘁𝗼𝗸𝗺𝗲𝘁𝗲𝗿

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Project name register: Fraktur initial + Math Script body.
 *
 * The first character is carved — dense Fraktur strokes, scribal weight.
 * The rest flows — cursive Script, open and alive.
 *
 *   projectName("vaayu")       → 𝔳𝒶𝒶𝓎𝓊
 *   projectName("chitragupta") → 𝔠𝒽𝒾𝓉𝓇𝒶𝑔𝓊𝓅𝓉𝒶
 *   projectName("spanda")      → 𝔰𝓅𝒶𝓃𝒹𝒶
 *   projectName("karya")       → 𝔨𝒶𝓇𝓎𝒶
 *   projectName("smriti")      → 𝔰𝓂𝓇𝒾𝓉𝒾
 *   projectName("pakt")        → 𝔭𝒶𝓀𝓉
 */
export function projectName(s: string): string {
  if (!s) return s;
  const [first, ...rest] = [...s]; // codePoint-safe spread
  return applyTransform(frakturTransform, first) + applyTransform(scriptTransform, rest.join(""));
}

/**
 * Ephemeral register: Math Italic.
 * Use for values that change — "today", "now", "stale", timestamps.
 * Thin strokes signal transience.
 *
 *   italicMath("today") → 𝑡𝑜𝑑𝑎𝑦
 *   italicMath("now")   → 𝑛𝑜𝑤
 *   italicMath("stale") → 𝑠𝑡𝑎𝑙𝑒
 */
export function italicMath(s: string): string {
  return applyTransform(italicTransform, s);
}

/**
 * Emphasis register: Math Bold.
 * Reserved — currently unused in default rendering.
 * Available for theme variants requiring hero weight.
 */
export function boldMath(s: string): string {
  return applyTransform(boldTransform, s);
}

// ─── Theme interface ──────────────────────────────────────────────────────────

/**
 * A Theme maps semantic roles to transforms.
 * Callers express intent ("project name"), not mechanism ("fraktur+script").
 * Swap themes per context without touching rendering logic.
 *
 * Usage:
 *   const t = defaultTheme;
 *   `${t.name("vaayu")} · ${t.ephemeral("today")} · 3 tasks · ${t.ephemeral("now")}`
 *   → 𝔳𝒶𝒶𝓎𝓊 · 𝑡𝑜𝑑𝑎𝑦 · 3 tasks · 𝑛𝑜𝑤
 */
export interface StatuslineTheme {
  name: (s: string) => string;
  ephemeral: (s: string) => string;
  emphasis: (s: string) => string;
}

/**
 * Sans-serif bold register: clean, modern, reads as real text.
 * Works for ANY project name — English, Sanskrit, anything.
 *
 *   sansBold("tokmeter") → 𝘁𝗼𝗸𝗺𝗲𝘁𝗲𝗿
 *   sansBold("vaayu")    → 𝘃𝗮𝗮𝘆𝘂
 */
export function sansBold(s: string): string {
  return applyTransform(sansBoldTransform, s);
}

export const defaultTheme: StatuslineTheme = {
  name: sansBold, // reads as text, visually distinct
  ephemeral: italicMath,
  emphasis: boldMath,
};

/** Sanskrit theme — Fraktur+Script for flowing open-vowel names. */
export const sanskritTheme: StatuslineTheme = {
  name: projectName,
  ephemeral: italicMath,
  emphasis: boldMath,
};
