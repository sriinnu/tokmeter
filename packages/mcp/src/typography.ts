/**
 * @sriinnu/drishti — Unicode typography helpers.
 *
 * Mixed-typeface design for the statusline. Real magazines use 2–3 fonts
 * to create visual hierarchy without saying "look at me." We do the same
 * thing in a terminal using Unicode's Mathematical Alphanumeric Symbols
 * block (U+1D400+) and Latin Extended-D — both are present in every
 * modern terminal font (SF Mono, Cascadia, JetBrains Mono, Hack, Iosevka,
 * Menlo). No font configuration needed.
 *
 * Type system:
 *   - smallCaps()    : project names — quietly distinguished, not shouty
 *   - italicMath()   : ephemeral words ("today", "now") — soft, transient
 *   - boldMath()     : reserved for emphasis (currently unused)
 *
 * Pixar magazine rule: never more than 3 typefaces in one composition.
 * We use 2: small-caps for identification, italic for ephemerality.
 */

const SMALL_CAPS_MAP: Record<string, string> = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ",
  i: "ɪ", j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ",
  q: "ǫ", r: "ʀ", s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x",
  y: "ʏ", z: "ᴢ",
};

/**
 * Convert ASCII letters to small caps (Latin Extended-D + IPA Extensions).
 * Numbers, hyphens, slashes, and uppercase letters pass through unchanged.
 *
 *   smallCaps("tokmeter")     → "ᴛᴏᴋᴍᴇᴛᴇʀ"
 *   smallCaps("auth-service") → "ᴀᴜᴛʜ-sᴇʀᴠɪᴄᴇ"
 */
export function smallCaps(s: string): string {
  let out = "";
  for (const ch of s) {
    out += SMALL_CAPS_MAP[ch.toLowerCase()] ?? ch;
  }
  return out;
}

/**
 * Convert ASCII letters to mathematical italic (U+1D434 / U+1D44E).
 * Used for ephemeral labels — "today", "now", "stale". The italic
 * implies "this is contextual / changing", not a permanent identifier.
 *
 * Numbers and symbols pass through unchanged so the surrounding cost
 * stays readable.
 *
 *   italicMath("today") → "𝑡𝑜𝑑𝑎𝑦"
 *   italicMath("now")   → "𝑛𝑜𝑤"
 */
export function italicMath(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    // Lowercase a-z → 𝑎-𝑧 (U+1D44E..U+1D467, with h at U+210E)
    if (code >= 0x61 && code <= 0x7a) {
      // 'h' is a special case — its math italic is at U+210E (Planck constant)
      // because U+1D455 is reserved as undefined.
      if (code === 0x68) {
        out += "ℎ";
      } else {
        out += String.fromCodePoint(0x1d44e + (code - 0x61));
      }
    }
    // Uppercase A-Z → 𝐴-𝑍 (U+1D434..U+1D44D)
    else if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCodePoint(0x1d434 + (code - 0x41));
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Convert ASCII letters to mathematical bold (U+1D400 / U+1D41A).
 * Reserved for hero emphasis — currently unused in default rendering
 * but available for theme variants that want a heavier title weight.
 */
export function boldMath(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x61 && code <= 0x7a) {
      out += String.fromCodePoint(0x1d41a + (code - 0x61));
    } else if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCodePoint(0x1d400 + (code - 0x41));
    } else {
      out += ch;
    }
  }
  return out;
}
