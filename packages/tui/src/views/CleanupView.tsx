/**
 * tokmeter-tui — Cleanup tab (tab 5).
 *
 * Phases: browse → preview → confirm → done
 * Multi-select projects, provider filter chips, type DELETE to confirm.
 */

import {
  type CleanupPreview,
  type CleanupResult,
  CleanupService,
  type ProjectSummary,
  type TokmeterCore,
} from "@sriinnu/tokmeter-core";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { T } from "../theme.js";

// ─── Formatters ──────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function shortPath(filePath: string, segmentCount = 2): string {
  return filePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-segmentCount)
    .join("/");
}

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_VISIBLE = 20;
const DELETE_WORD = "DELETE";

// ─── Types ───────────────────────────────────────────────────────────────

type Phase = "browse" | "preview" | "confirm" | "executing" | "done" | "error";

interface CleanupViewProps {
  core: TokmeterCore;
  projects: ProjectSummary[];
  onRefresh: () => Promise<void>;
}

// ─── Component ───────────────────────────────────────────────────────────

export function CleanupView({ core, projects: incomingProjects, onRefresh }: CleanupViewProps) {
  const [phase, setPhase] = useState<Phase>("browse");
  const [projects, setProjects] = useState<ProjectSummary[]>(incomingProjects);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [doBackup, setDoBackup] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    setProjects(incomingProjects);
  }, [incomingProjects]);

  // Stable identity for selectedProjects so useCallback deps don't churn.
  const selectedProjects = useMemo(
    () => projects.filter((_, i) => selected.has(i)),
    [projects, selected]
  );
  const totalCost = selectedProjects.reduce((s, p) => s + p.totalCost, 0);
  const totalTokens = selectedProjects.reduce((s, p) => s + p.totalTokens, 0);

  const runPreview = useCallback(async () => {
    if (selectedProjects.length === 0) return;
    try {
      const service = new CleanupService(core);
      const nextPreview = await service.preview({
        projects: selectedProjects.map((project) => project.project),
      });

      setPreview(nextPreview);
      setPhase("preview");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [core, selectedProjects]);

  const runCleanup = useCallback(async () => {
    setPhase("executing");
    try {
      const service = new CleanupService(core);
      const nextResult = await service.execute(
        { projects: selectedProjects.map((project) => project.project) },
        { backup: doBackup }
      );

      setResult(nextResult);
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [core, selectedProjects, doBackup]);

  // Scroll cursor into view
  useEffect(() => {
    if (cursor < scrollOffset) setScrollOffset(cursor);
    else if (cursor >= scrollOffset + MAX_VISIBLE) setScrollOffset(cursor - MAX_VISIBLE + 1);
  }, [cursor, scrollOffset]);

  useInput((input, key) => {
    if (phase === "browse") {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(projects.length - 1, c + 1));
      if (input === " ") {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
      }
      if (input === "a") {
        if (selected.size === projects.length) setSelected(new Set());
        else setSelected(new Set(projects.map((_, i) => i)));
      }
      if (key.return && selected.size > 0) runPreview();
    }

    if (phase === "preview") {
      if (key.escape) {
        setPhase("browse");
        setPreview(null);
      }
      if (input === "b") setDoBackup((v) => !v);
      if (key.return) {
        setConfirmText("");
        setPhase("confirm");
      }
    }

    if (phase === "confirm") {
      if (key.escape) setPhase("preview");
      if (key.backspace || key.delete) {
        setConfirmText((t) => t.slice(0, -1));
      } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
        // Clamp to DELETE length to prevent overtype
        if (confirmText.length < DELETE_WORD.length) {
          const next = confirmText + input;
          setConfirmText(next);
          if (next === DELETE_WORD) runCleanup();
        }
      }
    }

    if (phase === "done" || phase === "error") {
      if (key.return || key.escape) {
        setPhase("browse");
        setSelected(new Set());
        setPreview(null);
        setResult(null);
        setConfirmText("");
        setErrorMsg("");
        // Reset cursor + scroll so we never point past the (likely smaller) list.
        setCursor(0);
        setScrollOffset(0);
        // Re-scan; surface failure to the error phase instead of swallowing.
        void onRefresh().catch((refreshError) => {
          setErrorMsg(
            `Re-scan failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
          );
          setPhase("error");
        });
      }
    }
  });

  // ─── Browse Phase ──────────────────────────────────────────

  if (phase === "browse") {
    if (projects.length === 0) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color={T.accent}>
            ━━ Cleanup ━━
          </Text>
          <Text color={T.muted}> No projects found. Use an AI coding agent first.</Text>
        </Box>
      );
    }

    const visible = projects.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
    const showScrollUp = scrollOffset > 0;
    const showScrollDown = scrollOffset + MAX_VISIBLE < projects.length;

    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color={T.accent}>
            ━━ Cleanup ━━
          </Text>
          <Text color={T.muted}> Space:toggle a:all Enter:preview</Text>
        </Box>

        <Box flexDirection="row" marginBottom={1}>
          <Text color={T.muted}>
            {"  Project".padEnd(26)}
            {"Provider".padEnd(14)}
            {"Tokens".padEnd(10)}
            {"Cost".padEnd(10)}
            {"Days".padEnd(6)}
            {"Last Used"}
          </Text>
        </Box>

        {showScrollUp && <Text color={T.muted}> ↑ {scrollOffset} more above</Text>}

        {visible.map((p, vi) => {
          const i = vi + scrollOffset; // Real index
          const isSelected = selected.has(i);
          const isCursor = i === cursor;
          const providers = p.providers.map((pr) => pr.provider).join(",");
          const lastUsed = p.lastUsed ? new Date(p.lastUsed).toISOString().slice(0, 10) : "—";

          return (
            <Box key={p.project} flexDirection="row">
              <Text color={isCursor ? T.accent : undefined} inverse={isCursor}>
                {isSelected ? " [✓] " : " [ ] "}
                {p.project.slice(0, 22).padEnd(22)}
                {providers.slice(0, 12).padEnd(14)}
                {fmtNum(p.totalTokens).padEnd(10)}
                {fmtCost(p.totalCost).padEnd(10)}
                {String(p.activeDays).padEnd(6)}
                {lastUsed}
              </Text>
            </Box>
          );
        })}

        {showScrollDown && (
          <Text color={T.muted}> ↓ {projects.length - scrollOffset - MAX_VISIBLE} more below</Text>
        )}

        {selected.size > 0 && (
          <Box marginTop={1}>
            <Text color={T.warn}>
              {selected.size} selected — {fmtCost(totalCost)} — {fmtNum(totalTokens)} tokens
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ─── Preview Phase ─────────────────────────────────────────

  if (phase === "preview" && preview) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color={T.accent}>
            ━━ Cleanup Preview ━━
          </Text>
          <Text color={T.muted}> Enter:confirm b:backup({doBackup ? "on" : "off"}) Esc:back</Text>
        </Box>

        <Text>
          {" "}
          Records: {fmtNum(preview.recordCount)} | Files: {preview.sourceFileCount} | Size:{" "}
          {fmtBytes(preview.totalBytes)}
        </Text>
        <Text> </Text>

        {preview.byProvider.map((p) => (
          <Text key={p.provider}>
            {"  "}
            {p.provider.padEnd(16)}
            {String(p.targets).padEnd(8)}files {fmtBytes(p.bytes).padEnd(8)} {p.records} records
          </Text>
        ))}

        {preview.partialFileWarnings.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={T.danger} bold>
              {" "}
              ⚠ PARTIAL FILE WARNINGS:
            </Text>
            {preview.partialFileWarnings.slice(0, 5).map((w) => (
              <Text key={w.file} color={T.warn}>
                {"    "}
                {shortPath(w.file)}: {w.matchedRecords} matched, {w.otherRecords} others (
                {w.otherDateRange}) will also go
              </Text>
            ))}
            {preview.partialFileWarnings.length > 5 && (
              <Text color={T.muted}> ... and {preview.partialFileWarnings.length - 5} more</Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  // ─── Confirm Phase ─────────────────────────────────────────

  if (phase === "confirm") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={T.danger}>
          ⚠ This will permanently delete {preview?.targets.length ?? 0} files (
          {fmtBytes(preview?.totalBytes ?? 0)}).
        </Text>
        {doBackup && <Text color={T.success}> 📦 Backup will be created first.</Text>}
        <Text> </Text>
        <Text>
          {" "}
          Type DELETE to confirm:{" "}
          <Text color={T.accent} bold>
            {confirmText}
          </Text>
          <Text color={T.muted}>█</Text>
        </Text>
        <Text color={T.muted}> (case-sensitive · Esc to go back)</Text>
      </Box>
    );
  }

  // ─── Executing Phase ───────────────────────────────────────

  if (phase === "executing") {
    return (
      <Box padding={1}>
        <Text color={T.accent}>🗑 Executing cleanup...</Text>
      </Box>
    );
  }

  // ─── Error Phase ───────────────────────────────────────────

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={T.danger}>
          ━━ Error ━━
        </Text>
        <Text color={T.danger}> {errorMsg}</Text>
        <Text> </Text>
        <Text color={T.muted}> Press Enter to return.</Text>
      </Box>
    );
  }

  // ─── Done Phase ────────────────────────────────────────────

  if (phase === "done" && result) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={T.success}>
          ━━ Cleanup Complete ━━
        </Text>
        <Text> </Text>
        <Text color={T.success}> ✓ Deleted: {result.deletedCount} files</Text>
        <Text> 💾 Freed: {fmtBytes(result.bytesFreed)}</Text>
        {result.backupPath && <Text> 📦 Backup: {result.backupPath}</Text>}
        {result.failedCount > 0 && <Text color={T.danger}> ✗ Failed: {result.failedCount}</Text>}
        <Text> </Text>
        <Text color={T.muted}> Press Enter to return.</Text>
      </Box>
    );
  }

  return (
    <Box padding={1}>
      <Text color={T.muted}>Loading...</Text>
    </Box>
  );
}
