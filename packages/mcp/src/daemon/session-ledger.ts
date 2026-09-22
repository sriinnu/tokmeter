/**
 * Tokmeter daemon — per-session ledger totals.
 *
 * Claude Code's statusline payload carries no session-cumulative token counts,
 * only the last API call. The warm core, however, already parses this
 * session's transcript (that is where "today" comes from). Summing the records
 * whose sourceFile is the transcript — or a subagent run nested under it —
 * gives the honest session burn: ledger-derived, never accumulated client-side.
 */

/**
 * Tokens only — deliberately no cost. Records read from the parser cache for
 * days before today keep their frozen $0/day-of cost (scan-pipeline's frozen
 * invariant), so summing record.cost across a midnight boundary would
 * understate silently. Claude Code's own session cost is the honest figure
 * for that; the bar already shows it.
 */
export interface SessionLedger {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Records folded in — a rough "API calls this session" count. */
  turns: number;
}

interface LedgerRecord {
  sourceFile?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

/**
 * Claude Code lays a session out as `<slug>/<id>.jsonl` with subagent runs at
 * `<slug>/<id>/subagents/agent-*.jsonl`. Both are this session's spend.
 */
export function belongsToTranscript(
  sourceFile: string | undefined,
  transcriptPath: string
): boolean {
  if (!sourceFile) return false;
  if (sourceFile === transcriptPath) return true;
  const stem = transcriptPath.replace(/\.jsonl$/, "");
  return stem !== transcriptPath && sourceFile.startsWith(`${stem}/`);
}

export function computeSessionLedger(
  records: readonly LedgerRecord[],
  transcriptPath: string
): SessionLedger | null {
  if (!transcriptPath) return null;
  const ledger: SessionLedger = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turns: 0,
  };
  for (const r of records) {
    if (!belongsToTranscript(r.sourceFile, transcriptPath)) continue;
    ledger.inputTokens += r.inputTokens;
    ledger.outputTokens += r.outputTokens;
    ledger.cacheReadTokens += r.cacheReadTokens;
    ledger.cacheWriteTokens += r.cacheWriteTokens;
    ledger.reasoningTokens += r.reasoningTokens ?? 0;
    ledger.turns++;
  }
  return ledger.turns > 0 ? ledger : null;
}
