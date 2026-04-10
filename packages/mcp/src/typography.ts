/**
 * @sriinnu/drishti — Unicode typography engine
 *
 * Instead of three parallel functions, we define a Transform type
 * and build a small algebra around it. Themes become first-class.
 * Composition is explicit. Special cases are declared, not hidden.
 *
 * Design principles:
 *   - One abstraction (CharTransform), three concrete transforms
 *   - Exceptions are data, not comments
 *   - compose() enables mixed typography in a single pass
 *   - Theme objects let consumers name intent, not mechanism
 */

// ─── Core abstraction ────────────────────────────────────────────────────────

type CharTransform = (char: string) => string;

/**
 * Build a transform from Unicode Math block offsets.
 * Handles the surrogate pair reality of codePointAt/fromCodePoint.
 * Exceptions map specific codepoints to specific replacements
 * (e.g. the Planck constant hole at U+1D455).
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
 * Uses proper codePoint iteration — safe for surrogate pairs,
 * though our target range (Basic Latin) doesn't need it.
 */
function applyTransform(transform: CharTransform, s: string): string {
  return [...s].map(transform).join("");
}

// ─── Exceptions ──────────────────────────────────────────────────────────────

/**
 * U+1D455 is undefined (reserved). Math italic lowercase 'h' maps to
 * U+210E (Planck constant ℎ) per Unicode spec. Declared as data.
 */
const ITALIC_EXCEPTIONS = new Map<number, string>([
  [0x68, "\u210E"], // h → ℎ
]);

// ─── Small caps: different mechanism, same interface ─────────────────────────

/**
 * Small caps don't live in a contiguous Unicode block — they're
 * scattered across IPA Extensions and Latin Extended-D.
 * We express this as a sparse map and fall back to identity.
 */
const SMALL_CAPS: ReadonlyMap<string, string> = new Map([
  ["a", "ᴀ"],
  ["b", "ʙ"],
  ["c", "ᴄ"],
  ["d", "ᴅ"],
  ["e", "ᴇ"],
  ["f", "ꜰ"],
  ["g", "ɢ"],
  ["h", "ʜ"],
  ["i", "ɪ"],
  ["j", "ᴊ"],
  ["k", "ᴋ"],
  ["l", "ʟ"],
  ["m", "ᴍ"],
  ["n", "ɴ"],
  ["o", "ᴏ"],
  ["p", "ᴘ"],
  ["q", "ǫ"],
  ["r", "ʀ"],
  ["s", "s"],
  ["t", "ᴛ"],
  ["u", "ᴜ"],
  ["v", "ᴠ"],
  ["w", "ᴡ"],
  ["x", "x"],
  ["y", "ʏ"],
  ["z", "ᴢ"],
]);

const smallCapsTransform: CharTransform = (char) => SMALL_CAPS.get(char.toLowerCase()) ?? char;

// ─── Concrete transforms ─────────────────────────────────────────────────────

const italicTransform = mathBlockTransform(0x1d44e, 0x1d434, ITALIC_EXCEPTIONS);
const boldTransform = mathBlockTransform(0x1d41a, 0x1d400);
const monoTransform = mathBlockTransform(0x1d670, 0x1d670 - 32); // monospace block

// ─── Public API ──────────────────────────────────────────────────────────────

export const smallCaps = (s: string) => applyTransform(smallCapsTransform, s);
export const italicMath = (s: string) => applyTransform(italicTransform, s);
export const boldMath = (s: string) => applyTransform(boldTransform, s);
export const monoMath = (s: string) => applyTransform(monoTransform, s); // bonus

// ─── Composition ─────────────────────────────────────────────────────────────

/**
 * compose(f, g)(s) — apply g first, then f.
 * Standard right-to-left function composition.
 *
 * Why? Because "bold italic" is a real thing in Unicode math blocks
 * (U+1D468 / U+1D482). You can't get there by chaining the above —
 * each transform expects ASCII input. So compose at the intent level,
 * not the character level.
 *
 * Future: add boldItalicTransform for that block when needed.
 */
export const compose =
  (...fns: Array<(s: string) => string>) =>
  (s: string) =>
    fns.reduceRight((acc, fn) => fn(acc), s);

// ─── Themes — intent over mechanism ──────────────────────────────────────────

/**
 * A Theme is a named set of semantic roles → transforms.
 * Callers say "project name" not "small caps function."
 */
export interface StatuslineTheme {
  projectName: (s: string) => string;
  ephemeral: (s: string) => string;
  emphasis: (s: string) => string;
  code: (s: string) => string;
}

export const defaultTheme: StatuslineTheme = {
  projectName: smallCaps,
  ephemeral: italicMath,
  emphasis: boldMath,
  code: monoMath,
};

/**
 * Usage:
 *   const t = defaultTheme;
 *   `${t.projectName("vaayu")} · ${t.ephemeral("today")} · ${t.emphasis("3 tasks")}`
 *   → "ᴠᴀᴀʏᴜ · 𝑡𝑜𝑑𝑎𝑦 · 𝟯 𝘁𝗮𝘀𝗸𝘀"
 */
