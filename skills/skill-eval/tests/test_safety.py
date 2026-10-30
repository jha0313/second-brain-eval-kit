"""Safety rails (E4) and accounting fixes (E5). Offline: the agent, the judge and the workspace builders are
replaced by fakes, so no model is called."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fakes import fake_run, make_case, make_rec, make_suite, stored_run, tiny_suite

from skill_eval import cli, judge, report, runner, stats
from skill_eval import freeze as freeze_mod
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


def test_the_stop_rule_names_the_breaker_and_meta_keeps_its_settings(monkeypatch, tmp_path):
    # review r2 (optional): the pre-registered stop rule must say when a run stops early, and the run records the setting
    assert "canary" in freeze_mod.STOP_RULE and "--stop-after-denials" in freeze_mod.STOP_RULE
    data, _ = fake_run(monkeypatch, tmp_path, [make_case("W0")], lambda spec, n: make_rec(spec), stop_after_denials=2)
    assert (data["meta"]["stop_after_denials"], data["meta"]["canary"]) == (2, True)


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
    orig_sha = freeze_mod._sha
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
    assert cli.main(["freeze", str(suite)]) == 0
    monkeypatch.setattr(freeze_mod, "_sha", lambda p: "changed" if p.name == "runner.py" else orig_sha(p))
    assert cli.main(["run", str(suite)]) == 1
    assert "grading code changed since the freeze (same grading version)" in capsys.readouterr().err


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


def test_a_denial_does_not_hide_a_fatal_error():
    # review r2 #1: the same trial with a permission denial and a grader exception (or isolation error) stops at once
    spec = {"case": make_case("W1"), "arm": "v1", "rep": 1}
    for fatal in ({"grader_exception": True}, {"outcome": "isolation_error", "score": None}):
        b = runner.Breaker(3)
        b.see(make_rec(spec, permission_denied=["Bash ls"], **fatal))
        assert b.reason and "permission denials" not in b.reason, (fatal, b.reason)


def test_a_worker_waiting_for_budget_does_not_start_after_the_stop(monkeypatch, tmp_path):
    # review r2 #2: 2 workers, $1 reserved per trial, cap $1.5: the second worker waits on the budget while the first
    # trial runs; that trial stops the run, so the waiting worker must not start a paid trial when it wakes up
    import time

    def trial(spec, n):
        if n == 1:
            time.sleep(0.3)
            return make_rec(spec, permission_denied=["Bash x"])
        return make_rec(spec)
    data, calls = fake_run(monkeypatch, tmp_path, [make_case("W0"), make_case("W1")], trial, canary=False,
                           stop_after_denials=1, max_usd=1.5, per_trial_usd=1.0)
    assert len(calls) == 1, [f"{c['case'].id}/{c['arm']}" for c in calls]
    assert sum(t["outcome"] == "skipped_stopped" for t in data["trials"]) == 3


GOOD = {"items": [{"id": "answers_question", "verdict": "PASS"}], "cost_usd": 0.1, "models": ["judge-m"]}
BROKEN = {"items": [{"id": "answers_question", "verdict": "FAIL"}], "cost_usd": 0.02, "grader_error": True}


def _grade(monkeypatch, run, votes):
    calls = []
    monkeypatch.setattr(judge, "judge", lambda *a, **k: calls.append(1) or [dict(v) for v in votes])
    monkeypatch.setattr(report, "write_reports", lambda d, o: (o / "scorecard.html", ""))
    assert cli.main(["grade", str(run)]) == 0
    return json.loads((run / "results.json").read_text()), calls


def test_grade_recovers_a_trial_the_judge_failed(monkeypatch, tmp_path, repo):
    # review r2 #4: a trial excluded because the judge broke is re-graded once the judge works
    repo.write({"a.ts": "x\n"})
    run = stored_run(tmp_path / "a", repo, "infra_error", grader_error=True, votes=[BROKEN] * 3,
                     reason="grader error: 3/3 judge votes invalid")
    data, calls = _grade(monkeypatch, run, [GOOD] * 3)
    t = data["trials"][0]
    assert calls == [1] and (t["outcome"], t["score"]) == ("pass", 1.0) and not t["grader_error"]
    for i, extra in enumerate(({}, {"runner_exception": True})):      # the agent's infra failure or a runner bug: kept
        repo.write({f"b{i}.ts": "y\n"})
        data, calls = _grade(monkeypatch, stored_run(tmp_path / f"b{i}", repo, "infra_error", **extra), [GOOD] * 3)
        assert calls == [] and data["trials"][0]["outcome"] == "infra_error"


def test_grade_updates_counts_cost_and_judge_metadata(monkeypatch, tmp_path, repo):
    # review r2 #5: a re-grade that turns a pass into an exclusion must show in meta.counts, and its judge cost in spent_usd
    repo.write({"a.ts": "x\n"})
    run = stored_run(tmp_path, repo, "pass", score=1.0, passed=True, votes=[GOOD] * 3)
    data, _ = _grade(monkeypatch, run, [BROKEN] * 3)
    m = data["meta"]
    assert data["trials"][0]["outcome"] == "infra_error"
    assert m["counts"]["scored"] == 0 and m["counts"]["excluded"]["infra_error"] == 1 and m["counts"]["attempted"] == 1
    assert m["spent_usd"] == pytest.approx(0.01 + 3 * 0.02)
    assert m["regrades"][-1]["judge_usd"] == pytest.approx(0.06) and m["regrades"][-1]["judge_calls"] == 1
    assert m["judge_version"] == judge.JUDGE_VERSION and m["regrades"][-1]["grading_version"] == m["grading_version"]
    data, _ = _grade(monkeypatch, run, [GOOD] * 3)                        # a second re-grade adds to the history
    assert len(data["meta"]["regrades"]) == 2 and data["meta"]["spent_usd"] == pytest.approx(0.07 + 0.3)
    assert data["meta"]["counts"]["scored"] == 1 and data["meta"]["judge_models_seen"] == ["judge-m"]
    data, _ = _grade(monkeypatch, run, [{**GOOD, "cost_unknown_attempts": 1}] * 3)   # judge retries of unknown cost
    assert data["meta"]["cost_unknown_attempts"] == 3


def test_tokens_count_every_attempt(monkeypatch, tmp_path):
    # review r2 #6: judge tokens add up over attempts; the report keeps the graded attempt and all attempts apart
    use = lambda n: {"judge-m": {"inputTokens": n, "outputTokens": 1}}  # noqa: E731
    outs = iter([json.dumps({"total_cost_usd": 0.2, "result": "not json", "modelUsage": use(100)}),
                 json.dumps({"total_cost_usd": 0.3, "modelUsage": use(200),
                             "structured_output": {"items": [{"id": "a", "verdict": "PASS", "reason": "r"}]}})])
    monkeypatch.setattr(judge, "_call", lambda *a: SimpleNamespace(stdout=next(outs)))
    v = judge.one_vote("p", "m", ["a"])
    assert v["tokens_by_model"]["judge-m"]["input"] == 300 and v["tokens_by_model"]["judge-m"]["output"] == 2

    def trial(spec, n):
        r = make_rec(spec)
        if spec["arm"] == "v1":
            r["metrics"].update(tokens_total=220, tokens_total_all_attempts=330)
        return r
    data, _ = fake_run(monkeypatch, tmp_path, [make_case("W0")], trial, k=2, canary=False)
    v1 = data["aggregate"]["arms"]["v1"]
    assert v1["mean_tokens"] == 220 and v1["mean_tokens_all_attempts"] == 330
    assert data["aggregate"]["arms"]["none"]["mean_tokens_all_attempts"] == 10
    _, text = report.write_reports(data, tmp_path / "out")
    assert "incl. retried attempts" in text
