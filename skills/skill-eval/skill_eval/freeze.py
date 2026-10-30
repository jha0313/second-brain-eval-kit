"""FROZEN.json: what the run is graded against, fixed before any v1 result is seen.

Hashes of the cases, answer keys, rubric code, the v2 patch, the skill sources and the run rules, plus a time.
`run` recomputes them and refuses to start if anything changed. A later freeze needs a reason and keeps
the earlier one in `history`, so every change after the first freeze is visible.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .checks import GRADING_VERSION
from .isolation import BUNDLED_SKILLS
from .judge import JUDGE_VERSION

CODE = ("checks.py", "judge.py", "suite.py", "stats.py", "runner.py", "isolation.py", "extract.py")
WHY_PASS = ("why: hard gates = cites_exist (at least 1 citation, every cited path/line/commit exists at the commit) and "
            "sources_hit (at least 1 answer-key source cited anywhere; a source with a line range needs an overlapping "
            "cited range); then the judge (3 votes, majority per item; it sees the key's facts and forbidden inferences, "
            "the agent never does) scores answers_question and citations_support; "
            "pass = score >= pass_threshold (both items). hit@3 and source recall are recorded, not gated.")
CONTROL_PASS = "control: the expected value (answer_regex) and at least 1 valid citation; skill loading is a routing diagnostic."
STOP_RULE = ("Pre-registered: run every frozen case for every arm k times, once. Do not add runs or drop cases after "
             "seeing results. Infra errors are retried up to 2 times, then excluded and counted. Trials that name a "
             "denied path are invalid and counted. The v1 vs v2 primary metric is the find-all mean score difference "
             "(v2-edit-plan.md); none vs v1 is reported for all cases and per kind. The main result uses every case; the "
             "same comparisons without rules.sensitivity.exclude are reported next to it. CIs are exploratory.")


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _tree(d: Path, exclude: list[str]) -> str:
    h = hashlib.sha256()
    for f in sorted(d.rglob("*")):
        rel = f.relative_to(d)
        if f.is_file() and not f.is_symlink() and not any(part in exclude or part == "node_modules" for part in rel.parts):
            h.update(str(rel).encode() + b"\0" + f.read_bytes())
    return h.hexdigest()


def manifest(suite) -> dict:
    here = Path(__file__).parent
    keys = sorted({str(k) for c in suite.cases for k in c.key_paths()} |
                  {chk["answer_regex"]["source_key"] for c in suite.cases for chk in c.hard
                   if "answer_regex" in chk and chk["answer_regex"].get("source_key")})
    plan = suite.dir / "v2-edit-plan.md"
    return {
        "suite": {"file": suite.path.name, "sha256": _sha(suite.path)},
        "cases": {os.path.relpath(f, suite.dir): _sha(f) for f in sorted({c.source for c in suite.cases})},   # no local paths
        "case_ids": [c.id for c in suite.cases],
        "families": {c.id: c.family for c in suite.cases},
        "keys": {Path(k).name: _sha(Path(k)) for k in keys},
        "patches": {a: _sha(p) for a, p in suite.patches.items()},
        "v2_plan": _sha(plan) if plan.exists() else None,
        "extracts_plan": _sha(suite.dir / "preregistered-extracts.md") if (suite.dir / "preregistered-extracts.md").exists() else None,
        "skills": {a: {"SKILL.md": _sha(p / "SKILL.md"), "tree": _tree(p, suite.skill_exclude)}
                   for a, p in suite.arms.items() if p},
        "grading_code": {f: _sha(here / f) for f in CODE},
        "grading_version": GRADING_VERSION, "judge_version": JUDGE_VERSION,
        "rules": {"model": suite.model, "effort": suite.effort, "tools": suite.tools, "limits": suite.limits,
                  "judge_model": suite.judge_model, "votes": suite.votes, "k": suite.k,
                  "pass_threshold": suite.pass_threshold, "compare": suite.compare, "strip": suite.strip,
                  "prepare": suite.prepare, "prepare_outputs": suite.prepare_outputs,
                  "find_all_pass": {**suite.find_all_pass, "rule": "pass = recall >= min_recall and precision >= "
                                    "min_precision; exact set recorded as a secondary metric"},
                  "why_pass": WHY_PASS, "control_pass": CONTROL_PASS, "sensitivity": suite.sensitivity,
                  "bundled_skills_off": len(BUNDLED_SKILLS), "stop_rule": STOP_RULE},
    }


def index_check(suite) -> dict:
    """Build every arm's workspace (so the v2 patch must apply) and the shared index once, then throw them away.
    Records whether the index carries a vault (it must not: the none arm cannot read one)."""
    from .runner import build_index, build_template
    root = Path(tempfile.mkdtemp(prefix="skill-eval-freeze-"))
    try:
        templates = {a: build_template(suite, a, root) for a in suite.arms}
        idx = build_index(suite, root, templates)
        files = idx.get("files") or {}
        return {"prepare_has_vault": "--vault" in (suite.prepare or ""), "arms_built": list(templates),
                "seconds": idx.get("seconds"), "meta": {r: v.get("meta") for r, v in files.items()}}
    finally:
        for p in root.rglob("*"):
            if p.is_file():
                p.chmod(0o644)
        shutil.rmtree(root, ignore_errors=True)


def freeze(suite, reason: str | None) -> Path:
    path = suite.dir / "FROZEN.json"
    old = json.loads(path.read_text()) if path.exists() else None
    if old and not reason:
        raise ValueError("already frozen: pass --reason to record why it changes (the old manifest is kept in history)")
    now = datetime.now().astimezone()
    data = {"frozen_at": now.isoformat(timespec="seconds"),
            "frozen_at_utc": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "reason": reason or "first freeze", **manifest(suite), "index_check": index_check(suite) if suite.prepare else None,
            "history": ([{k: v for k, v in old.items() if k != "history"}] + old.get("history", [])) if old else []}
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    return path


def verify(suite) -> tuple[dict | None, list[str]]:
    """(manifest summary, differences). No FROZEN.json -> (None, [])."""
    path = suite.dir / "FROZEN.json"
    if not path.exists():
        return None, []
    frozen = json.loads(path.read_text())
    now = manifest(suite)
    diffs = [k for k in now if json.dumps(now[k], sort_keys=True) != json.dumps(frozen.get(k), sort_keys=True)]
    summary = {"frozen_at": frozen["frozen_at"], "sha256": _sha(path), "changes_after_first": len(frozen.get("history", [])),
               "grading_version": frozen.get("grading_version", "grading-v1")}
    return summary, diffs
