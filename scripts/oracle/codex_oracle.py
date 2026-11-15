#!/usr/bin/env python3
"""Independent Codex token ledger, straight from the raw rollouts.

AGENTS.md: never validate tokmeter with tokmeter. This script shares no code
with packages/core. It reads rollout-*.jsonl and rollout-*.jsonl.zst under a
Codex home and applies the counting rules Codex's own format implies:

  * one record per response: `token_usage_record` events, deduped on
    `response_id`, owned by this rollout's thread only;
  * older turns without receipts: `event_msg/token_count` cumulative totals,
    turned into per-step deltas (or `last_token_usage` when no total exists);
  * a turn that has receipts never also counts its legacy counters;
  * a counter written after a `compacted` carry-over and before the rollout's
    first `task_started` is inherited from the previous rollout: a baseline,
    not usage;
  * buckets are exclusive: input excludes cached input, output excludes
    reasoning (Codex reports both as sub-buckets);
  * resumed sessions replay their ancestors, so each fork family counts one
    file, the largest by content; subagent threads are disjoint and always
    count on their own.

Output (JSON on stdout): per-day totals in local time, per-model totals per
day, a sorted list of per-response rows, and counts of every line skipped and
why, so a disagreement can be traced to a line.

  python3 -I scripts/oracle/codex_oracle.py --codex-home <dir> [--day YYYY-MM-DD ...]
          [--since-ms <ms>] [--rows]

--since-ms mirrors a today refresh: only files with an event at/after it are
selected BEFORE fork dedup. Without it, every file on disk is considered.
Run it on a copy (APFS: cp -cR), never on a Codex home that is being written.
"""

import argparse
import datetime as dt
import json
import math
import os
import sys
from collections import defaultdict

try:
    from compression import zstd  # Python 3.14+
except ImportError:  # pragma: no cover
    zstd = None

MAX_LINE = 8 * 1024 * 1024  # tokmeter skips longer lines; usage lines are tiny
HEAD_BYTES = 65_536
BUCKETS = ("input", "cached", "output", "reasoning")


# ── reading ──────────────────────────────────────────────────────────────────


def read_text(path):
    """Whole decompressed content of a rollout, and whether it was compressed."""
    with open(path, "rb") as f:
        raw = f.read()
    if path.endswith(".zst"):
        if zstd is None:
            raise RuntimeError("no zstd in this Python")
        return zstd.decompress(raw), True
    return raw, False


def lines_of(data, compressed, skips):
    """Yield complete lines. A plain file's unterminated last line counts only
    if it already parses as JSON (otherwise a writer is mid-line); a
    decompressed stream's last line always counts."""
    parts = data.split(b"\n")
    last = parts.pop()  # after the final newline: b"" when terminated
    for p in parts:
        if len(p) > MAX_LINE:
            skips["oversized"] += 1
            continue
        yield p
    if last.strip():
        if len(last) > MAX_LINE:
            skips["oversized"] += 1
        elif compressed:
            yield last
        else:
            try:
                json.loads(last)
                yield last
            except ValueError:
                skips["in_flight_tail"] += 1


def file_head_meta(path):
    """(session id, forked-from id, is subagent) from the FIRST session_meta
    in the first 20 lines of the first 64 KB."""
    try:
        if path.endswith(".zst"):
            data = read_text(path)[0][:HEAD_BYTES]
        else:
            with open(path, "rb") as f:
                data = f.read(HEAD_BYTES)
    except OSError:
        return path, None, False
    for line in data.split(b"\n")[:20]:
        if not line.strip():
            continue
        try:
            evt = json.loads(line)
        except ValueError:
            continue
        if isinstance(evt, dict) and evt.get("type") == "session_meta" and isinstance(evt.get("payload"), dict):
            p = evt["payload"]
            return (p.get("id") or path), p.get("forked_from_id"), is_subagent(p)
    return path, None, False


def is_subagent(p):
    src = p.get("source")
    return (
        p.get("thread_source") == "subagent"
        or (isinstance(p.get("parent_thread_id"), str) and len(p["parent_thread_id"]) > 0)
        or (isinstance(src, dict) and "subagent" in src)
    )


