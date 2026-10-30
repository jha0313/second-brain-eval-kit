"""Report-only extracts for one case, read from a finished run (results.json + trial trajectories). No grading.

Pre-registered in suites/<suite>/preregistered-extracts.md: what is pulled out and how the claim sentence is chosen.
"""
from __future__ import annotations

import json
import re
import statistics
from pathlib import Path

from .checks import PATH_RE
from .isolation import redact
from .trajectory import parse_stream

GREP_RE = re.compile(r"(?:^|[|;&(\s])(?:grep|egrep|fgrep|rg|git\s+grep)\b")
BRAIN_RE = re.compile(r"bin/brain\b|(?:^|[|;&(\s])brain\s")
FENCE_RE = re.compile(r"```.*?(?:```|\Z)", re.S)
CLAIM_RE = re.compile(r"\b(?:all|every|complete(?:ly)?|exhaustive(?:ly)?|full|total|entire(?:ly)?|none (?:missed|left))\b"
                      r"|전부|모두|빠짐없이|완전|총\s*\d", re.I)
SECRET_RE = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_\-]{32,})\b")
TOOLS = ("Bash grep/rg", "Bash brain", "Bash other", "Read", "Grep", "Glob", "Skill", "other")


def tool_counts(calls: list[dict]) -> dict:
    n = dict.fromkeys(TOOLS, 0)
    for c in calls:
        if c["name"] == "Bash":
            cmd = str(c["input"].get("command", ""))
            n["Bash grep/rg" if GREP_RE.search(cmd) else "Bash brain" if BRAIN_RE.search(cmd) else "Bash other"] += 1
        else:
            n[c["name"] if c["name"] in n else "other"] += 1
    return n


def mask(text: str) -> str:
    text = redact(text)
    text = re.sub(r"`[^`]*`", "`…`", text)
    text = PATH_RE.sub("‹path›", text)
    return SECRET_RE.sub("‹…›", text)


def claim(final: str) -> str | None:
    """First sentence outside code blocks that says the list is complete (all / every / complete / total …), masked."""
    prose = FENCE_RE.sub("\n", final or "")
    for sent in re.split(r"(?<=[.!?。])\s+|\n+", prose):
        sent = sent.strip(" -*#>\t")
        if sent and CLAIM_RE.search(sent):
            return mask(sent)[:200]
    return None


def extract(run_dir: Path, case_id: str) -> list[dict]:
    data = json.loads((run_dir / "results.json").read_text())
    rows = []
    for rec in data["trials"]:
        if rec["case"] != case_id or rec["outcome"] == "skipped_budget":
            continue
        tj = run_dir / "trials" / rec["trial_id"] / "trajectory.jsonl"
        traj = parse_stream(tj) if tj.exists() else {"tool_calls": [], "final": rec.get("final_excerpt", "")}
        sm = next((h for h in rec["hard"] if h["check"] == "set_match"), {})
        m = rec["metrics"]
        rows.append({"trial": rec["trial_id"], "arm": rec["arm"], "rep": rec["rep"], "outcome": rec["outcome"],
                     "seconds": m["seconds"], "tools": tool_counts(traj["tool_calls"]), "tool_calls": len(traj["tool_calls"]),
                     "found": sm.get("n_answer"), "key": sm.get("n_key"), "recall": sm.get("recall"), "precision": sm.get("precision"),
                     "exact": sm.get("exact"), "claim": claim(traj["final"] or ""), "usd": m["agent_usd"] + m["judge_usd"],
                     "tokens": m["tokens"], "tokens_total": m["tokens_total"],
                     "truncated_output": rec.get("truncated_output")})
    order = list(data["meta"]["arms"])
    return sorted(rows, key=lambda r: (order.index(r["arm"]), r["rep"]))


def medians(rows: list[dict]) -> dict:
    out = {}
    for arm in dict.fromkeys(r["arm"] for r in rows):
        rs = [r for r in rows if r["arm"] == arm]
        out[arm] = {"n": len(rs), **{k: _median([r[k] for r in rs]) for k in
                                     ("seconds", "tool_calls", "found", "recall", "precision", "usd", "tokens_total")},
                    "tools": {t: statistics.median([r["tools"][t] for r in rs]) for t in TOOLS}}
    return out


def _median(xs: list):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def markdown(rows: list[dict], case_id: str) -> str:
    f = lambda v, s="{:.2f}": "–" if v is None else s.format(v)  # noqa: E731
    head = ("| arm | # | 결과 | 시간(s) | Bash grep/rg | Bash brain | Bash 기타 | Read | Grep | Glob | Skill | 찾은 수/정답 | recall | precision "
            "| $ | tokens (in/out/cache r/cache w) | 완료 주장(발췌) |")
    lines = [f"**{case_id}** · trial {len(rows)}", "", head, "|" + "---|" * 17]
    for r in rows:
        t, tk = r["tools"], r["tokens"]
        lines.append(f"| {r['arm']} | {r['rep']} | {r['outcome']}{' (cut-off)' if r['truncated_output'] else ''} | {r['seconds']:.0f} "
                     f"| {t['Bash grep/rg']} | {t['Bash brain']} | {t['Bash other']} | {t['Read']} | {t['Grep']} | {t['Glob']} | {t['Skill']} "
                     f"| {f(r['found'], '{}')}/{f(r['key'], '{}')} | {f(r['recall'])} | {f(r['precision'])} | {r['usd']:.2f} "
                     f"| {tk['input']:,}/{tk['output']:,}/{tk['cache_read']:,}/{tk['cache_write']:,} "
                     f"| {(r['claim'] or '(완료 주장 없음)').replace('|', '¦')} |")
    if len({r["rep"] for r in rows}) > 1:
        lines += ["", "| arm | n | 중앙값 시간(s) | tool calls | 찾은 수 | recall | precision | $ | tokens |", "|" + "---|" * 9]
        for arm, s in medians(rows).items():
            lines.append(f"| {arm} | {s['n']} | {f(s['seconds'], '{:.0f}')} | {f(s['tool_calls'], '{:.0f}')} | {f(s['found'], '{:.0f}')} "
                         f"| {f(s['recall'])} | {f(s['precision'])} | {f(s['usd'])} | {f(s['tokens_total'], '{:,.0f}')} |")
    return "\n".join(lines)
