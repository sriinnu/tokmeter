#!/usr/bin/env python3
"""Independent per-day token ledger for Antigravity 2.x conversation databases.

No tokmeter imports. Reads every <root>/conversations/*.db (read-only) and
totals one row per API call:

  gen_metadata.data            protobuf
    .1                         generation
      .4                       usage, summed over the calls below
      .17 (repeated)           one per API call (retries included)
        .2                     usage of that call
          .2 input (uncached)  .3 output total  .4 cache write  .5 cache read
          .9 thinking          .10 response     .11 response id
      .9.4                     start time {seconds, nanos}
      .20 (map)                "last_step_index" -> steps.idx
  steps.metadata.1             step creation time {seconds, nanos}

Output tokens are reported as the response part (.10); thinking (.9) is
its own bucket, so the two never overlap.

Rules this oracle SHARES with the parser (a bug in one of these would be in
both, and agreement can't catch it): which field is which bucket; one row
per .17 call, .4 only when there are none; dedup on response id .11; the
time is .9.4, else the step at last_step_index, else the call is skipped.

Rule-free checks, which use Antigravity's own redundant numbers instead of
those rules (printed as PROBLEM, exit 1):
  - per call, output total .3 == thinking .9 + response .10;
  - per generation, the .17 calls sum to its own total .4, every bucket;
  - every response id is unique across all databases;
  - the context-size estimate .9.10.1 tracks the last call's input + cache
    read (ratio within 0.75-1.25 for >= 90% of generations). It is
    Antigravity's own count, so it would catch cache read being a subset of
    input, or input being misread.

Fields the parser reads that this ignores: model and project (not totals).

Usage: antigravity_oracle.py [--day YYYY-MM-DD] ROOT [ROOT ...]
  ROOT is a folder holding conversations/ (e.g. ~/.gemini/antigravity).
Prints JSON {day: {calls, input, output, cacheRead, cacheWrite, reasoning}}.
"""

import datetime
import glob
import json
import os
import sqlite3
import sys
import urllib.parse


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def fields(b):
    i, out = 0, []
    while i < len(b):
        k, i = varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = varint(b, i)
        elif w == 1:
            v, i = None, i + 8
        elif w == 5:
            v, i = None, i + 4
        elif w == 2:
            n, i = varint(b, i)
            v, i = b[i : i + n], i + n
        else:
            raise ValueError("wire type %d" % w)
        out.append((f, v))
    return out


def first(fs, n):
    for f, v in fs:
        if f == n:
            return v
    return None


def every(fs, n):
    return [v for f, v in fs if f == n]


def ints(b):
    return {f: v for f, v in fields(b) if isinstance(v, int)}


def stamp(b):
    d = ints(b)
    return d.get(1, 0) + d.get(2, 0) / 1e9


def main(argv):
    day_filter = None
    if len(argv) > 1 and argv[0] == "--day":
        day_filter, argv = argv[1], argv[2:]
    totals, seen, problems, notes, ratios = {}, set(), [], [], []
    for root in argv:
        for db in sorted(glob.glob(os.path.join(os.path.expanduser(root), "conversations", "*.db"))):
            # mode=ro on a WAL database creates -shm and -wal beside it (in
            # ~/.gemini). With no live -wal the main file is complete, so open
            # it immutable, which writes nothing.
            wal = db + "-wal"
            live = os.path.exists(wal) and os.path.getsize(wal) > 0
            uri = "file:%s?%s" % (urllib.parse.quote(db), "mode=ro" if live else "immutable=1")
            con = sqlite3.connect(uri, uri=True)
            try:
                step_time = {}
                for idx, meta in con.execute("select idx, metadata from steps"):
                    if meta:
                        t = first(fields(meta), 1)
                        if t:
                            step_time[idx] = stamp(t)
                gens = con.execute("select idx, data from gen_metadata order by idx").fetchall()
            finally:
                con.close()
            for gidx, data in gens:
                gen = first(fields(data), 1)
                if gen is None:
                    continue
                g = fields(gen)
                when = None
                timing = first(g, 9)
                if timing is not None:
                    t94 = first(fields(timing), 4)
                    if t94 is not None:
                        when = stamp(t94)
                if when is None:
                    for e in every(g, 20):
                        ef = fields(e)
                        if first(ef, 1) == b"last_step_index":
                            when = step_time.get(int(first(ef, 2).decode()))
                if when is None:
                    notes.append("%s row %d: no time, not counted" % (db, gidx))
                    continue
                calls = []
                for n, c in enumerate(every(g, 17)):
                    u = first(fields(c), 2)
                    if u is not None:
                        calls.append((n, u))
                agg = first(g, 4)
                if not calls and agg is not None:
                    calls = [(0, agg)]
                summed = {}
                for n, u in calls:
                    d = ints(u)
                    for k in (2, 3, 4, 5, 9, 10):
                        summed[k] = summed.get(k, 0) + d.get(k, 0)
                    if d.get(3, 0) != d.get(9, 0) + d.get(10, 0):
                        problems.append("%s row %d call %d: output != thinking+response" % (db, gidx, n))
                    rid = first(fields(u), 11)
                    key = rid.decode() if rid else "%s:%d:%d" % (db, gidx, n)
                    if key in seen:
                        problems.append("%s row %d call %d: response id seen before" % (db, gidx, n))
                        continue
                    seen.add(key)
                    if not any(d.get(k, 0) for k in (2, 3, 4, 5, 9, 10)):
                        continue
                    day = datetime.datetime.fromtimestamp(when).strftime("%Y-%m-%d")
                    if day_filter and day != day_filter:
                        continue
                    t = totals.setdefault(
                        day,
                        {"calls": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0},
                    )
                    t["calls"] += 1
                    t["input"] += d.get(2, 0)
                    t["output"] += d.get(10, 0)
                    t["cacheRead"] += d.get(5, 0)
                    t["cacheWrite"] += d.get(4, 0)
                    t["reasoning"] += d.get(9, 0)
                if agg is not None and every(g, 17):
                    a = ints(agg)
                    if any(a.get(k, 0) != summed.get(k, 0) for k in (2, 3, 4, 5, 9, 10)):
                        problems.append("%s row %d: calls don't sum to the generation total" % (db, gidx))
                if timing is not None and calls:
                    ctx = first(fields(timing), 10)
                    size = ints(ctx).get(1) if ctx is not None else None
                    last = ints(calls[-1][1])
                    est = last.get(2, 0) + last.get(5, 0)
                    if size and est:
                        ratios.append(size / est)
    if ratios:
        near = sum(1 for r in ratios if 0.75 <= r <= 1.25) / len(ratios)
        ratios.sort()
        print(
            "context size / (input + cache read): median %.3f, %.1f%% within 0.75-1.25, n=%d"
            % (ratios[len(ratios) // 2], near * 100, len(ratios)),
            file=sys.stderr,
        )
        if near < 0.9:
            problems.append("context size no longer tracks input + cache read (%.1f%%)" % (near * 100))
    for n in notes:
        print("NOTE " + n, file=sys.stderr)
    for p in problems:
        print("PROBLEM " + p, file=sys.stderr)
    print(json.dumps(dict(sorted(totals.items())), indent=1))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
