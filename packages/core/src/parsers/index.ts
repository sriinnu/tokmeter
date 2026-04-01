/**
 * @sriinnu/tokmeter-core — Parser registry and index.
 */

import type { ProviderId, SessionParser } from "../types.js";
import { AmpParser } from "./amp.js";
import { ClaudeCodeParser } from "./claude-code.js";
import { CodexParser } from "./codex.js";
import { CursorParser } from "./cursor.js";
import { DroidParser } from "./droid.js";
import { GeminiParser } from "./gemini.js";
import { KiloCliParser } from "./kilo-cli.js";
import { KiloParser } from "./kilo.js";
import { KimiParser } from "./kimi.js";
import { MuxParser } from "./mux.js";
import { OpenClawParser } from "./openclaw.js";
import { OpenCodeParser } from "./opencode.js";
import { PiParser } from "./pi.js";
import { QwenParser } from "./qwen.js";
import { RooCodeParser } from "./roo-code.js";
import { SyntheticParser } from "./synthetic.js";

/** All available parsers. */
export const ALL_PARSERS: SessionParser[] = [
  new ClaudeCodeParser(),
  new OpenCodeParser(),
  new CodexParser(),
  new GeminiParser(),
  new CursorParser(),
  new AmpParser(),
  new DroidParser(),
  new OpenClawParser(),
  new PiParser(),
  new KimiParser(),
  new QwenParser(),
  new RooCodeParser(),
  new KiloParser(),
  new KiloCliParser(),
  new MuxParser(),
  new SyntheticParser(),
];

/** Get a parser by provider ID. */
export function getParser(id: ProviderId): SessionParser | undefined {
  return ALL_PARSERS.find((p) => p.providerId === id);
}

/** Get parsers for specific provider IDs (or all if none specified). */
export function getParsers(ids?: ProviderId[]): SessionParser[] {
  if (!ids || ids.length === 0) return ALL_PARSERS;
  return ALL_PARSERS.filter((p) => ids.includes(p.providerId));
}

/** All valid provider IDs. */
export const ALL_PROVIDER_IDS: ProviderId[] = ALL_PARSERS.map((p) => p.providerId);
