"""grading-v3 (lane K): a path or commit that is not in the repo but that the frozen GitHub corpus names is
GitHub-backed (neither valid nor missing); files the harness prepared are not citations; the probe denies what trials
deny. Offline: temp git repos and JSON files with made-up data, no network, no model."""
import json
from pathlib import Path

import pytest
from conftest import lines

from skill_eval import probe, runner
from skill_eval.checks import check_cites_exist, gh_commit, github_index, is_prepared, prepared_roots
from skill_eval.suite import SuiteError, load_github_index, load_suite

GONE_SHA = "5e1f00d7c0ffee1234567890abcdef1234567890"       # a PR head: in the corpus, not in the repo
EVIDENCE = {"repo": "o/r", "items": {"pr:7": None, "rc:70": 7},
            "paths": ["svc/lever/title-pick.ts", "scripts/ab/titles.ts", "web/static"], "commits": [GONE_SHA, "abc1234"]}


def _evidence(tmp_path, data=EVIDENCE):
    p = tmp_path / "github-evidence.json"
    p.write_text(json.dumps(data))
    github_index.cache_clear()
    return p


@pytest.fixture
def grade(tmp_path, repo):
    repo.write({"svc/lever/hook.ts": lines(5), "docs/notes.md": lines(9)})
    head = repo.commit()
    args = {"min": 1, "github_evidence": str(_evidence(tmp_path)), "prepared": [".brain/v2.db", ".brain/github-dump.json"]}
    return lambda text, a=args: check_cites_exist(a, {"final": text}, repo=repo.root, commit=head)


def test_files_of_an_unmerged_pr_are_github_backed_not_missing(grade):
    r = grade("PR #7 was closed. Its files `svc/lever/title-pick.ts` and `scripts/ab/titles.ts` are not in main; "
              "today's code is svc/lever/hook.ts:2-4.")
    assert r["ok"], r
    assert r["missing"] == [] and r["github_backed"] == ["scripts/ab/titles.ts", "svc/lever/title-pick.ts"]
    assert r["n_cites"] == 2                     # hook.ts + pr:7; GitHub-backed names never count as citations


def test_a_shortened_corpus_path_and_a_line_on_it_are_github_backed(grade):
    r = grade("The rejected version lived in lever/title-pick.ts:40-60 (see pr:7).")
    assert r["ok"] and r["github_backed"] == ["lever/title-pick.ts"], r


def test_a_pr_head_sha_from_a_review_is_github_backed(grade):
    r = grade(f"Round 2 reviewed head `{GONE_SHA[:8]}` (rc:70); see svc/lever/hook.ts:1.")
    assert r["ok"] and r["github_backed"] == [f"commit {GONE_SHA[:8]}"], r
    r = grade("Commit abc1234567 (a longer form of a short corpus SHA) is in pr:7.")
    assert r["ok"] and r["github_backed"] == ["commit abc1234567"], r


def test_names_that_exist_nowhere_are_still_missing(grade):
    r = grade("See svc/lever/made-up.ts:3 and commit `deadbeef12` (pr:7).")
    assert not r["ok"] and r["missing_kinds"] == {"no_such_file": 1, "not_a_commit": 1}, r


def test_line_ranges_on_repo_files_stay_strict(grade):
    r = grade("See docs/notes.md:1-10 and pr:7.")             # the file has 9 lines
    assert not r["ok"] and r["missing_kinds"] == {"bad_line_range": 1}, r


def test_prepared_files_are_not_citations(grade):
    r = grade("The comments are in the exported `.brain/github-dump.json` (pointers pr:7, rc:70); I also read .brain/.")
    assert r["ok"] and r["missing"] == [] and r["prepared_skipped"] == [".brain/github-dump.json"], r
    assert r["n_cites"] == 2                     # pr:7 and rc:70


def test_github_backed_alone_does_not_satisfy_min(grade):
    r = grade("The files were `svc/lever/title-pick.ts` and `scripts/ab/titles.ts`.")
    assert not r["ok"] and r["missing"] == [] and r["n_cites"] == 0, r


