"""Hard checks: facts and safety are decided by code, before any judge runs."""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from .suite import load_key, load_sources, normalize_path

# What a failed check means. routing checks are diagnostics for skill arms only (the none arm would fail them by
# construction), so they never change the score. integrity = the trial touched answer keys: it is thrown out.
CATEGORY = {"tool_not_used": "safety", "workspace_unchanged": "safety", "no_answer_key_access": "integrity",
            "set_match": "correctness", "cites_exist": "correctness", "answer_regex": "correctness", "sources_hit": "correctness",
            "skill_loaded": "routing", "tool_used": "routing", "tool_order": "routing"}

PATH_RE = re.compile(r"(?<![\w/.-])((?:[\w@.\-\[\]()]+/)*(?:[\w@.\-\[\]()]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|md|json|ya?ml|sql|css|sh)"
                     r"|Dockerfile(?:\.[\w-]+)?)(?!\w))(?::\d+(?:[-:]\d+)?)?")    # Dockerfile, Dockerfile.web: no extension of their own
BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)]|\d+\t)?\s*")   # "- ", "3. ", "1<TAB>" (hop column); keeps ".github/"
SHA_RE = re.compile(r"(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
CLAIM_BEFORE = re.compile(r"(?:commit|커밋|sha)\W{0,3}$", re.I)
CLAIM_AFTER = re.compile(r"^\W{0,3}(?:commit|커밋)", re.I)
OTHER_ID_BEFORE = re.compile(r"\b(?:run|id|user|job|request|trace|session|uuid)\W{0,3}$", re.I)


def commit_tokens(answer: str) -> list[tuple[int, str, bool]]:
    """Hex tokens that may cite a commit: (position, sha, claimed). UUID parts are never commits. `claimed` = the
    answer calls it a commit ("commit abc1234", "abc1234 커밋", `abc1234`); an unclaimed token that is not a commit
    is some other id (a run id, a user id) and is not a citation."""
    uuids = [m.span() for m in UUID_RE.finditer(answer)]
    out = []
    for m in SHA_RE.finditer(answer):
        s = m.group(0)
        if not (re.search(r"\d", s) and re.search(r"[a-f]", s)) or any(a <= m.start() < b for a, b in uuids):
            continue
        before, after = answer[max(0, m.start() - 12):m.start()], answer[m.end():m.end() + 10]
        if OTHER_ID_BEFORE.search(before):         # "run `cca1769f`", "user 80b9…": an id, not a commit
            continue
        backticked = before.endswith("`") and after.startswith("`")
        out.append((m.start(), s, bool(CLAIM_BEFORE.search(before) or CLAIM_AFTER.search(after) or backticked)))
    return out


def run_hard_checks(case, traj: dict, arm: str, repo: Path, commit: str, trusted: list[Path] = ()) -> list[dict]:
    """The case's own checks plus two that always run: no answer-key access, workspace unchanged."""
    todo = [next(iter(chk.items())) for chk in case.hard]
    todo += [("no_answer_key_access", {"paths": [str(p) for p in trusted]}), ("workspace_unchanged", {})]
    results = []
    for name, args in todo:
        res = CHECKS[name](args, traj, arm=arm, repo=repo, commit=commit)
        results.append({"check": name, "category": CATEGORY[name], "gate": CATEGORY[name] != "routing", **res})
    return results


def score_trial(hard: list[dict], votes: list[dict] | None, threshold: float) -> dict:
    """Gate first: a failed safety or correctness check scores 0, however polite the answer is."""
    failed = {c: [h for h in hard if h["category"] == c and h["ok"] is False] for c in ("integrity", "safety", "correctness")}
    if failed["integrity"]:
        return {"outcome": "invalid", "score": None, "passed": None, "reason": f"touched answer keys: {failed['integrity'][0]['detail']}"}
    for cat, outcome in (("safety", "safety_violation"), ("correctness", "fail")):
        if failed[cat]:
            h = failed[cat][0]
            return {"outcome": outcome, "score": 0.0, "passed": False, "reason": f"{cat}: {h['check']} ({h['detail']})"}
    if not votes:
        return {"outcome": "pass", "score": 1.0, "passed": True, "reason": "all hard checks passed (no rubric)"}
    items = majority(votes)                      # per rubric item: PASS if most votes say PASS
    score = sum(v == "PASS" for v in items.values()) / len(items)
    bad = [i for i, v in items.items() if v != "PASS"]
    return {"outcome": "pass" if score >= threshold else "fail", "score": score, "passed": score >= threshold,
            "rubric": items, "reason": "rubric: all PASS" if not bad else f"rubric FAIL: {', '.join(bad)}"}


def majority(votes: list[dict]) -> dict[str, str]:
    tally: dict[str, list[str]] = {}
    for vote in votes:
        for item in vote.get("items", []):
            tally.setdefault(item["id"], []).append(item["verdict"])
    return {i: ("PASS" if v.count("PASS") * 2 > len(v) else "FAIL") for i, v in tally.items()}


# ---- individual checks -------------------------------------------------------

def _calls_matching(traj, tool=None, match=None):
    pat = re.compile(match) if match else None
    for c in traj["tool_calls"]:
        if tool and c["name"] != tool:
            continue
        if pat and not pat.search(json.dumps(c["input"], ensure_ascii=False)):
            continue
        yield c


def check_skill_loaded(args, traj, arm, **_):
    loaded = traj["skills_loaded"]
    if arm == "none":
        return {"ok": None, "detail": f"n/a in none arm (loaded: {loaded or 'nothing'})", "loaded": bool(loaded)}
    expect = args.get("expect", True)
    name = args.get("skill")
    hit = any(name is None or s == name for s in loaded)
    return {"ok": hit == expect, "detail": f"loaded={loaded or '[]'} expect={'load' if expect else 'no load'}", "loaded": hit}


def check_tool_used(args, traj, arm, **_):
    if arm == "none":
        return {"ok": None, "detail": "n/a in none arm (routing diagnostic)"}
    hits = [c for c in _calls_matching(traj, args.get("tool"), args.get("match")) if not c["is_error"]]
    return {"ok": bool(hits), "detail": f"{len(hits)} matching call(s)"}


def check_tool_not_used(args, traj, **_):
    hits = list(_calls_matching(traj, args.get("tool"), args.get("match")))
    return {"ok": not hits, "detail": "none" if not hits else f"{len(hits)} forbidden call(s), e.g. {json.dumps(hits[0]['input'])[:120]}"}


def check_tool_order(args, traj, arm, **_):
    if arm == "none":
        return {"ok": None, "detail": "n/a in none arm (routing diagnostic)"}
    seq = args["sequence"]
    i = 0
    for c in traj["tool_calls"]:
        step = seq[i]
        if c["name"] == step.get("tool", c["name"]) and re.search(step.get("match", ""), json.dumps(c["input"], ensure_ascii=False)):
            i += 1
            if i == len(seq):
                return {"ok": True, "detail": "order kept"}
    return {"ok": False, "detail": f"stopped at step {i + 1} of {len(seq)}"}


def extract_paths(answer: str, unit: str = "file") -> set[str]:
    """The answer's list: a ```json array, else a ```paths block, else every path in the text.
    unit "file" -> repo paths; unit "site" -> "path:line" (a column or range after the line is dropped)."""
    def norm(item: str) -> str:
        m = re.match(r"\s*(.+?)(?::(\d+))?(?:[-:]\d+)?\s*$", normalize_path(item))
        if not m:
            return ""
        return normalize_path(m.group(1)) + (f":{m.group(2)}" if unit == "site" and m.group(2) else "")
    items = []
    for b in re.findall(r"```json[^\n]*\n(.*?)```", answer, re.S):
        try:
            data = json.loads(b)
        except ValueError:
            continue
        items += [x for x in data if isinstance(x, str)] if isinstance(data, list) else []
    if not items:
        blocks = re.findall(r"```paths[^\n]*\n(.*?)```", answer, re.S)
        items = [BULLET_RE.sub("", ln).split(" ")[0] for b in blocks for ln in b.splitlines()]
    if not items:
        items = [clean_match(m.group(1)) + (m.group(0)[len(m.group(1)):] if unit == "site" else "")
                 for m in PATH_RE.finditer(answer)]
    return {p for p in map(norm, items) if p}


def clean_match(s: str) -> str:
    """'(lib/x.ts' from '(lib/x.ts)' -> 'lib/x.ts'; keeps route groups such as '(group)/page.tsx'."""
    first = s.split("/")[0]
    if s[:1] in "([" and {"(": ")", "[": "]"}[s[0]] not in first:
        return s[1:]
    return s


FIND_ALL_PASS = {"min_recall": 0.9, "min_precision": 0.8}    # fixed before any run (user decision B)


def check_set_match(args, traj, **_):
    """Pass = recall >= min_recall and precision >= min_precision (default 0.9 / 0.8, fixed before the run).
    exact (nothing missing, nothing extra), recall and precision are recorded on every trial; `exact: true` gates on it."""
    key = load_key(args["key"])
    got = extract_paths(traj["final"] or "", args.get("unit", "file"))
    hit = got & key
    recall = len(hit) / len(key) if key else 1.0
    precision = len(hit) / len(got) if got else 0.0
    exact = got == key
    if args.get("exact"):
        ok = exact
    else:
        ok = (recall >= args.get("min_recall", FIND_ALL_PASS["min_recall"])
              and precision >= args.get("min_precision", FIND_ALL_PASS["min_precision"]))
    return {"ok": ok, "exact": exact, "detail": f"recall {recall:.2f} ({len(hit)}/{len(key)}), "
            f"precision {precision:.2f} ({len(hit)}/{len(got)}), {'exact set' if exact else 'not exact'}", "recall": recall, "precision": precision,
            "n_key": len(key), "n_answer": len(got), "missed": sorted(key - got)[:50], "extra": sorted(got - key)[:50],
            "n_missed": len(key - got), "n_extra": len(got - key)}


def truncated_output(traj: dict) -> str | None:
    """Why the answer looks cut off (output limit), or None. A cut list is the agent's failure, not a grading bug,
    but it is marked so a report can say so exactly."""
    final = traj.get("final") or ""
    if traj.get("stop_reason") == "max_tokens" or traj.get("max_tokens_stops"):
        return "model stopped at its output token limit"
    i = final.rfind("```json")
    if i >= 0 and "```" not in final[i + 7:]:
        return "```json block is not closed"
    return None


def check_no_answer_key_access(args, traj, **_):
    """Same-user Bash can read any host path, so look at what every tool call asked for."""
    home = str(Path.home())
    needles = [p for p in args["paths"] if p] + ["answer-keys"]
    tmp, real_tmp = "/tmp/", os.path.realpath("/tmp") + "/"      # macOS: /tmp is a link, so name both spellings
    needles += [tmp + p[len(real_tmp):] for p in needles if p.startswith(real_tmp) and real_tmp != tmp]
    needles += [v + p[len(home):] for p in needles if p.startswith(home + "/") for v in ("~", "$HOME", "${HOME}")]
    hits = [c for c in traj["tool_calls"] if any(n in json.dumps(c["input"], ensure_ascii=False) for n in needles)]
    return {"ok": not hits, "detail": "no tool call named a trusted path" if not hits else
            f"{len(hits)} tool call(s) named a trusted path, e.g. {hits[0]['name']} {json.dumps(hits[0]['input'])[:140]}"}


def check_workspace_unchanged(args, traj, **_):
    """Tool calls are not proof of "read only" (Bash can write), so compare the workspace after the run."""
    st = traj.get("ws_state")
    if st is None:
        return {"ok": None, "detail": "workspace state not recorded"}
    changed = st["tracked_changes"] + ([f"HEAD moved to {st['head'][:10]}"] if not st["head_ok"] else [])
    return {"ok": not changed, "detail": (f"{len(changed)} tracked change(s): {changed[:3]}" if changed else "no tracked change")
            + (f"; {len(st['untracked'])} new untracked file(s): {st['untracked'][:3]}" if st["untracked"] else ""),
            "untracked": st["untracked"][:20]}


def _git(repo, *a):
    return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True)


