#!/usr/bin/env python3
"""Independent per-day token ledger for Claude Code JSONL transcripts.

Zero tokmeter imports. Walks a Claude Code `projects` directory (including nested
`subagents/*.jsonl`), dedups assistant turns by `message.id` across all files
(keeping the earliest valid timestamp and the max per usage bucket), and clamps
`cache_creation.ephemeral_1h_input_tokens` to `cache_creation_input_tokens`.

Usage: claude_oracle.py PROJECTS_DIR [PROJECTS_DIR ...]
Prints JSON {"totals": {...}, "days": {"YYYY-MM-DD": {...}}}.
"""

import datetime
import json
import os
import sys


def parse_timestamp(ts_value, fallback_epoch_s):
    if isinstance(ts_value, str) and ts_value:
        try:
            iso = ts_value[:-1] + "+00:00" if ts_value.endswith("Z") else ts_value
            dt = datetime.datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            epoch_ms = dt.timestamp() * 1000.0
            day = dt.astimezone().strftime("%Y-%m-%d")
            return epoch_ms, day
        except ValueError:
            pass
    dt = datetime.datetime.fromtimestamp(fallback_epoch_s).astimezone()
    return fallback_epoch_s * 1000.0, dt.strftime("%Y-%m-%d")


def empty_bucket():
    return {
        "calls": 0,
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "cacheWrite1h": 0,
    }


def add_bucket(dst, src):
    dst["calls"] += 1
    dst["input"] += src["input"]
    dst["output"] += src["output"]
    dst["cacheRead"] += src["cacheRead"]
    dst["cacheWrite"] += src["cacheWrite"]
    dst["cacheWrite1h"] += src["cacheWrite1h"]


def scan_projects(roots):
    by_id = {}
    anonymous = []

    for root in sorted(roots):
        if not os.path.isdir(root):
            continue
        jsonl_files = []
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.endswith(".jsonl"):
                    jsonl_files.append(os.path.join(dirpath, name))
        for path in sorted(jsonl_files):
            try:
                file_mtime = os.stat(path).st_mtime
            except OSError:
                continue
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line_no, raw in enumerate(fh, 1):
                    if '"assistant"' not in raw or '"usage"' not in raw:
                        continue
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("type") != "assistant":
                        continue
                    msg = obj.get("message")
                    if not isinstance(msg, dict):
                        continue
                    usage = msg.get("usage")
                    if not isinstance(usage, dict):
                        continue

                    ts_ms, day = parse_timestamp(obj.get("timestamp"), file_mtime)
                    inp = int(usage.get("input_tokens") or 0)
                    out = int(usage.get("output_tokens") or 0)
                    cread = int(usage.get("cache_read_input_tokens") or 0)
                    cwrite = int(usage.get("cache_creation_input_tokens") or 0)
                    cc = usage.get("cache_creation")
                    raw_1h = int(cc.get("ephemeral_1h_input_tokens") or 0) if isinstance(cc, dict) else 0
                    c1h = min(raw_1h, cwrite)

                    row = {
                        "ts_ms": ts_ms,
                        "day": day,
                        "input": inp,
                        "output": out,
                        "cacheRead": cread,
                        "cacheWrite": cwrite,
                        "cacheWrite1h": c1h,
                    }
                    msg_id = msg.get("id")
                    if isinstance(msg_id, str) and msg_id:
                        existing = by_id.get(msg_id)
                        if existing is None:
                            by_id[msg_id] = row
                        else:
                            if row["ts_ms"] < existing["ts_ms"]:
                                existing["ts_ms"] = row["ts_ms"]
                                existing["day"] = row["day"]
                            existing["input"] = max(existing["input"], row["input"])
                            existing["output"] = max(existing["output"], row["output"])
                            existing["cacheRead"] = max(existing["cacheRead"], row["cacheRead"])
                            existing["cacheWrite"] = max(existing["cacheWrite"], row["cacheWrite"])
                            existing["cacheWrite1h"] = min(
                                max(existing["cacheWrite1h"], row["cacheWrite1h"]),
                                existing["cacheWrite"],
                            )
                    else:
                        anonymous.append((path, line_no, row))

    totals = empty_bucket()
    days = {}
    all_rows = list(by_id.values()) + [r for _, _, r in anonymous]
    for r in all_rows:
        add_bucket(totals, r)
        d = days.setdefault(r["day"], empty_bucket())
        add_bucket(d, r)

    return {"totals": totals, "days": dict(sorted(days.items()))}


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: claude_oracle.py PROJECTS_DIR [PROJECTS_DIR ...]\n")
        sys.exit(2)
    report = scan_projects(sys.argv[1:])
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
