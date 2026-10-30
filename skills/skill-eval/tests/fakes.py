"""Fakes shared by the offline tests: cases, a suite object, trial records, and runner.run without a model."""
from pathlib import Path
from types import SimpleNamespace

from skill_eval import runner
from skill_eval.suite import Case

ARMS = {"none": None, "v1": Path("/skills/demo")}


def make_case(cid, kind="why", rubric=True, family=""):
    return Case(id=cid, kind=kind, prompt="q", hard=[], family=family or cid, source=Path("c.json"),
                rubric=[{"id": "answers_question", "pass": "p"}] if rubric else [], expected=None,
                limits={"max_turns": 5, "timeout_s": 60, "max_usd": 1.0}, pass_threshold=0.7)


def make_suite(cases):
    return SimpleNamespace(name="t", path=Path("suite.yaml"), skill="demo", arms=ARMS, patches={}, label="r", commit="c" * 40,
                           strip=[".claude"], model="m", effort=None, tools="Bash", cases=cases, compare=[("none", "v1")],
                           judge_model="j", votes=3, notes=[], limits={}, find_all_pass={}, sensitivity={}, repo=Path("."))


def make_rec(spec, outcome="pass", score=1.0, **kw):
    c = spec["case"]
    rec = {"trial_id": f"{c.id}__{spec['arm']}__{spec['rep']}", "case": c.id, "kind": c.kind, "family": c.family,
           "arm": spec["arm"], "rep": spec["rep"], "outcome": outcome, "score": score,
           "passed": None if score is None else score >= 0.7, "hard": [], "reason": "", "skill_loaded": None,
           "metrics": {"seconds": 1, "agent_usd": 0.1, "judge_usd": 0.0, "tokens": {"output": 1}, "tokens_total": 10,
                       "tool_calls": 1, "turns": 1}}
    rec.update(kw)
    return rec


def fake_run(monkeypatch, tmp_path, cases, trial, k=1, max_usd=None, per_trial_usd=None, **kw):
    """runner.run with every expensive or host-touching step replaced; `trial(spec, n)` makes each record."""
    def template(suite, arm, root):
        t = root / arm
        (t / ".claude" / "skills" / "demo").mkdir(parents=True, exist_ok=True)
        (t / ".claude" / "skills" / "demo" / "SKILL.md").write_text("x")
        return t
    calls = []

    def fake_trial(suite, spec, *a):
        calls.append(spec)
        return trial(spec, len(calls))
    for name, fn in {"auth_mode": lambda: "token", "ancestor_instructions": lambda p: [], "deny_list": lambda s, o: [],
                     "host_deny": list, "build_template": template, "build_index": lambda s, r, t: {},
                     "run_trial": fake_trial, "repo_instructions": lambda s: {}}.items():
        monkeypatch.setattr(runner, name, fn)
    suite = make_suite(cases)
    specs = runner.plan(suite, ["none", "v1"], None, k)
    est = {"total_usd": per_trial_usd * len(specs) if per_trial_usd else 1.0, "trials": len(specs)}
    data = runner.run(suite, specs, tmp_path / "out", 2, max_usd, est, log=lambda s: None, **kw)
    return data, calls


def tiny_suite(tmp_path, repo) -> Path:
    head = repo.commit()
    d = tmp_path / "suite"
    (d / "cases").mkdir(parents=True)
    (d / "cases" / "c1.yaml").write_text("id: C1\nkind: small\nprompt: what is x?\nchecks:\n  hard:\n"
                                         "    - answer_regex: {pattern: '42'}\n")
    (d / "suite.yaml").write_text(f"name: tiny\nskill: demo\narms: {{none: null}}\nrepo: {{path: {repo.root}, commit: {head}}}\n"
                                  "cases: cases/*.yaml\ncompare: []\n")
    return d / "suite.yaml"


WHY_CASE = ("id: W\nkind: why\nprompt: why?\nchecks:\n  hard:\n    - cites_exist: {min: 1}\n"
            "  rubric:\n    - {id: answers_question, pass: p}\n")


def stored_run(tmp_path, repo, outcome, **extra) -> Path:
    """A finished run on disk: one why trial whose trajectory is clean ("See a.ts:1."), recorded as `outcome`.
    The repo must already hold a.ts plus at least one uncommitted change (tiny_suite commits it)."""
    import json

    from skill_eval.checks import GRADING_VERSION
    from skill_eval.stats import EXCLUDED, SCORED
    suite_file = tiny_suite(tmp_path, repo)
    (suite_file.parent / "cases" / "w.yaml").write_text(WHY_CASE)
    run = tmp_path / "run"
    t = run / "trials" / "W__none__1"
    t.mkdir(parents=True)
    (t / "trajectory.jsonl").write_text(json.dumps({"type": "result", "subtype": "success", "result": "See a.ts:1.",
                                                    "total_cost_usd": 0.01}) + "\n")
    rec = {"trial_id": "W__none__1", "case": "W", "kind": "why", "family": "W", "arm": "none", "rep": 1, "outcome": outcome,
           "score": None, "passed": None, "hard": [], "reason": "", "skill_loaded": False, "isolation_ok": True,
           "ws_state": {"tracked_changes": [], "untracked": [], "head": "", "head_ok": True},
           "metrics": {"seconds": 1, "agent_usd": 0.01, "judge_usd": 0.0, "tokens": {"output": 1}, "tokens_total": 1,
                       "tool_calls": 0, "turns": 1}, **extra}
    counts = {"expected": 1, "attempted": 1, "scored": int(outcome in SCORED),
              "excluded": {o: int(outcome == o) for o in EXCLUDED}}
    meta = {"suite_file": str(suite_file), "arms": {"none": None}, "cases": {"W": {"kind": "why"}}, "counts": counts,
            "grading_version": GRADING_VERSION, "spent_usd": 0.01, "judge_version": "judge-v3", "judge_models_seen": []}
    (run / "results.json").write_text(json.dumps({"meta": meta, "trials": [rec]}))
    return run
