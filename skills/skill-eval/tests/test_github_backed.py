"""grading-v3 (lane K): a path or commit that is not in the repo but that the frozen GitHub corpus names is
GitHub-backed (neither valid nor missing); files the harness prepared are not citations; the probe denies what trials
deny. Offline: temp git repos and JSON files with made-up data, no network, no model."""
import json
from pathlib import Path

import pytest
from conftest import lines
from fakes import probe_items, tool_call

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
    # a longer form of a short corpus SHA: its extra characters cannot be checked, so it is not backed
    r = grade("Commit abc1234567 (a longer form of a short corpus SHA) is in pr:7.")
    assert not r["ok"] and r["missing_kinds"] == {"not_a_commit": 1}, r
    r = grade(f"Commit {GONE_SHA[:7]}fffffffffffffffffffffffffffffffff is in pr:7; see svc/lever/hook.ts:1.")
    assert not r["ok"], r


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


def test_a_prepared_output_inside_a_repo_folder_hides_no_repo_citation(tmp_path, repo):
    repo.write({"svc/lever/hook.ts": lines(5)})
    head = repo.commit()
    args = {"min": 1, "prepared": ["svc/cache/dump.json"]}
    grade = lambda text: check_cites_exist(args, {"final": text}, repo=repo.root, commit=head)  # noqa: E731
    r = grade("See svc/lever/hook.ts:2.")
    assert r["ok"] and r["n_cites"] == 1, r                                  # a real repo file still counts
    r = grade("See svc/lever/hook.ts:2 and svc/no-such-file.ts:3.")
    assert not r["ok"] and r["missing_kinds"] == {"no_such_file": 1}, r      # "svc" is a repo folder: no blanket skip
    r = grade("See svc/lever/hook.ts:9 and svc/cache/dump.json.")
    assert not r["ok"] and r["missing_kinds"] == {"bad_line_range": 1}, r    # the output itself is skipped, the range is not
    assert r["prepared_skipped"] == ["svc/cache/dump.json"]


def test_the_judge_sees_exempt_names_as_exempt(tmp_path, repo):
    from types import SimpleNamespace
    from skill_eval import judge
    repo.write({"svc/lever/hook.ts": lines(5)})
    head = repo.commit()
    ev = str(_evidence(tmp_path))
    case = SimpleNamespace(hard=[{"cites_exist": {"min": 1, "github_evidence": ev, "prepared": [".brain/github-dump.json"]}}],
                           key_paths=lambda kinds=None: [])
    out = judge._excerpts(case, {"final": f"See svc/lever/title-pick.ts:3, commit {GONE_SHA[:8]}, .brain/github-dump.json "
                                           "and svc/lever/hook.ts:2."}, repo.root, head)
    assert "the frozen GitHub corpus names this path" in out and "the frozen GitHub corpus names this commit" in out
    assert "github-dump.json" not in out and "(no such file at this commit)" not in out


def test_helpers():
    roots = prepared_roots([".brain/v2.db", "index.db", "svc/cache/i.db"], tracked=["svc/a.ts", "top.md"])
    assert roots == {".brain/v2.db", ".brain", "index.db", "svc/cache/i.db"}    # "svc" is a repo folder
    assert is_prepared(".brain/github-dump.json", roots) and is_prepared("index.db", roots)
    assert not is_prepared("brain/x.ts", roots) and not is_prepared("src/index.db", roots)
    assert gh_commit("5e1f00d", frozenset([GONE_SHA])) and not gh_commit("5e1f00e", frozenset([GONE_SHA]))
    assert not gh_commit("abc1234fff", frozenset(["abc1234"]))
    assert not gh_commit("5e1f00d", frozenset())


