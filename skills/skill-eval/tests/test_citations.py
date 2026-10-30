"""grading-v2: one citation resolver for cites_exist, sources_hit and the judge's excerpts (E1), and labels on
cites_exist failures (E2). Offline: temp git repos only."""
import json

import pytest
from conftest import lines
from fakes import tiny_suite

from skill_eval import checks, cli, judge, runner
from skill_eval.checks import check_cites_exist, check_sources_hit, citations, resolve_path, tracked_files


def _tree(repo):
    repo.write({"src/lib/credits.ts": lines(10), "pipeline/job-failure.ts": lines(5, "why"),
                "docs/a/index.ts": lines(3), "docs/b/index.ts": lines(3),
                "changes/20261001-retry-rule.md": lines(2), "old/legacy.ts": lines(4),
                "README.md": "see 0a1b2c3d4e for the old fix\n"})
    first = repo.commit("first")
    (repo.root / "old" / "legacy.ts").unlink()
    return first, repo.commit("drop legacy")


def test_resolver_unique_ambiguous_and_loose_names(repo):
    _, head = _tree(repo)
    files = tracked_files(repo.root, head)
    assert resolve_path("pipeline/job-failure.ts", files) == ["pipeline/job-failure.ts"]
    assert resolve_path("job-failure.ts", files) == ["pipeline/job-failure.ts"]           # unique shortened form
    assert resolve_path("lib/credits.ts", files) == ["src/lib/credits.ts"]
    assert resolve_path("retry-rule.md", files) == ["changes/20261001-retry-rule.md"]       # date-prefixed note
    assert resolve_path("index.ts", files) == ["docs/a/index.ts", "docs/b/index.ts"]       # ambiguous
    assert resolve_path("failure.ts", files) == []                                         # part of a name is not a path
    assert resolve_path("redits.ts", files) == []


def test_line_ranges_must_lie_inside_the_file(repo):
    _, head = _tree(repo)
    grade = lambda text: check_cites_exist({"min": 1}, {"final": text}, repo=repo.root, commit=head)  # noqa: E731
    assert grade("See src/lib/credits.ts:3-5.")["ok"]
    assert grade("See src/lib/credits.ts:10.")["ok"]
    assert grade("See src/lib/credits.ts:3:7.")["ok"]                    # line 3, column 7
    for bad in (":0", ":11", ":5-3", ":3-999999", ":0-2"):
        r = grade(f"See src/lib/credits.ts{bad}.")
        assert not r["ok"], (bad, r)
        assert r["missing_kinds"] == {"bad_line_range": 1}, (bad, r)
    assert citations("a.ts:3:7 and b.ts:4-6") == [{"path": "a.ts", "lines": (3, 3)}, {"path": "b.ts", "lines": (4, 6)}]


def test_ambiguous_short_path_exists_but_cannot_hit_a_key_source(repo, tmp_path):
    _, head = _tree(repo)
    assert check_cites_exist({"min": 1}, {"final": "See index.ts:2."}, repo=repo.root, commit=head)["ok"]
    key = tmp_path / "W.json"
    key.write_text(json.dumps({"sources": [{"path": "docs/a/index.ts", "lines": [1, 3]}]}))
    assert not check_sources_hit({"key": str(key)}, {"final": "See index.ts:2."}, repo=repo.root, commit=head)["ok"]
    assert check_sources_hit({"key": str(key)}, {"final": "See a/index.ts:2."}, repo=repo.root, commit=head)["ok"]


def test_sources_hit_and_judge_use_the_same_resolver(repo, tmp_path):
    _, head = _tree(repo)
    key = tmp_path / "W.json"
    key.write_text(json.dumps({"sources": [{"path": "pipeline/job-failure.ts", "lines": [1, 5]}]}))
    traj = {"final": "The reason is in job-failure.ts:2."}
    assert check_cites_exist({"min": 1}, traj, repo=repo.root, commit=head)["ok"]
    r = check_sources_hit({"key": str(key)}, traj, repo=repo.root, commit=head)
    assert r["ok"] and r["recall"] == 1.0, r
    assert not check_sources_hit({"key": str(key)}, traj)["ok"]          # no repo given: paths compare as written
    cite = checks.resolved_citations(traj["final"], repo.root, head)[0]
    assert cite["path"] == "pipeline/job-failure.ts" and cite["as_written"] == "job-failure.ts"
    assert "why 2" in judge.excerpt(repo.root, head, cite)
    assert "ambiguous" in judge.excerpt(repo.root, head, checks.resolved_citations("index.ts:1", repo.root, head)[0])
    assert "outside" in judge.excerpt(repo.root, head, {"path": "src/lib/credits.ts", "lines": (5, 3)})


def test_cites_exist_failure_labels(repo):
    _, head = _tree(repo)
    grade = lambda text: check_cites_exist({"min": 1}, {"final": text}, repo=repo.root, commit=head)  # noqa: E731
    cases = {"See src/lib/credits.ts:1 and commit 0a1b2c3d4e.": "not_a_commit",       # a SHA that is only repo text
             "See src/lib/credits.ts:1 and commit deadbee1.": "not_a_commit",
             "See old/legacy.ts:2.": "deleted_file",
             "See legacy.ts:2.": "deleted_file",
             "See lib/made-up.ts:3.": "no_such_file",
             "See src/lib/credits.ts:12.": "bad_line_range"}
    for text, kind in cases.items():
        r = grade(text)
        assert not r["ok"] and r["missing_kinds"] == {kind: 1}, (text, r)
    in_text = grade("See src/lib/credits.ts:1 and commit 0a1b2c3d4e.")["missing_labeled"][0]
    assert in_text["in_repo_text"] is True
    assert grade("See src/lib/credits.ts:1 and commit deadbee1.")["missing_labeled"][0]["in_repo_text"] is False
    ok = grade("See src/lib/credits.ts:1.")
    assert ok["ok"] and ok["missing_kinds"] == {} and ok["missing_labeled"] == []


def test_grading_version_is_recorded():
    assert checks.GRADING_VERSION == "grading-v2"
    assert judge.JUDGE_VERSION == "judge-v4"


def test_old_grading_version_is_not_silently_regraded(tmp_path, capsys):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "results.json").write_text(json.dumps({"meta": {"suite_file": "missing.yaml"}, "trials": []}))
    assert cli.main(["grade", str(run_dir)]) == 1
    assert "graded with grading-v1" in capsys.readouterr().err
