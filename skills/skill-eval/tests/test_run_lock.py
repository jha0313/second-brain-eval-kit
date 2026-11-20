"""One heavy `run` at a time (an atomic flock taken before the probe), memory pressure as a warning only, and an
interrupted run that keeps its finished trials and counts them. Offline: no `claude`; the trials run `cat` of a canned
stream instead."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fakes import tiny_run, tiny_suite

from skill_eval import cli, isolation, runner

SRC = str(Path(__file__).resolve().parents[1])
HOLD = """
import sys, time
from pathlib import Path
from skill_eval import runner
lock, go, hold = Path(sys.argv[1]), Path(sys.argv[2]), float(sys.argv[3])
while not go.exists():
    time.sleep(0.002)
try:
    with runner.run_lock(lock):
        print("won", flush=True)
        time.sleep(hold)
except runner.RunLocked as e:
    print("refused:", e, flush=True)
"""


def _holder(lock, go, hold):
    return subprocess.Popen([sys.executable, "-c", HOLD, str(lock), str(go), str(hold)], stdout=subprocess.PIPE, text=True,
                            env={**os.environ, "PYTHONPATH": SRC})


def test_two_runs_started_at_once_one_wins_and_one_is_refused(tmp_path):
    lock, go = tmp_path / "run.lock", tmp_path / "go"
    ps = [_holder(lock, go, 2), _holder(lock, go, 2)]
    time.sleep(0.5)                                   # both are waiting at the same line
    go.touch()
    outs = sorted(p.communicate(timeout=30)[0].strip() for p in ps)
    assert outs[1] == "won" and outs[0].startswith("refused: another skill-eval run is running (pid"), outs


def test_the_refusal_names_the_holder_and_the_lock_goes_on_exit_and_on_exception(tmp_path):
    lock, go = tmp_path / "run.lock", tmp_path / "go"
    go.touch()
    p = _holder(lock, go, 30)
    assert p.stdout.readline().strip() == "won"
    with pytest.raises(runner.RunLocked, match=rf"pid {p.pid}, started 20\d\d-"):
        with runner.run_lock(lock):
            pass
    p.kill()
    p.wait()
    with runner.run_lock(lock):                       # a normal exit releases it
        pass
    with pytest.raises(ValueError):
        with runner.run_lock(lock):
            raise ValueError("boom")
    with runner.run_lock(lock):                       # so does an exception
        with pytest.raises(runner.RunLocked):         # held: a second open of the file is refused, also in-process
            with runner.run_lock(lock):
                pass


def test_a_killed_holder_leaves_no_stale_lock(tmp_path):
    lock, go = tmp_path / "run.lock", tmp_path / "go"
    go.touch()
    p = _holder(lock, go, 60)
    assert p.stdout.readline().strip() == "won"
    os.kill(p.pid, signal.SIGKILL)                    # no finally runs: the OS drops the flock with the process
    p.wait()
    assert f"pid {p.pid}" in lock.read_text()         # the file still names the dead holder
    with runner.run_lock(lock):
        assert f"pid {os.getpid()}" in lock.read_text()


def test_run_takes_the_lock_before_the_probe_and_light_commands_do_not(monkeypatch, tmp_path, repo, capsys):
    repo.write({"a.ts": "x\n"})
    suite = tiny_suite(tmp_path, repo)
    probes = []
    monkeypatch.setattr(cli, "run_probe", lambda out, **k: probes.append(out) or {"all_ok": False, "checks": {}})
    monkeypatch.setattr(cli, "format_probe", lambda r: "probe: FAILED")
    with runner.run_lock():                           # another run holds it
        assert cli.main(["run", str(suite), "--dev", "--out", str(tmp_path / "r")]) == 1
        assert probes == [] and f"another skill-eval run is running (pid {os.getpid()}" in capsys.readouterr().err
        assert cli.main(["probe", "--out", str(tmp_path / "p")]) == 2 and len(probes) == 1   # probe alone: no lock
    assert cli.main(["run", str(suite), "--dev", "--out", str(tmp_path / "r")]) == 2         # free again
    assert len(probes) == 2


def test_memory_pressure_only_warns(monkeypatch, tmp_path, repo, capsys):
    level = {"v": "4"}
    monkeypatch.setattr(runner.sys, "platform", "darwin")
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout=level["v"] + "\n"))
    assert "critical" in runner.memory_warning()
    level["v"] = "2"
    assert "raised" in runner.memory_warning()
    level["v"] = "1"
    assert runner.memory_warning() is None
    monkeypatch.setattr(runner.sys, "platform", "linux")
    assert runner.memory_warning() is None
    monkeypatch.undo()
    repo.write({"a.ts": "x\n"})
    suite = tiny_suite(tmp_path, repo)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(runner, "memory_warning", lambda: "memory pressure is critical (level 4)")
    monkeypatch.setattr(cli, "run_probe", lambda out, **k: {"all_ok": False, "checks": {}})
    monkeypatch.setattr(cli, "format_probe", lambda r: "probe: FAILED")
    assert cli.main(["run", str(suite), "--dev", "--out", str(tmp_path / "r")]) == 2         # it went on to the probe
    assert "warning: memory pressure is critical" in capsys.readouterr().out


class Killed(BaseException):
    """Stands in for the process dying mid-run (not an Exception: the runner's per-trial handler does not catch it)."""


def _die_at_3(n):                                     # trial 3 and later: the process "dies" as the trial starts
    if n >= 3:
        raise Killed


def test_an_interrupted_run_keeps_its_finished_trials_and_report_counts_them(monkeypatch, tmp_path, repo, capsys):
    out, run = tiny_run(monkeypatch, tmp_path, repo, _die_at_3)
    stale = out / "trials" / "C1__none__9"            # a trial left by an earlier run into the same folder
    stale.mkdir(parents=True)
    (stale / "grade.json").write_text(json.dumps({"trial_id": "C1__none__9", "case": "C1", "arm": "none", "outcome": "fail"}))
    (out / "results.json").write_text(json.dumps({"meta": {"run_id": "earlier"}, "trials": []}))   # that run finished
    with pytest.raises(Killed):
        run()
    assert sorted(p.parent.name for p in (out / "trials").glob("*/grade.json")) == ["C1__none__1", "C1__none__2", "C1__none__9"]
    cut = out / "trials" / "C1__none__7"              # a grade.json cut off mid-write
    cut.mkdir()
    (cut / "grade.json").write_text('{"trial_id": "C1__no')
    rec = runner.recover(out)
    assert rec["counts"] == {"expected": 4, "attempted": 2, "scored": 2, "excluded": {o: 0 for o in rec["counts"]["excluded"]}}
    assert (rec["arms"], rec["recorded_usd"], rec["unreadable"]) == ({"none": {"scored": 2, "passed": 2}}, 0.02, ["C1__none__7"])
    assert cli.main(["report", str(out)]) == 0        # the earlier run's results.json is not this run's
    text = capsys.readouterr().out
    assert "unfinished run (no results.json for it yet: still running, or stopped): 2 of 4 planned trials finished, 2 scored" in text
    assert "none  passed 2/2 scored trial(s)" in text and "recorded cost of the finished trials: $0.02" in text
    assert "unreadable grade.json (cut off mid-write?): C1__none__7" in text


def test_a_runner_exception_is_kept_on_disk_for_recover(monkeypatch, tmp_path, repo):
    def bug_at_2(n):
        if n == 2:
            raise RuntimeError("harness bug")         # caught per trial: an infra_error, and the run stops
    out, run = tiny_run(monkeypatch, tmp_path, repo, bug_at_2)
    run()
    (out / "results.json").unlink()                   # as if the process died before results.json
    rec = runner.recover(out)
    assert (rec["counts"]["attempted"], rec["counts"]["scored"], rec["counts"]["excluded"]["infra_error"]) == (2, 1, 1)


def test_report_reads_a_finished_run_when_plan_json_is_cut_off(monkeypatch, tmp_path, repo, capsys):
    out, run = tiny_run(monkeypatch, tmp_path, repo, lambda n: None)
    run()
    (out / "plan.json").write_text('{"run_id": ')     # (run() replaces it whole; a cut file must not stop the report)
    assert cli.main(["report", str(out)]) == 0 and "unfinished run" not in capsys.readouterr().out


def test_an_unwritable_record_still_stops_the_run(monkeypatch, tmp_path, repo):
    def bug_at_2(n):
        if n == 2:
            raise RuntimeError("harness bug")
    out, run = tiny_run(monkeypatch, tmp_path, repo, bug_at_2)
    (out / "trials" / "C1__none__2" / "grade.json").mkdir(parents=True)   # grade.json cannot be written
    r = run()
    assert [t["outcome"] for t in r["trials"]][:2] == ["pass", "infra_error"] and r["meta"]["stopped"]
    assert {t["outcome"] for t in r["trials"][2:]} == {"skipped_stopped"}


def test_recover_finds_a_case_id_with_a_slash(tmp_path):
    (tmp_path / "plan.json").write_text(json.dumps({"run_id": "r1", "arms": ["none"], "expected": 2}))
    t = tmp_path / "trials" / "api" / "login__none__1"
    t.mkdir(parents=True)
    (t / "grade.json").write_text(json.dumps({"run_id": "r1", "arm": "none", "outcome": "pass", "passed": True,
                                              "metrics": {"agent_usd": 0.01, "judge_usd": 0}}))
    rec = runner.recover(tmp_path)
    assert rec["counts"]["attempted"] == 1 and rec["arms"]["none"] == {"scored": 1, "passed": 1}
    assert not hasattr(runner, "fcntl")               # imported in run_lock() only: `report` loads without it


def test_the_first_write_of_a_trial_stream_is_already_redacted(monkeypatch, tmp_path, repo):
    out, run = tiny_run(monkeypatch, tmp_path, repo, result="the token is test-token-value-123")
    monkeypatch.setattr(isolation, "token", lambda: "test-token-value-123")
    real, first = Path.write_text, []

    def write_then_die(self, data, *a, **k):
        n = real(self, data, *a, **k)
        if self.name == "trajectory.jsonl":
            first.append(self.read_text())
            raise Killed                              # the process dies right after its first write
        return n
    monkeypatch.setattr(Path, "write_text", write_then_die)
    with pytest.raises(Killed):
        run()
    assert first and all("test-token-value-123" not in t and "[REDACTED-TOKEN]" in t for t in first)
    left = [p for p in out.rglob("*") if p.is_file() and "test-token-value-123" in p.read_text(errors="replace")]
    assert left == []


def test_a_run_killed_before_redaction_leaves_no_raw_stream(monkeypatch, tmp_path, repo):
    out, run = tiny_run(monkeypatch, tmp_path, repo, result="the token is test-token-value-123")
    monkeypatch.setattr(isolation, "token", lambda: "test-token-value-123")

    def die(text, **kw):                                    # killed after the trial process ended, before its stream is redacted
        raise Killed
    monkeypatch.setattr(runner, "redact", die)
    with pytest.raises(Killed):
        run()
    assert [p for p in out.rglob("*") if p.is_file() and "test-token-value-123" in p.read_text(errors="replace")] == []


def test_the_claude_token_in_a_trial_stream_is_an_isolation_failure(monkeypatch, tmp_path, repo):
    out, run = tiny_run(monkeypatch, tmp_path, repo, result="the token is test-token-value-123")
    monkeypatch.setattr(isolation, "token", lambda: "test-token-value-123")
    r = run()
    first = r["trials"][0]
    assert first["outcome"] == "isolation_error" and "Claude token" in first["reason"] and r["meta"]["stopped"]
    assert not any("test-token-value-123" in p.read_text(errors="replace") for p in out.rglob("*") if p.is_file())


def test_a_token_in_stderr_of_a_failed_attempt_is_not_retried_away(monkeypatch, tmp_path, repo):
    out, run = tiny_run(monkeypatch, tmp_path, repo)
    monkeypatch.setattr(isolation, "token", lambda: "test-token-value-123")
    calls = []

    def fake_cmd(prompt, **kw):                       # no result event (an infra error), the token on stderr
        calls.append(prompt)
        return ["sh", "-c", "echo test-token-value-123 >&2"]
    monkeypatch.setattr(runner, "claude_cmd", fake_cmd)
    r = run()
    assert len(calls) == 1 and r["trials"][0]["outcome"] == "isolation_error" and r["meta"]["stopped"]
    assert not any("test-token-value-123" in p.read_text(errors="replace") for p in out.rglob("*") if p.is_file())
