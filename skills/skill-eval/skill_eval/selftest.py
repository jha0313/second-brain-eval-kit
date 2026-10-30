"""Grade made-up answers before any agent runs: the answer key itself must pass, broken answers must fail.

If the grader marks a perfect answer wrong (format, path style, line numbers), every number after it is noise.
No model is called; this costs $0.
"""
from __future__ import annotations

import json
import random
import re
from pathlib import Path

from . import checks
from .suite import load_key, load_sources


def _traj(final: str) -> dict:
    return {"final": final, "tool_calls": [], "skills_loaded": [],
            "ws_state": {"tracked_changes": [], "untracked": [], "head_ok": True}}


def _grade(case, final: str, suite) -> tuple[bool, str]:
    hard = checks.run_hard_checks(case, _traj(final), "v1", suite.repo, suite.commit, suite.trusted_dirs)
    bad = [h for h in hard if h["gate"] and h["ok"] is False]
    return (not bad, "; ".join(f"{h['check']}: {h['detail']}" for h in bad) or "ok")


def _passes(args: dict, recall: float, precision: float) -> bool:
    """What set_match should say: exact set if the case asks for it, else the recall/precision thresholds."""
    if args.get("exact"):
        return recall == precision == 1.0
    return (recall >= args.get("min_recall", checks.FIND_ALL_PASS["min_recall"])
            and precision >= args.get("min_precision", checks.FIND_ALL_PASS["min_precision"]))


def _cite(src: dict) -> str:
    if "commit" in src:
        return f"commit {src['commit'][:8]}"
    return src["path"] + (f":{src['lines'][0]}-{src['lines'][1]}" if src.get("lines") else "")


def answers(case, suite) -> list[tuple[str, str, bool]]:
    """(label, answer text, should pass) for one case."""
    rng = random.Random(case.id)
    out = []
    for chk in case.hard:
        name, args = next(iter(chk.items()))
        if name == "set_match":
            key = sorted(load_key(args["key"]))
            fence = lambda items: "Here is the list.\n```json\n" + json.dumps(items, indent=1) + "\n```"  # noqa: E731
            ok = lambda r, p, a=args: _passes(a, r, p)  # noqa: E731
            n = len(key)
            out.append(("key as JSON", fence(key), True))
            out.append(("key, shuffled, ./ prefix", fence(["./" + k for k in rng.sample(key, n)]), True))
            if n > 1:
                out.append(("one item missing", fence(key[1:]), ok((n - 1) / n, 1.0)))
            out.append(("one extra item", fence(key + ["lib/not-in-key-zz.ts" + (":1" if args.get("unit") == "site" else "")]), ok(1.0, n / (n + 1))))
            out.append(("first 50 only", fence(key[:50]), ok(min(50, n) / n, 1.0)))
            if n >= 10:                                    # just under / just over the recall threshold
                k_ok = -(-int(n * args.get("min_recall", checks.FIND_ALL_PASS["min_recall"]) * 1000) // 1000)
                out.append(("recall at threshold", fence(key[:k_ok]), ok(k_ok / n, 1.0)))
                out.append(("recall below threshold", fence(key[:k_ok - 1]), ok((k_ok - 1) / n, 1.0)))
            out.append(("cut-off JSON (output limit)", "```json\n" + json.dumps(key[: max(1, n // 2)])[:-1], False))
        elif name == "sources_hit":
            srcs = load_sources(args["key"])
            good = "The reason is described in " + ", ".join(_cite(s) for s in srcs) + "."
            out.append(("cites every key source", good, True))
            out.append(("cites one key source", f"See {_cite(srcs[-1])}.", True))
            out.append(("cites an unrelated real file", "See package.json:1.", False))
            out.append(("cites a made-up file", f"See {_cite(srcs[0])} and lib/made-up-zz.ts:3.", False))
        elif name == "answer_regex" and args.get("source_key"):
            k = json.loads(Path(args["source_key"]).read_text())
            value = re.split(r"\s+[—-]\s+", k["expected"])[0]
            out.append(("expected value + citation", f"It is {value} ({k['cite']}).", True))
            out.append(("wrong value", f"It is 12345 ({k['cite']}).", False))
            out.append(("value, no citation", f"It is {value}.", False))
    return out


def run_selftest(suite) -> list[dict]:
    rows = []
    for case in suite.cases:
        for label, text, want in answers(case, suite):
            ok, why = _grade(case, text, suite)
            rows.append({"case": case.id, "answer": label, "want": "pass" if want else "fail",
                         "got": "pass" if ok else "fail", "ok": ok == want, "detail": why})
    return rows
