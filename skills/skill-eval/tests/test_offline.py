"""Offline tests: no model calls. Run: uv run --with pytest pytest tests"""
import json

from skill_eval.checks import (check_no_answer_key_access, check_sources_hit, check_workspace_unchanged, extract_paths,
                               majority, score_trial)
from skill_eval.stats import NO_DIFF, pass_at_k, pass_hat_k, paired_bootstrap, verdict


def test_extract_paths_block():
    a = "x\n```paths\n- .github/workflows/ci.yml\n1\tapp/(marketing)/p/page.tsx\n3. lib/a.ts:12\n./lib/b.ts\n```"
    assert extract_paths(a) == {".github/workflows/ci.yml", "app/(marketing)/p/page.tsx", "lib/a.ts", "lib/b.ts"}


def test_extract_paths_prose():
    assert extract_paths("see (lib/x.ts) and `app/(g)/y/page.tsx:3`") == {"lib/x.ts", "app/(g)/y/page.tsx"}


def test_gate_beats_polite_answer():
    hard = [{"check": "set_match", "category": "correctness", "gate": True, "ok": False, "detail": "recall 0.40"},
            {"check": "skill_loaded", "category": "routing", "gate": False, "ok": True, "detail": ""}]
    votes = [{"items": [{"id": "tone", "verdict": "PASS"}]}] * 3
    assert score_trial(hard, votes, 0.7)["score"] == 0.0


def test_majority_and_score():
    votes = [{"items": [{"id": "a", "verdict": "PASS"}, {"id": "b", "verdict": "FAIL"}]},
             {"items": [{"id": "a", "verdict": "PASS"}, {"id": "b", "verdict": "PASS"}]},
             {"items": [{"id": "a", "verdict": "FAIL"}, {"id": "b", "verdict": "FAIL"}]}]
    assert majority(votes) == {"a": "PASS", "b": "FAIL"}
    s = score_trial([], votes, 0.7)
    assert s["score"] == 0.5 and not s["passed"]


def test_pass_k():
    assert pass_at_k(3, 1, 3) == 1.0 and pass_hat_k(3, 2, 3) == 0.0 and pass_hat_k(3, 3, 3) == 1.0


def test_bootstrap_zero_width_means_no_data():
    d, ci = paired_bootstrap({"a": 1.0, "b": 1.0}, {"a": 1.0, "b": 1.0})
    assert d == 0 and ci == (0.0, 0.0)


def test_extract_json_block_site_unit():
    a = 'Done.\n```json\n["./lib/a.ts:12", "lib/b.ts:3:7", "lib/c.ts:9-11"]\n```\nalso lib/zz.ts:1 in prose'
    assert extract_paths(a, "site") == {"lib/a.ts:12", "lib/b.ts:3", "lib/c.ts:9"}
    assert extract_paths(a, "file") == {"lib/a.ts", "lib/b.ts", "lib/c.ts"}


def test_sources_hit_needs_overlapping_lines(tmp_path):
    key = tmp_path / "W.json"
    key.write_text(json.dumps({"sources": [{"commit": "0a1b2c3d"}, {"path": "docs/x.md", "lines": [16, 28]}]}))
    t = lambda s: {"final": s}  # noqa: E731
    assert not check_sources_hit({"key": str(key)}, t("see docs/x.md:3-9"))["ok"]         # same file, other lines
    assert check_sources_hit({"key": str(key)}, t("see docs/x.md:20"))["ok"]
    r = check_sources_hit({"key": str(key)}, t("commit 0a1b2c3d4e5f and docs/x.md:28-30"))
    assert r["ok"] and r["recall"] == 1.0 and r["hit_at_3"]


def test_key_access_seen_in_read_bash_python():
    from pathlib import Path
    keys = str(Path.home() / "kit" / "eval-cases")
    for call in ({"name": "Read", "input": {"file_path": keys + "/answer-keys/FA01.json"}},
                 {"name": "Bash", "input": {"command": "cat ~/kit/eval-cases/find-all.json"}},
                 {"name": "Bash", "input": {"command": f"python3 -c \"open('{keys}/x').read()\""}}):
        assert not check_no_answer_key_access({"paths": [keys]}, {"tool_calls": [call]})["ok"], call
    assert check_no_answer_key_access({"paths": [keys]}, {"tool_calls": [{"name": "Bash", "input": {"command": "ls lib"}}]})["ok"]


def test_workspace_unchanged():
    clean = {"ws_state": {"tracked_changes": [], "untracked": ["notes.txt"], "head_ok": True}}
    dirty = {"ws_state": {"tracked_changes": [" M lib/a.ts"], "untracked": [], "head_ok": True}}
    assert check_workspace_unchanged({}, clean)["ok"] and not check_workspace_unchanged({}, dirty)["ok"]


def test_verdict_does_not_presume():
    assert verdict(0.0, (0.0, 0.0)) == NO_DIFF and verdict(0.2, (-0.1, 0.4)) == NO_DIFF
    assert "하락" in verdict(-0.3, (-0.5, -0.1))


def test_cites_exist_ignores_ids_but_catches_claimed_commits(tmp_path):
    import subprocess
    from skill_eval.checks import check_cites_exist
    run = lambda *a: subprocess.run(["git", "-C", str(tmp_path), *a], capture_output=True, text=True, check=True)  # noqa: E731
    run("init", "-q")
    (tmp_path / "a.ts").write_text("x\n")
    (tmp_path / "Dockerfile.web").write_text("FROM x\nRUN y\n")
    (tmp_path / "services" / "billing").mkdir(parents=True)
    (tmp_path / "services" / "billing" / "CLAUDE.md").write_text("1\n2\n3\n")
    (tmp_path / "changes").mkdir()
    (tmp_path / "changes" / "20261001-retry-rule.md").write_text("1\n2\n")
    run("add", "."), run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c")
    head = run("rev-parse", "HEAD").stdout.strip()
    grade = lambda text: check_cites_exist({"min": 1}, {"final": text}, repo=tmp_path, commit=head)  # noqa: E731
    ok = grade(f"See a.ts:1 and commit {head[:8]}. User 80b99389-f8a6-4db3-81da-3dc9d6c735aa hit Run cca1769f.")
    assert ok["ok"], ok
    assert ok["n_cites"] == 2
    assert not grade("See a.ts:1 and commit deadbee1.")["ok"]          # a claimed commit that does not exist
    assert not grade("See a.ts:1 (`deadbee1`).")["ok"]                  # a bare SHA in backticks is claimed too
    assert grade("See a.ts:1. On 2026-10-16, run `cca1769f` failed; it returns `res.json({ ok })`.")["ok"]
    short = grade("See services/billing/CLAUDE.md:1-2, then `billing/CLAUDE.md:3` and `retry-rule.md:2`.")
    assert short["ok"], short                                           # shortened forms of real files
    assert not grade("See a.ts:1 and lib/made-up.ts:3.")["ok"]          # a path that does not exist
    assert not grade("See a.ts:9.")["ok"]                               # a line past the end of the file
    assert grade("The heap is set in `Dockerfile.web:2`.")["ok"]       # build files named Dockerfile[.x] are paths
    assert not grade("See Dockerfile.web:9.")["ok"]                     # ... and their line range is checked
    assert not grade("See a.ts:1 and docker/Dockerfile.api:1.")["ok"]   # ... and a missing one fails
    from skill_eval.checks import PATH_RE
    assert [m.group(1) for m in PATH_RE.finditer("Dockerfiles and myDockerfile.web, Dockerfile.")] == ["Dockerfile"]