@pytest.mark.parametrize("bad", [{"paths": "svc/a.ts"}, {"paths": [""]}, {"paths": ["  "]}, {"paths": False}, {"paths": ["../x.ts"]},
                                 {"paths": ["https://other.invalid/src/nonexistent.ts"]}, {"paths": ["/abs/x.ts"]},
                                 {"commits": ["XYZ1234"]}, {"commits": ["abc12"]}, {"commits": {}}])
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
    assert probe.probe_deny(trusted, root) == [trusted, extra.resolve()] == [trusted, *(p.resolve() for p in runner.host_deny())]
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SKILL_EVAL_DENY", "relative/denied")               # resolved like runner.deny_list does
    assert probe.probe_deny(trusted, root)[1] == (tmp_path / "relative/denied").resolve()
    monkeypatch.setenv("SKILL_EVAL_DENY", str(extra))
    monkeypatch.setenv("SKILL_EVAL_DENY", str(tmp_path))          # the probe's own temp root inside a denied path
    with pytest.raises(RuntimeError):
        probe.probe_deny(trusted, root)


def test_probe_flags_everyday_bash_that_fails():
    C = probe.EVERYDAY_CMD
    items = probe_items()
    ctx = {"detect": "/w/scan-only", "wrote_outside": False, "leaks": probe.leak_finder([])}

    def verdicts(*calls):
        return [probe.judge_item(next(it for it in items if it.id == w), list(calls), items, ctx)[0] for w in probe.EVERYDAY]
    bash = lambda cmd, out, err=False, **extra: tool_call("Bash", out, err, command=cmd, **extra)  # noqa: E731
    var, loop, tmp = bash(C["var-ok"], "var-ok"), bash(C["loop-ok"], "loop-ok"), bash(C["tmp-ok"], "tmp-ok")
    cwd = bash(C["loop-ok"], "Exit code 1\nloop-ok\nzsh:1: operation not permitted: /tmp/x/cwd-1a2b", err=True)
    other = bash("cat docs/notes/key.json", "denied", err=True)
    assert verdicts(var, loop, tmp) == ["pass"] * 3
    assert verdicts(var, cwd, tmp) == ["pass", "fail", "pass"]          # a refused loop: FAIL, it is not asked again
    assert verdicts(var, other) == ["pass", "missing", "missing"]
    typo = bash(C["tmp-ok"], "Exit code 2\nsh: 1: Syntax error: unterminated quoted string", err=True)
    assert verdicts(typo)[2] == "missing"                                # an error that is not a refusal proves nothing
    joined = bash(f"{C['var-ok']}\n{C['loop-ok']}\n{C['tmp-ok']}", "var-ok\nloop-ok\ntmp-ok")
    assert verdicts(joined) == ["pass"] * 3                             # one multi-line call may run all three
    # printing the words is not running the commands, whatever the description or quoted text says
    fake = bash('echo "var-ok loop-ok tmp-ok"', "var-ok loop-ok tmp-ok", description="B=var, for f in lo op, %s-ok' tmp, $TMPDIR")
    quoted = bash("echo 'B=var in lo op %s-ok' tmp' var-ok loop-ok tmp-ok", "B=var in lo op %s-ok tmp var-ok loop-ok tmp-ok")
    assert verdicts(fake) == ["missing"] * 3 and verdicts(quoted) == ["missing"] * 3
    assert "var-ok" not in "".join(C.values()) and "loop-ok" not in "".join(C.values()) and "tmp-ok" not in "".join(C.values())


def test_judge_limit_counts_shown_excerpts(tmp_path, repo):
    from types import SimpleNamespace
    from skill_eval import judge
    repo.write({"svc/lever/hook.ts": lines(5)})
    head = repo.commit()
    case = SimpleNamespace(hard=[{"cites_exist": {"min": 1, "prepared": [f".brain/f{i}.json" for i in range(12)]}}],
                           key_paths=lambda kinds=None: [])
    answer = " ".join(f".brain/f{i}.json" for i in range(12)) + " and svc/lever/hook.ts:2."
    out = judge._excerpts(case, {"final": answer}, repo.root, head)
    assert "svc/lever/hook.ts:2-2" in out and ".brain/f" not in out


def test_estimate_uses_the_measured_rates():
    assert runner.DEFAULT_AGENT_USD["sonnet"]["why"] == 0.17 and runner.DEFAULT_JUDGE_VOTE_USD["opus"] == 0.122
    assert Path(runner.__file__).name == "runner.py"
