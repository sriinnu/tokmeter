const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = String.fromCharCode(155);
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "gu");
const CSI_PATTERN = new RegExp(`(?:${ESC}\\[|${CSI})[0-?]*[ -/]*[@-~]`, "gu");
const ESCAPE_PATTERN = new RegExp(`${ESC}[@-_]`, "gu");

/**
 * Make provider-controlled labels safe to render in terminals, logs, and MCP
 * text. Token records can contain model output, repository names, and imported
 * aliases; none of those may emit terminal controls or direction overrides.
 */
export function sanitizeDataLabel(value: unknown, maxLength = 512): string {
  if (typeof value !== "string") return "";

  const withoutEscapes = value
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();

  return [...withoutEscapes].slice(0, Math.max(0, maxLength)).join("");
}
