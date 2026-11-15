import json, os, sys
root = sys.argv[1]
def w(home, name, events, raw_extra=b""):
    d = os.path.join(root, home, "sessions/2026/11/10"); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "wb") as f:
        for e in events:
            f.write((e if isinstance(e, bytes) else json.dumps(e).encode()) + b"\n")
        f.write(raw_extra)
T = lambda s: f"2026-11-10T10:00:{s:02d}.000Z"
meta = lambda sid, s=0, **k: {"timestamp": T(s), "type": "session_meta", "payload": {"id": sid, "cwd": "/w/p", **k}}
ctx = lambda turn, s=1: {"timestamp": T(s), "type": "turn_context", "payload": {"turn_id": turn, "model": "gpt-x"}}
start = lambda turn, s=1: {"timestamp": T(s), "type": "event_msg", "payload": {"type": "task_started", "turn_id": turn}}
def rec(rid, thread, turn, s, i=1000, c=400, o=100, r=20, ts=True):
    e = {"type": "token_usage_record", "payload": {"response_id": rid, "thread_id": thread, "turn_id": turn, "usage": {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o, "reasoning_output_tokens": r}}}
    if ts: e["timestamp"] = T(s)
    return e
def tc(s, i, o, c=0, r=0, total=True):
    u = {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o, "reasoning_output_tokens": r}
    return {"timestamp": T(s), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": u} if total else {"total_token_usage": {}, "last_token_usage": u}}}
# F1 fork: parent keeps working after the fork, child does its own work
pad = {"timestamp": T(9), "type": "response_item", "payload": {"type": "message", "text": "x" * 4000}}
w("f1", "rollout-parent.jsonl", [meta("A"), start("t1"), ctx("t1"), rec("r1", "A", "t1", 2), rec("r2", "A", "t1", 3), pad, rec("r4", "A", "t1", 20)])
w("f1", "rollout-child.jsonl", [meta("C", forked_from_id="A"), meta("A"), start("t1"), ctx("t1"), rec("r1", "A", "t1", 2), start("t2", 10), ctx("t2", 10), rec("r3", "C", "t2", 11)])
# F2 legacy counter reset
w("f2", "rollout-reset.jsonl", [meta("B"), start("t1"), ctx("t1"), tc(2, 100, 10), tc(3, 200, 20), tc(4, 50, 5), tc(5, 120, 12)])
# F3 empty total object beside last_token_usage
w("f3", "rollout-emptytotal.jsonl", [meta("E"), start("t1"), ctx("t1"), tc(2, 100, 10), tc(3, 30, 3, total=False), tc(4, 150, 15)])
# F4 invalid utf-8 inside a usage line
bad = json.dumps(rec("r9", "G", "t1", 2)).encode().replace(b'"response_id"', b'"note": "\xff", "response_id"')
w("f4", "rollout-badutf8.jsonl", [meta("G"), start("t1"), ctx("t1"), bad])
# F6 no timestamp on a receipt
w("f6", "rollout-nots.jsonl", [meta("H"), start("t1"), ctx("t1"), rec("r7", "H", "t1", 2, ts=False)])
# F7 same response id in two unrelated rollouts
w("f7", "rollout-a.jsonl", [meta("J1"), start("t1"), ctx("t1"), rec("same", "J1", "t1", 2)])
w("f7", "rollout-b.jsonl", [meta("J2"), start("t1"), ctx("t1"), rec("same", "J2", "t1", 2)])
os.makedirs(os.path.join(root, "f8", "sessions"), exist_ok=True)
# F9 a guardian whose total is restored with the compaction, equal to its last
# usage (the real shape: written within ms of `compacted`): inherited, skipped
guardian = {"subagent": {"other": "guardian"}}
def tc2(s, total, last):
    u = lambda i, o: {"input_tokens": i, "cached_input_tokens": 0, "output_tokens": o, "reasoning_output_tokens": 0}
    return {"timestamp": T(s), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": u(*total), "last_token_usage": u(*last)}}}
compacted = {"timestamp": T(1), "type": "compacted", "payload": {"message": "summary"}}
w("f9", "rollout-guardian-restored.jsonl", [meta("K", source=guardian), compacted, ctx("t0"), tc2(2, (500, 50), (500, 50)), start("t1", 3), ctx("t1", 3), tc2(4, (800, 80), (300, 30))])
# F10 a reused guardian: its first total carries earlier work in (total > last), skipped
w("f10", "rollout-guardian-carried.jsonl", [meta("L", source=guardian), compacted, ctx("t0"), tc2(2, (500, 50), (100, 10)), start("t1", 3), ctx("t1", 3), tc2(4, (800, 80), (300, 30))])
# F11 a turn with one receipt and three legacy steps: the receipt misses two calls
legacy3 = [tc2(2, (100, 10), (100, 10)), tc2(3, (200, 20), (100, 10)), tc2(4, (300, 30), (100, 10))]
w("f11", "rollout-receipt-short.jsonl", [meta("M"), start("t1"), ctx("t1")] + legacy3[:1] + [rec("rm", "M", "t1", 2, i=100, c=0, o=10, r=0)] + legacy3[1:])
# F12 a counter restart the input check can't see: it restarts higher than before
w("f12", "rollout-restart-up.jsonl", [meta("N"), start("t1"), ctx("t1"), tc2(2, (100, 10), (100, 10)), tc2(3, (150, 15), (150, 15))])
# F13 Codex writes the same total and last usage twice: nothing new
w("f13", "rollout-repeat.jsonl", [meta("P"), start("t1"), ctx("t1"), tc2(2, (100, 10), (100, 10)), tc2(3, (100, 10), (100, 10)), tc2(4, (200, 20), (100, 10))])
