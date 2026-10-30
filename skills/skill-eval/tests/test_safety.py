"""Safety rails (E4) and accounting fixes (E5). Offline: the agent, the judge and the workspace builders are
replaced by fakes, so no model is called."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fakes import fake_run, make_case, make_rec, make_suite, tiny_suite

from skill_eval import cli, judge, runner, stats
from skill_eval.suite import load_suite


def test_breaker_rules():
    b = runner.Breaker(3)
    spec = {"case": make_case("W1"), "arm": "v1", "rep": 1}
    for _ in range(2):
        b.see(make_rec(spec, permission_denied=["Bash ls"]))
    assert b.reason is None
    b.see(make_rec(spec, permission_denied=["Bash ls"]))
    assert "3 trial(s) with permission denials" in b.reason
    b = runner.Breaker(0)                                     # 0 = never stop for denials
    for _ in range(9):
        b.see(make_rec(spec, permission_denied=["Bash ls"]))
    assert b.reason is None
    b.see(make_rec(spec, outcome="infra_error", score=None, grader_exception=True))
    assert b.reason
    c = runner.Breaker(3)
    c.see(make_rec(spec, outcome="infra_error", score=None), canary=True)
    assert c.reason.startswith("canary")


def test_canary_stops_the_run_before_the_pool(monkeypatch, tmp_path):
    cases = [make_case(f"W{i}") for i in range(4)]
    data, calls = fake_run(monkeypatch, tmp_path, cases,
                            lambda spec, n: make_rec(spec, permission_denied=["Write notes.txt"] if n == 1 else []))
    assert len(calls) == 1                                    # the first canary failed: not even the second one runs
    out = [t["outcome"] for t in data["trials"]]
    assert out.count("skipped_stopped") == 7 and data["meta"]["stopped"].startswith("canary")
    assert data["meta"]["counts"]["excluded"]["skipped_stopped"] == 7 and data["meta"]["counts"]["attempted"] == 1
    _, calls = fake_run(monkeypatch, tmp_path / "ok", cases, lambda spec, n: make_rec(spec))
    assert len(calls) == 8                                    # clean canaries: the whole plan runs once
    assert (tmp_path / "out" / "results.json").exists()


def test_denials_after_the_canary_stop_after_n(monkeypatch, tmp_path):
    cases = [make_case(f"W{i}") for i in range(6)]
    data, calls = fake_run(monkeypatch, tmp_path, cases,
                            lambda spec, n: make_rec(spec, permission_denied=["Bash x"] if n > 2 else []), stop_after_denials=2)
    assert data["meta"]["stopped"] and len(calls) < 12
    assert sum(t["outcome"] == "skipped_stopped" for t in data["trials"]) == 12 - len(calls)


def test_runner_exception_is_excluded_and_releases_the_budget(monkeypatch, tmp_path):
    cases = [make_case("W1")]

    def trial(spec, n):
        if n == 3:
            raise RuntimeError("boom")
        return make_rec(spec)
    data, _ = fake_run(monkeypatch, tmp_path, cases, trial, k=2, canary=False, stop_after_denials=0)
    bad = [t for t in data["trials"] if t["outcome"] == "infra_error"]
    assert len(bad) == 1 and "runner exception" in bad[0]["reason"]
    assert data["meta"]["stopped"] and len(data["trials"]) == 4     # a harness exception stops the rest


def test_too_few_valid_judge_votes_exclude_the_trial(monkeypatch):
    case = make_case("W1")
    suite = make_suite([case])
    good = {"items": [{"id": "answers_question", "verdict": "PASS"}], "cost_usd": 0.1}
    broken = {"items": [{"id": "answers_question", "verdict": "FAIL"}], "cost_usd": 0.05, "grader_error": True}
    traj = {"final": "x", "tool_calls": [], "skills_loaded": [], "result_subtype": "success",
            "ws_state": {"tracked_changes": [], "untracked": [], "head_ok": True}}
    for votes, outcome, score in (([good, broken, broken], "infra_error", None), ([good, good, broken], "pass", 1.0)):
        monkeypatch.setattr(judge, "judge", lambda *a, v=votes, **k: v)
        rec = {"isolation_ok": True, "isolation_detail": "ok", "metrics": {"judge_usd": 0.0}}
        runner._grade(rec, suite, case, traj, "v1", [], True, False, False)
        assert (rec["outcome"], rec["score"]) == (outcome, score), rec
        assert rec["metrics"]["judge_usd"] == pytest.approx(sum(v["cost_usd"] for v in votes))
    assert judge.usable_votes([good, broken], 2) is None and judge.usable_votes([good, good, broken], 2) == [good, good]


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


def test_run_needs_a_freeze_unless_dev(monkeypatch, tmp_path, repo, capsys):
    repo.write({"a.ts": "x\n"})
    suite = tiny_suite(tmp_path, repo)

    class Reached(Exception):
        pass

    def stop(*a, **k):
        raise Reached
    monkeypatch.setattr(runner, "run", stop)
    assert cli.main(["run", str(suite)]) == 1
    assert "no FROZEN.json" in capsys.readouterr().err
    assert cli.main(["run", str(suite), "--dry-run"]) == 0              # planning stays free
    with pytest.raises(Reached):
        cli.main(["run", str(suite), "--dev"])
    with pytest.raises(Reached):
        cli.main(["run", str(suite), "--unfrozen"])                     # the old name still works


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