def content_size(path):
    if path.endswith(".zst"):
        return len(read_text(path)[0])
    return os.stat(path).st_size


def newest_event_ms(path):
    """Newest event time from the last 64 KB of a plain rollout; None if unknown."""
    if path.endswith(".zst"):
        return None
    size = os.stat(path).st_size
    if size == 0:
        return None
    with open(path, "rb") as f:
        f.seek(max(0, size - HEAD_BYTES))
        tail = f.read()
    for line in reversed([l for l in tail.split(b"\n") if l.strip()]):
        try:
            evt = json.loads(line)
        except ValueError:
            continue
        t = parse_ts(evt.get("timestamp")) if isinstance(evt, dict) else None
        if t is not None:
            return t
    return None


# ── selection ────────────────────────────────────────────────────────────────


def find_rollouts(codex_home):
    out = []
    for sub in ("sessions", "archived_sessions"):
        root = os.path.join(codex_home, sub)
        base_depth = root.rstrip("/").count("/")
        for dirpath, dirnames, filenames in os.walk(root):
            # tokmeter walks 5 levels below the root (YYYY/MM/DD/file is 4).
            if dirpath.count("/") - base_depth >= 4:
                dirnames[:] = []
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            for name in filenames:
                full = os.path.join(dirpath, name)
                if os.path.islink(full):
                    continue
                if name.endswith(".jsonl") or name.endswith(".jsonl.zst"):
                    out.append(full)
    return sorted(set(out))


def dedup_forks(files):
    metas = []
    for f in files:
        sid, parent, sub = file_head_meta(f)
        try:
            st = os.stat(f)
            mtime = st.st_mtime_ns
        except OSError:
            mtime = 0
        metas.append({"file": f, "sid": sid, "parent": parent, "sub": sub, "size": content_size(f), "mtime": mtime})
    by_sid = {m["sid"]: m for m in metas}

    def root_of(m):
        cur, seen = m, set()
        while cur.get("parent"):
            if cur["sid"] in seen:
                break
            seen.add(cur["sid"])
            par = by_sid.get(cur["parent"])
            if par is None:
                return cur["parent"]
            if par["sub"]:
                return par["sid"]
            cur = par
        return cur["sid"]

    winners = {}
    for m in metas:
        key = m["sid"] if m["sub"] else root_of(m)
        w = winners.get(key)
        if w is None or m["size"] > w["size"] or (m["size"] == w["size"] and m["mtime"] > w["mtime"]):
            winners[key] = m
    return [w["file"] for w in winners.values()]


# ── folding ──────────────────────────────────────────────────────────────────


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def complete_usage(u):
    if not isinstance(u, dict):
        return False
    for k in ("input_tokens", "output_tokens"):
        if num(u.get(k)) is None or u[k] < 0:
            return False
    for k in ("cached_input_tokens", "reasoning_output_tokens"):
        if k in u and (num(u[k]) is None or u[k] < 0):
            return False
    return True


def g(u, k):
    v = num(u.get(k)) if isinstance(u, dict) else None
    return v or 0