def test_without_paths_or_commits_the_old_rule_holds(tmp_path, repo):
    repo.write({"a.ts": lines(3)})
    head = repo.commit()
    old = {"repo": "o/r", "items": {"pr:7": None}}
    args = {"min": 1, "github_evidence": str(_evidence(tmp_path, old))}
    r = check_cites_exist(args, {"final": "See svc/lever/title-pick.ts and pr:7."}, repo=repo.root, commit=head)
    assert not r["ok"] and r["missing_kinds"] == {"no_such_file": 1}, r
    r = check_cites_exist({"min": 1}, {"final": "See .brain/x.json and a.ts:1."}, repo=repo.root, commit=head)
    assert not r["ok"] and r["missing_kinds"] == {"no_such_file": 1}, r   # no prepare_outputs: no skip


def test_helpers():
    roots = prepared_roots([".brain/v2.db", "index.db"])
    assert roots == {".brain/v2.db", ".brain", "index.db"}
    assert is_prepared(".brain/github-dump.json", roots) and is_prepared("index.db", roots)
    assert not is_prepared("brain/x.ts", roots) and not is_prepared("src/index.db", roots)
    assert gh_commit("5e1f00d", frozenset([GONE_SHA])) and not gh_commit("5e1f00e", frozenset([GONE_SHA]))
    assert not gh_commit("5e1f00d", frozenset())


@pytest.mark.parametrize("bad", [{"paths": "svc/a.ts"}, {"paths": [""]}, {"commits": ["XYZ1234"]}, {"commits": ["abc12"]}])
def test_evidence_paths_and_commits_are_validated(tmp_path, bad):
    with pytest.raises(SuiteError):
        load_github_index(_evidence(tmp_path, {**EVIDENCE, **bad}))


def test_evidence_loads_sets(tmp_path):
    idx = load_github_index(_evidence(tmp_path, {**EVIDENCE, "paths": ["./svc/a.ts", "web/static/"]}))
    assert idx["paths"] == {"svc/a.ts", "web/static"} and GONE_SHA in idx["commits"]


def test_suite_passes_prepare_outputs_to_cites_exist(tmp_path, repo):
    repo.write({"a.ts": lines(3)})
    head = repo.commit()
    d = tmp_path / "suite"
    (d / "cases").mkdir(parents=True)
    (d / "cases" / "w.yaml").write_text("id: W\nkind: why\nprompt: why?\nchecks:\n  hard:\n    - cites_exist: {min: 1}\n")
    (d / "suite.yaml").write_text(f"name: t\nskill: demo\narms: {{none: null}}\nrepo: {{path: {repo.root}, commit: {head}}}\n"
                                  "cases: cases/*.yaml\ncompare: []\nprepare: 'true'\nprepare_outputs: [.idx/i.db]\n")
    s = load_suite(d / "suite.yaml")
    assert s.cases[0].hard[0]["cites_exist"]["prepared"] == [".idx/i.db"]


def test_probe_denies_the_host_paths_trials_deny(tmp_path, monkeypatch):
    extra = tmp_path / "other-copy"
    monkeypatch.setenv("SKILL_EVAL_DENY", str(extra))
    trusted, root = tmp_path / "keys", tmp_path / "probe-root"
    assert probe.probe_deny(trusted, root) == [trusted, extra] == [trusted, *runner.host_deny()]
    monkeypatch.setenv("SKILL_EVAL_DENY", str(tmp_path))          # the probe's own temp root inside a denied path
    with pytest.raises(RuntimeError):
        probe.probe_deny(trusted, root)


def test_probe_flags_everyday_bash_that_fails():
    ok = {"name": "Bash", "input": {"command": "B=/bin/echo; $B var-ok"}, "is_error": False, "output": "var-ok"}
    cwd = {"name": "Bash", "input": {"command": "for f in *; do :; done; echo loop-ok"}, "is_error": True,
           "output": "Exit code 1\nloop-ok\nzsh:1: operation not permitted: /tmp/x/cwd-1a2b"}
    other = {"name": "Bash", "input": {"command": "cat docs/notes/key.json"}, "is_error": True, "output": "denied"}
    assert probe.everyday_errors([ok, other]) == []
    assert probe.everyday_errors([ok, cwd, other]) == ["zsh:1: operation not permitted: /tmp/x/cwd-1a2b"]


def test_estimate_uses_the_measured_rates():
    assert runner.DEFAULT_AGENT_USD["sonnet"]["why"] == 0.17 and runner.DEFAULT_JUDGE_VOTE_USD["opus"] == 0.122
    assert Path(runner.__file__).name == "runner.py"