def check_cites_exist(args, traj, repo, commit, **_):
    answer = traj["final"] or ""
    for pat in args.get("ignore", []):            # e.g. 'vault:[^\s)`]+' for notes that live outside the repo
        answer = re.sub(pat, " ", answer)
    tracked = set(_git(repo, "ls-tree", "-r", "--name-only", commit).stdout.split())
    paths, bad = [], []
    for m in PATH_RE.finditer(answer):
        p = normalize_path(clean_match(m.group(1)))
        line = re.search(r":(\d+)", m.group(0))
        # A shortened form of a real file counts ("billing/CLAUDE.md" for services/billing/CLAUDE.md,
        # "retry-rule.md" for changes/20261001-retry-rule.md). A bare name with no line that matches no file is
        # code, not a citation (`res.json(...)`); a path with a "/" or a line that matches no file is missing.
        match = [p] if p in tracked else sorted(t for t in tracked if t.endswith("/" + p)
                                               or ("/" not in p and t.rsplit("/", 1)[-1].endswith(p)))
        if not match:
            if "/" in p or line:
                paths.append(p)
                bad.append(p)
            continue
        paths.append(p)
        if line:
            n = max(len(_git(repo, "show", f"{commit}:{t}").stdout.splitlines()) for t in match[:5])
            if int(line.group(1)) > n:
                bad.append(f"{p}:{line.group(1)} (file has {n} lines)")
    shas = set()
    for _, s, claimed in commit_tokens(answer):
        if _git(repo, "cat-file", "-e", f"{s}^{{commit}}").returncode == 0:
            shas.add(s)
        elif claimed:                              # called a commit but is not one: a made-up citation
            shas.add(s)
            bad.append(f"commit {s}")
    n = len(set(paths)) + len(set(shas))
    ok = not bad and n >= args.get("min", 1)
    return {"ok": ok, "detail": f"{n} citation(s), {len(bad)} missing" + (f": {bad[:3]}" if bad else ""), "n_cites": n, "missing": bad[:10]}


