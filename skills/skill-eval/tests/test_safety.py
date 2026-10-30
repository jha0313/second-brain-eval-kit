"""Safety rails (E4) and accounting fixes (E5). Offline: the agent, the judge and the workspace builders are
replaced by fakes, so no model is called."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fakes import fake_run, make_case, make_rec, make_suite, tiny_suite

from skill_eval import cli, judge, runner, stats
from skill_eval.suite import load_suite


def test_judge_attempt_costs_add_up(monkeypatch):
    outs = iter([json.dumps({"total_cost_usd": 0.2, "result": "not json"}),
                 json.dumps({"total_cost_usd": 0.3, "structured_output": {"items": [{"id": "a", "verdict": "PASS", "reason": "r"}]}})])
    monkeypatch.setattr(judge, "_call", lambda *a: SimpleNamespace(stdout=next(outs)))
    v = judge.one_vote("p", "m", ["a"])
    assert v["cost_usd"] == pytest.approx(0.5) and v["attempts"] == 2 and not v.get("grader_error")
    outs = iter(["", json.dumps({"total_cost_usd": 0.2, "result": "{}"})])
    v = judge.one_vote("p", "m", ["a"])
    assert v["grader_error"] and v["cost_usd"] == pytest.approx(0.2) and v["cost_unknown_attempts"] == 1


def test_pass_hat_k_is_na_when_repeats_are_missing():
    spec = lambda arm, rep: {"case": make_case("W1"), "arm": arm, "rep": rep}  # noqa: E731
    trials = [make_rec(spec("v1", 1)), make_rec(spec("v1", 2), outcome="infra_error", score=None),
              make_rec(spec("v1", 3), outcome="infra_error", score=None)] + [make_rec(spec("none", r)) for r in (1, 2, 3)]
    agg = stats.aggregate(trials, ["none", "v1"], ["W1"], [("none", "v1")])
    assert agg["cells"]["W1|v1"]["pass_hat_k"] is None and agg["cells"]["W1|v1"]["n"] == 1
    assert agg["cells"]["W1|none"]["pass_hat_k"] == 1.0


def test_yaml_sources_hit_key_is_relative_to_the_case_file(tmp_path, repo):
    repo.write({"a.ts": "x\n"})
    suite = tiny_suite(tmp_path, repo)
    cases = suite.parent / "cases"
    (cases / "keys").mkdir()
    (cases / "keys" / "W.json").write_text(json.dumps({"sources": [{"path": "a.ts"}]}))
    (cases / "w.yaml").write_text("id: W\nkind: why\nprompt: why?\nchecks:\n  hard:\n    - sources_hit: {key: keys/W.json}\n")
    s = load_suite(suite)
    key = next(c for c in s.cases if c.id == "W").hard[0]["sources_hit"]["key"]
    assert Path(key) == cases / "keys" / "W.json"
