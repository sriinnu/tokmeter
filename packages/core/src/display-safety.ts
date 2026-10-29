const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = String.fromCharCode(155);
// Linear: the body excludes ESC and BEL and the terminator is optional, so a
// match never rescans text. The old `[^BEL]*(?:BEL|ESC\\)` form retried the
// whole remaining input from every unterminated `ESC ]` — quadratic, ~8s on a
// 96 KB label. An unterminated OSC (which a terminal would also swallow) now
// loses its body up to the next ESC/BEL instead of leaking it as text.
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "gu");
const CSI_PATTERN = new RegExp(`(?:${ESC}\\[|${CSI})[0-?]*[ -/]*[@-~]`, "gu");
const ESCAPE_PATTERN = new RegExp(`${ESC}[@-_]`, "gu");

/**
 * Make provider-controlled labels safe to render in terminals, logs, and MCP
 * text. Token records can contain model output, repository names, and imported
 * aliases; none of those may emit terminal controls or direction overrides.
 */
export function sanitizeDataLabel(value: unknown, maxLength = 512): string {
  if (typeof value !== "string") return "";

  // Never run the patterns over more input than could matter: the result is
  // at most `maxLength` code points, and escape sequences only shrink it.
  // Generous headroom keeps ordinary labels with escapes intact; a label
  // padded far beyond that is cut before any regex work.
  const bounded =
    value.length > maxLength * 8 + 1024 ? value.slice(0, maxLength * 8 + 1024) : value;

  const withoutEscapes = bounded
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();

  return [...withoutEscapes].slice(0, Math.max(0, maxLength)).join("");
}