def fold_file(path, skips):
    data, compressed = read_text(path)
    sid = None
    sub = False
    model = "unknown"
    cwd = ""
    turn = "unscoped"
    task_started = False
    saw_compacted = False
    prev = {}  # the previous LEGACY total: the token_count series is differenced only against itself
    prev_total = prev_last = None  # the previous token_count as written, to spot an exact repeat
    response_ids = set()
    receipt_turns = set()
    rows = []  # (row, legacy_turn or None)
    info_out = {
        "receipts": {},  # every complete receipt on disk in this file: id -> (thread, tokens)
        "final_total": None,  # last legacy cumulative total, buckets as the oracle counts them
        "baseline": None,  # inherited baseline total, if any
        "step_repeats": 0,  # the same total and last usage written again
        "step_checks": 0,  # legacy steps whose delta could be checked against last_token_usage
        "step_mismatches": [],  # (ts, delta, last) where they disagree
        "resets": 0,  # legacy totals that went down (a resumed counter)
        "has_receipts": False,
    }

    for line in lines_of(data, compressed, skips):
        if not line.strip():
            continue
        try:
            evt = json.loads(line.decode("utf-8", errors="replace"))
        except ValueError:
            skips["malformed"] += 1
            continue
        if not isinstance(evt, dict) or not evt.get("type"):
            continue
        typ = evt["type"]
        p = evt.get("payload") if isinstance(evt.get("payload"), dict) else None
        if typ == "compacted" and not task_started:
            saw_compacted = True
        if typ == "session_meta" and p and p.get("id") and sid is None:
            sid, sub = p["id"], is_subagent(p)
        if typ == "session_meta" and p and p.get("cwd"):
            cwd = p["cwd"]
        if typ == "turn_context" and p and p.get("model"):
            model = p["model"]
        if p is None:
            continue
        ptype = p.get("type")
        if (typ == "turn_context" or (typ == "event_msg" and ptype == "task_started")) and p.get("turn_id"):
            turn = p["turn_id"]
        if typ == "event_msg" and ptype == "task_started":
            task_started = True

        receipt = typ == "token_usage_record"
        if receipt:
            if not complete_usage(p.get("usage")):
                continue
            info_out["has_receipts"] = True
            if p.get("response_id"):
                info_out["receipts"].setdefault(p["response_id"], (p.get("thread_id"), usage_tokens(p["usage"])))
            if sid and p.get("thread_id") and p["thread_id"] != sid:
                skips["other_thread_receipt"] += 1
                continue
            receipt_turns.add(p.get("turn_id") or turn)
            rid = p.get("response_id")
            if rid:
                if rid in response_ids:
                    skips["duplicate_response_id"] += 1
                    continue
                response_ids.add(rid)
            u = p["usage"]
        else:
            if typ != "event_msg" or ptype != "token_count":
                continue
            info = p.get("info")
            if not isinstance(info, dict):
                continue
            total = info.get("total_token_usage")
            # A total with no numbers is no counter at all (JS treats {} as one).
            if not (isinstance(total, dict) and any(num(total.get(k)) is not None for k in COUNTER_KEYS)):
                total = None
            if total and not task_started and saw_compacted:
                # Restored with the compaction, not a new call: Codex writes this
                # total within milliseconds of `compacted` (2026-11-15: 0-2 ms on
                # all 52 real cases), even when it equals last_token_usage.
                prev = dict(total)
                prev_total, prev_last = total, info.get("last_token_usage")
                info_out["baseline"] = usage_tokens(total)
                skips["inherited_baseline"] += 1
                continue
            last = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else None
            if total:
                if g(total, "input_tokens") < g(prev, "input_tokens"):
                    # The counter went down: a resumed process restarted it. What
                    # follows the reset is new usage, counted from zero.
                    info_out["resets"] += 1
                    prev = {}
                u = {k: max(0, g(total, k) - g(prev, k)) for k in COUNTER_KEYS}
                repeat = last is not None and total == prev_total and last == prev_last
                if repeat:
                    # Codex sometimes writes the same total and last usage twice
                    # (789 of 26,849 real steps, 2026-11-15): nothing new, a delta of zero.
                    info_out["step_repeats"] += 1
                elif last is not None:
                    # Rule-free: the step's own usage, written beside the total,
                    # must equal the delta we derived. A missed restart, a clamp or
                    # a wrong baseline shows up here.
                    info_out["step_checks"] += 1
                    if any(g(u, k) != g(last, k) for k in ("input_tokens", "output_tokens")):
                        info_out["step_mismatches"].append((evt.get("timestamp"), usage_tokens(u), usage_tokens(last)))
                prev = dict(total)
                prev_total, prev_last = total, last
                info_out["final_total"] = usage_tokens(total)
            elif last is not None:
                # No total, only this step's usage: count it, and move the running
                # total on by it, so a later cumulative total doesn't count it again.
                u = last
                prev = {k: g(prev, k) + g(last, k) for k in COUNTER_KEYS}
            else:
                continue

        cached = g(u, "cached_input_tokens")
        inp = max(0, g(u, "input_tokens") - cached)
        raw_out = g(u, "output_tokens")
        reasoning = min(g(u, "reasoning_output_tokens"), raw_out)
        out = raw_out - reasoning
        if inp == 0 and out == 0 and cached == 0 and reasoning == 0:
            continue
        ts = parse_ts(evt.get("timestamp"))
        if ts is None:
            skips["no_timestamp"] += 1
            st = os.stat(path)
            ts = int((getattr(st, "st_birthtime", 0) or st.st_mtime) * 1000)
        row = {
            "file": path,
            "ts": ts,
            "model": model,
            "cwd": cwd,
            "input": int(inp),
            "cached": int(cached),
            "output": int(out),
            "reasoning": int(reasoning),
            "response_id": (p.get("response_id") if receipt else None),
            "subagent": sub,
        }
        rows.append((row, None if receipt else (p.get("turn_id") or turn), (p.get("turn_id") or turn) if receipt else None))

    kept = []
    receipt_sum, dropped_sum = defaultdict(int), defaultdict(int)
    for row, legacy_turn, receipt_turn in rows:
        if receipt_turn is not None:
            receipt_sum[receipt_turn] += row_tokens(row)
        if legacy_turn is not None and legacy_turn in receipt_turns:
            skips["legacy_turn_with_receipts"] += 1
            dropped_sum[legacy_turn] += row_tokens(row)
            continue
        kept.append(row)
    # Rule-free: a turn's dropped legacy counters saw that turn's work too. If
    # they add up to more than its receipts, the receipts missed some of it.
    info_out["receipt_turns_short"] = [
        (t, receipt_sum[t], n) for t, n in dropped_sum.items() if n > receipt_sum[t]
    ]
    return kept, info_out