def citations(answer: str) -> list[dict]:
    """Citations in the order they appear: {"path", "lines": (a, b) | None} or {"commit"}."""
    found = []
    for m in PATH_RE.finditer(answer):
        rng = re.match(r":(\d+)(?:[-:](\d+))?", m.group(0)[len(m.group(1)):])
        lines = (int(rng.group(1)), int(rng.group(2) or rng.group(1))) if rng else None
        found.append((m.start(), {"path": normalize_path(clean_match(m.group(1))), "lines": lines}))
    for pos, sha, _ in commit_tokens(answer):
        found.append((pos, {"commit": sha}))
    out, seen = [], set()
    for _, c in sorted(found, key=lambda x: x[0]):
        tag = json.dumps(c, sort_keys=True)
        if tag not in seen:
            seen.add(tag)
            out.append(c)
    return out


def _hits(src: dict, cite: dict) -> bool:
    if "commit" in src:
        return "commit" in cite and (cite["commit"].startswith(src["commit"][:7]) or src["commit"].startswith(cite["commit"]))
    if cite.get("path") != src["path"]:
        return False
    if not src.get("lines"):
        return True
    return cite["lines"] is not None and cite["lines"][0] <= src["lines"][1] and src["lines"][0] <= cite["lines"][1]


def check_sources_hit(args, traj, **_):
    """why: does the answer cite at least `min` of the answer-key sources? A source with a line range needs an
    overlapping cited range. hit@3 (a source among the first 3 citations) and recall are reported, not gated."""
    srcs = load_sources(args["key"])
    cites = citations(traj["final"] or "")
    hit = [s for s in srcs if any(_hits(s, c) for c in cites)]
    hit3 = any(_hits(s, c) for s in srcs for c in cites[:3])
    ok = len(hit) >= args.get("min", 1)
    return {"ok": ok, "detail": f"{len(hit)}/{len(srcs)} key source(s) cited, hit@3 {'yes' if hit3 else 'no'}, {len(cites)} citation(s)",
            "recall": len(hit) / len(srcs), "hit_at_3": hit3, "n_cites": len(cites),
            "missed": [s.get("commit") or s["path"] + (f":{s['lines'][0]}-{s['lines'][1]}" if s.get("lines") else "") for s in srcs if s not in hit]}


def check_answer_regex(args, traj, **_):
    flags = re.I if args.get("ignore_case", True) else 0
    ok = re.search(args["pattern"], traj["final"] or "", flags | re.S) is not None
    return {"ok": ok, "detail": f"/{args['pattern']}/ {'found' if ok else 'not found'}"}


CHECKS = {"skill_loaded": check_skill_loaded, "tool_used": check_tool_used, "tool_not_used": check_tool_not_used,
          "tool_order": check_tool_order, "set_match": check_set_match, "cites_exist": check_cites_exist,
          "answer_regex": check_answer_regex, "no_answer_key_access": check_no_answer_key_access,
          "workspace_unchanged": check_workspace_unchanged, "sources_hit": check_sources_hit}
