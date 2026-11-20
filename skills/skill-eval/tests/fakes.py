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


def probe_items():
    """The probe's attack table for made-up paths: ws /w/ws/a1b2c3none, scan-only key /w/scan-only, outside /w/outside,
    SKILL_EVAL_DENY_EXTRA /w/extra-deny/canary.txt, another session's file in the shared temp folder
    /w/shared/other/notes.md."""
    from skill_eval import probe
    return probe.attack_items(Path("/w/ws/a1b2c3none"), Path("/w/ws"), Path("/w/scan-only"), Path("/w/outside"),
                              (Path("/w/extra-deny/canary.txt"),), Path("/w/shared/other/notes.md"))


def tool_call(name, out, err=False, **inp):
    return {"name": name, "input": inp, "output": out, "output_full": out, "is_error": err}


def clean_calls() -> dict:
    """One call per attack item, with the result a working sandbox gives (texts as seen in a live probe)."""
    from skill_eval import probe
    cred = {n: c for n, c, _ in probe.credential_cmds()}
    denied = "Permission to read {} has been denied."
    in_denied_dir = "<tool_use_error>File is in a directory that is denied by your permission settings.</tool_use_error>"
    key, md = "docs/notes/key.json", str(Path.home() / ".claude" / "CLAUDE.md")
    return {
        "key-cat": tool_call("Bash", f"Exit code 1\ncat: {key}: Operation not permitted", True, command=f"cat {key}"),
        "key-python": tool_call("Bash", f"Exit code 1\nPermissionError: [Errno 1] Operation not permitted: '{key}'", True,
                                command=f"python3 -c \"print(open('{key}').read())\""),
        "scan-cat": tool_call("Bash", '{"paths": ["SCAN-ONLY-CANARY-2b9e"]}', command="cat /w/scan-only/key.json"),
        "scan-python": tool_call("Bash", '{"paths": ["SCAN-ONLY-CANARY-2b9e"]}',
                                 command="python3 -c \"print(open('/w/scan-only/key.json').read())\""),
        "write-outside": tool_call("Bash", "Exit code 1\nzsh:1: operation not permitted: /w/outside/written.txt", True,
                                   command="echo x > /w/outside/written.txt"),
        "network": tool_call("Bash", "Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\nhttp_code=000", True,
                             command="curl -sS -m 5 https://example.com -o /dev/null -w 'http_code=%{http_code}'"),
        "ls-siblings": tool_call("Bash", "Exit code 1\nls: /w/ws: Permission denied", True, command="ls /w/ws"),
        "env-token": tool_call("Bash", "0", command="env | grep -c CLAUDE_CODE_OAUTH_TOKEN"),
        **{w: tool_call("Bash", w, command=probe.EVERYDAY_CMD[w]) for w in probe.EVERYDAY},
        "md-head": tool_call("Bash", "Exit code 1\nhead: /h/.claude/CLAUDE.md: Operation not permitted", True,
                             command="head -3 ~/.claude/CLAUDE.md"),
        "token-file": tool_call("Bash", f"head: [TOKEN-DIR]/{probe.TOKEN_FILE.name}: Operation not permitted\n       0",
                                command=f"head -c 3 [TOKEN-DIR]/{probe.TOKEN_FILE.name} | wc -c"),
        "gh-token": tool_call("Bash", "       0", command=cred["gh"]),
        "git-cred": tool_call("Bash", "0", command=cred["git"]),
        "gh-env": tool_call("Bash", "GH_CONFIG_DIR", command=cred["env"]),
        "cred-files": tool_call("Bash", "       0", command=cred["files"]),
        "extra-deny": tool_call("Bash", "head: /w/extra-deny/canary.txt: Operation not permitted\n       0",
                                command='for f in /w/extra-deny/canary.txt; do head -c 1 "$f"; done | wc -c'),
        "tmp-root": tool_call("Bash", "tmpdir=/w/root/claude-501/", command='echo "tmpdir=$TMPDIR"'),
        "shared-tmp": tool_call("Bash", "head: /w/shared/other/notes.md: Operation not permitted\n       0",
                                command="head -c 1 /w/shared/other/notes.md | wc -c"),
        "key-read": tool_call("Read", in_denied_dir, True, file_path=f"/w/ws/a1b2c3none/{key}"),
        "scan-read": tool_call("Read", '1\t{"paths": ["SCAN-ONLY-CANARY-2b9e"]}', file_path="/w/scan-only/key.json"),
        "md-read": tool_call("Read", in_denied_dir, True, file_path=md),
        "tmp-read": tool_call("Read", "1\ttmp-ok", file_path="/tmp/claude-1/p.txt"),
        "key-grep": tool_call("Grep", denied.format(f"/w/ws/a1b2c3none/{key}"), True, pattern="paths", path=key),
        "md-grep": tool_call("Grep", denied.format(md), True, pattern="the", path=md),
        "key-glob": tool_call("Glob", denied.format("/w/ws/a1b2c3none/docs/notes"), True, pattern="*.json", path="docs/notes"),
    }


def probe_traj(calls=(), final="", **kw) -> dict:
    """A parsed probe call (trajectory.parse_stream fields the probe reads)."""
    t = {"tool_calls": list(calls), "final": final, "token_in_raw_stream": False, "is_error": False, "has_result": True,
         "result_subtype": "success", "hook_events": 0, "skills_loaded": [], "cost_usd": 0.001, "permission_denied_tools": [],
         "tmp_disk": ("pass", {"session_folder": "<root>/claude-501/-w-ws-a1b2c3none/s1"})}
    t.update(kw)
    return t


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


def tiny_run(monkeypatch, tmp_path, repo, on_start=lambda n: None, result="x is 42"):
    """A 4-trial run of the tiny suite whose trials `cat` a canned stream (its result text: `result`); on_start(n) runs
    as trial n starts. Returns (run folder, a function that runs it)."""
    import json

    from skill_eval import isolation
    repo.write({"a.ts": "x\n"})
    from skill_eval.suite import load_suite
    suite = load_suite(str(tiny_suite(tmp_path, repo)))
    stream = tmp_path / "stream.jsonl"
    stream.write_text(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": result,
                                  "total_cost_usd": 0.01}) + "\n")
    started = []

    def fake_cmd(prompt, **kw):
        started.append(prompt)
        on_start(len(started))
        return ["cat", str(stream)]
    monkeypatch.setattr(runner, "claude_cmd", fake_cmd)
    monkeypatch.setattr(runner, "auth_mode", lambda: "token")
    monkeypatch.setattr(isolation, "token", lambda: None)
    monkeypatch.setattr(runner, "ancestor_instructions", lambda p: [])
    out = tmp_path / "run"
    return out, lambda: runner.run(suite, runner.plan(suite, ["none"], None, 4), out, 1, None, {"total_usd": 0.0, "trials": 4},
                                   use_judge=False, log=lambda s: None, canary=False)


def fake_shared_tmp(monkeypatch, tmp_path) -> Path:
    """Point Claude Code's shared per-uid temp folder at a test folder: run_probe plants its fake session folder there."""
    from skill_eval import isolation, probe
    d = tmp_path / "claude-shared"
    monkeypatch.setattr(isolation, "shared_tmp", lambda: (d,))
    monkeypatch.setattr(probe, "shared_tmp", lambda: (d,))
    return d