COUNTER_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens")


def usage_tokens(u):
    """Total tokens of a usage object in the oracle's exclusive buckets."""
    cached = g(u, "cached_input_tokens")
    inp = max(0, g(u, "input_tokens") - cached)
    raw_out = g(u, "output_tokens")
    return int(inp + cached + raw_out)


def row_tokens(r):
    return r["input"] + r["cached"] + r["output"] + r["reasoning"]


def local_day(ms):
    return dt.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codex-home", required=True)
    ap.add_argument("--day", action="append", default=[])
    ap.add_argument("--since-ms", type=int)
    ap.add_argument("--rows", action="store_true")
    a = ap.parse_args()

    files = find_rollouts(a.codex_home)
    if a.since_ms is not None:
        keep = []
        for f in files:
            if os.stat(f).st_mtime * 1000 < a.since_ms:
                continue
            t = newest_event_ms(f)
            if t is None or t >= a.since_ms:
                keep.append(f)
        files = keep
    winners = set(dedup_forks(files))

    skips = defaultdict(int)
    all_rows = []
    infos = {}
    for f in sorted(files):
        # Every selected file is folded, winner or not, so the rule-free
        # cross-checks below see what fork dedup threw away.
        try:
            rows, info = fold_file(f, defaultdict(int) if f not in winners else skips)
        except (OSError, RuntimeError) as e:
            skips["unreadable_file"] += 1
            print(f"unreadable: {f}: {e}", file=sys.stderr)
            continue
        infos[f] = info
        if f in winners:
            all_rows.extend(rows)

    # One record per API response, across files too (AGENTS.md): a response
    # id that two counted files both carry is one response.
    seen_ids, deduped = set(), []
    for r in sorted(all_rows, key=lambda r: (r["file"], r["ts"])):
        rid = r["response_id"]
        if rid and rid in seen_ids:
            skips["duplicate_response_id_across_files"] += 1
            continue
        if rid:
            seen_ids.add(rid)
        deduped.append(r)
    all_rows = deduped

    # ── rule-free cross-checks ──
    # These use none of the counting rules above, so a rule that loses or
    # double-counts work shows up here even when tokmeter shares the rule.
    # 1. Every response id written anywhere on disk should be counted once.
    on_disk = {}
    for f, info in infos.items():
        for rid, (thread, tok) in info["receipts"].items():
            on_disk.setdefault(rid, tok)
    counted = {r["response_id"] for r in all_rows if r["response_id"]}
    missing = sorted(set(on_disk) - counted)
    # 2. A legacy-only winner's rows should add up to its last cumulative total
    #    (minus an inherited baseline), when its counter never reset.
    legacy_mismatch = []
    by_file = defaultdict(int)
    for r in all_rows:
        by_file[r["file"]] += row_tokens(r)
    for f in winners:
        info = infos.get(f)
        if not info or info["has_receipts"] or info["final_total"] is None or info["resets"]:
            continue
        want = info["final_total"] - (info["baseline"] or 0)
        if by_file[f] != want:
            legacy_mismatch.append({"file": f, "counted": by_file[f], "final_total_minus_baseline": want})
    # 3. An inherited baseline should equal some other rollout's last total.
    finals = {info["final_total"] for info in infos.values() if info["final_total"] is not None}
    unverified = [f for f, info in infos.items() if info["baseline"] is not None and info["baseline"] not in finals]
    cross = {
        "response_ids_on_disk": len(on_disk),
        "response_ids_not_counted": len(missing),
        "tokens_not_counted": sum(on_disk[r] for r in missing),
        "not_counted_sample": missing[:10],
        "legacy_files_not_matching_final_total": legacy_mismatch[:20],
        "legacy_counter_resets": sum(i["resets"] for i in infos.values() if True),
        "inherited_baselines": sum(1 for i in infos.values() if i["baseline"] is not None),
        "inherited_baselines_unverified": unverified[:20],
        "legacy_steps_checked": sum(i["step_checks"] for i in infos.values()),
        "legacy_steps_repeated": sum(i["step_repeats"] for i in infos.values()),
        "legacy_steps_not_matching_own_usage": sum(len(i["step_mismatches"]) for i in infos.values()),
        "legacy_step_mismatch_sample": [(f, m) for f, i in infos.items() for m in i["step_mismatches"]][:10],
        "receipt_turns_short_of_legacy": sum(len(i["receipt_turns_short"]) for i in infos.values()),
        "receipt_turns_short_tokens": sum(n - r for i in infos.values() for _, r, n in i["receipt_turns_short"]),
        "receipt_turns_short_sample": [(f, t) for f, i in infos.items() for t in i["receipt_turns_short"]][:10],
        "assumed_rules": [
            "fork families count only their largest file",
            "a subagent thread counts on its own",
            "a receipt counts only in its own thread's file, and once per response id across all files",
            "legacy counters of a turn that has receipts are dropped",
            "a counter written after `compacted`, before the first task_started, is inherited",
            "a legacy total that goes down restarts the counter from zero",
        ],
    }

    days = set(a.day)
    if days:
        all_rows = [r for r in all_rows if local_day(r["ts"]) in days]

    per_day = defaultdict(lambda: dict.fromkeys(BUCKETS + ("records",), 0))
    per_day_model = defaultdict(lambda: defaultdict(lambda: dict.fromkeys(BUCKETS + ("records",), 0)))
    for r in all_rows:
        d = local_day(r["ts"])
        for tgt in (per_day[d], per_day_model[d][r["model"]]):
            for b in BUCKETS:
                tgt[b] += r[b]
            tgt["records"] += 1

    # Fingerprint-collision census: rows tokmeter's aggregate fingerprint
    # (aggregates.ts recordFingerprint: no response id) would treat as one.
    # cwd stands in for project; two cwds can share a project, so this is a
    # lower bound.
    fp = defaultdict(int)
    for r in all_rows:
        fp[(r["ts"], r["model"], r["cwd"], r["input"], r["cached"], r["output"], r["reasoning"])] += 1
    collisions = sum(n - 1 for n in fp.values() if n > 1)

    out = {
        "files_considered": len(files),
        "files_counted": len(winners),
        "days": dict(sorted(per_day.items())),
        "models": {d: dict(sorted(m.items())) for d, m in sorted(per_day_model.items())},
        "skipped": dict(sorted(skips.items())),
        "cross_checks": cross,
        "same_ms_equal_count_rows": collisions,
    }
    if a.rows:
        out["rows"] = sorted(all_rows, key=lambda r: (r["file"], r["ts"], r["response_id"] or ""))
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
