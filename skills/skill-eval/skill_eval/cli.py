"""skill-eval command line.

  skill-eval probe [--out DIR]                       prove trial isolation (a few small haiku calls)
  skill-eval selftest SUITE                          grade made-up answers: the key must pass, broken answers fail ($0)
  skill-eval freeze SUITE [--reason TEXT]            write FROZEN.json (hashes of cases, keys, code, rules)
  skill-eval run SUITE --dry-run                     print the plan and the estimated cost; no model calls
  skill-eval run SUITE [-k 3] [-j 4] [--max-usd 20]  run, grade, write results.json + scorecard.html
  skill-eval report RUN_DIR                          rebuild the terminal table and scorecard.html
  skill-eval grade RUN_DIR [--new-grading]           re-grade stored trajectories (hard checks + judge; no agent runs)
  skill-eval keycheck SUITE                          do the answer keys point at real commits, files and lines? ($0)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from . import checks, extract, judge, report, runner, stats
from .freeze import freeze, verify
from .isolation import scan_saved
from .keycheck import check_keys
from .probe import format_probe, run_probe
from .selftest import run_selftest
from .suite import SuiteError, load_suite
from .trajectory import parse_stream


def _csv(s):
    return [x.strip() for x in s.split(",") if x.strip()] if s else None


def cmd_probe(a):
    r = run_probe(Path(a.out), model=a.model, control=not a.no_control)
    print(format_probe(r))
    print(f"\nwrote {runner.short(Path(a.out).resolve() / 'probe.json')}")
    return 0 if r["all_ok"] else 2


def cmd_selftest(a):
    suite = load_suite(a.suite, a.repo)
    rows = run_selftest(suite)
    bad = [r for r in rows if not r["ok"]]
    for r in rows if a.verbose else bad:
        mark = "ok " if r["ok"] else "BAD"
        print(f"  {mark} {r['case']:<6} {r['answer']:<30} want {r['want']:<4} got {r['got']:<4} {'' if r['ok'] else r['detail'][:120]}")
    print(f"selftest: {len(rows)} made-up answers over {len(suite.cases)} cases, {len(bad)} graded wrong")
    return 0 if not bad else 2


def cmd_keycheck(a):
    suite = load_suite(a.suite, a.repo)
    problems = check_keys(suite)
    for p in problems:
        print(f"  BAD {p['where']:<14} {p['problem']}")
    print(f"keycheck: {len(suite.cases)} cases @{suite.commit[:8]}, {len(problems)} problem(s)")
    return 0 if not problems else 2


def cmd_freeze(a):
    suite = load_suite(a.suite, a.repo)
    problems = check_keys(suite)
    if problems:
        raise SuiteError(f"keycheck finds {len(problems)} problem(s), e.g. {problems[0]['where']}: {problems[0]['problem']}. "
                         "Run `skill-eval keycheck SUITE` and fix the keys before freezing")
    bad = [r for r in run_selftest(suite) if not r["ok"]]
    if bad:
        raise SuiteError(f"selftest fails on {len(bad)} answers; fix grading before freezing")
    try:
        path = freeze(suite, a.reason)
    except ValueError as e:
        raise SuiteError(str(e)) from e
    m = json.loads(path.read_text())
    idx = m.get("index_check") or {}
    print(f"frozen {len(suite.cases)} cases, {len(m['keys'])} keys -> {path.name} ({m['frozen_at']})")
    if idx:
        print(f"  index check: prepare has --vault: {idx['prepare_has_vault']} · built DB meta: {json.dumps(idx.get('meta'))}")
    return 0


def cmd_run(a):
    suite = load_suite(a.suite, a.repo)
    if a.model:
        suite.model = a.model
    if a.judge_model:
        suite.judge_model = a.judge_model
    arms = _csv(a.arms) or list(suite.arms)
    unknown = [x for x in arms if x not in suite.arms]
    if unknown:
        raise SuiteError(f"unknown arm(s) {unknown}; suite has {list(suite.arms)}")
    k = a.k or suite.k
    specs = runner.plan(suite, arms, _csv(a.cases), k, a.seed)
    if not specs:
        raise SuiteError("no trials planned (check --cases)")
    cal = runner.load_calibration(a.calibrate) if a.calibrate else None
    est = runner.estimate(suite, specs, a.jobs, cal, use_judge=not a.no_judge)
    frozen, diffs = verify(suite)
    print(plan_table(suite, specs, arms, k, est, a, frozen, diffs))
    if a.dry_run:
        return 0
    if frozen is None and not a.unfrozen:
        raise SuiteError("no FROZEN.json: run `skill-eval freeze SUITE` first (it fixes cases, keys and grading rules "
                         "before any result is seen), or pass --dev for a dev run")
    if diffs and not a.unfrozen:
        rules = (f" Grading rules changed: frozen with {frozen['grading_version']}, this harness is {checks.GRADING_VERSION}."
                 if frozen["grading_version"] != checks.GRADING_VERSION else
                 " The grading code changed since the freeze (same grading version)." if "grading_code" in diffs else "")
        raise SuiteError(f"changed since FROZEN.json ({frozen['frozen_at']}): {diffs}.{rules} Re-freeze with --reason, or --dev for a dev run")
    if a.max_usd is not None and est["total_usd"] > a.max_usd:
        print(f"\nnote: estimate ${est['total_usd']:.2f} is above --max-usd {a.max_usd:.2f}; trials past the cap are skipped.")
    out = Path(a.out or Path(suite.dir) / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S")).resolve()
    data = runner.run(suite, specs, out, a.jobs, a.max_usd, est, use_judge=not a.no_judge, keep_ws=a.keep_workspaces,
                      seed=a.seed, manifest={**frozen, "matches": not diffs} if frozen else None,
                      stop_after_denials=a.stop_after_denials, canary=not a.no_canary)
    html_path, text = report.write_reports(data, out)
    scan = scan_saved(out)                        # grep every saved file for the token (redacts any hit)
    data["meta"]["token_scan"] = scan
    (out / "results.json").write_text(json.dumps(data, indent=1, ensure_ascii=False, default=str))
    print("\n" + text)
    print(f"saved records: token {scan['token']} · {runner.short(out)}/scorecard.html")
    if data["meta"]["stopped"]:
        print(f"run stopped early: {data['meta']['stopped']}")
    return 0 if data["meta"]["isolation"]["all_ok"] and not data["meta"]["stopped"] else 2


def plan_table(suite, specs, arms, k, est, a, frozen=None, diffs=()) -> str:
    cases = list(dict.fromkeys(s["case"].id for s in specs))
    kinds = {}
    for c in suite.cases:
        if c.id in cases:
            kinds[c.kind] = kinds.get(c.kind, 0) + 1
    lines = [f"plan · suite {suite.name} · skill {suite.skill} · repo {suite.label} @{suite.commit[:8]}",
             f"  arms   {', '.join(f'{x}={suite.arms[x].name if suite.arms[x] else chr(8212)}' + (f' + {suite.patches[x].name}' if x in suite.patches else '') for x in arms)}",
             f"  cases  {len(cases)} ({', '.join(f'{v} {k_}' for k_, v in kinds.items())})",
             f"  trials {len(cases)} cases × {len(arms)} arms × k={k} = {len(specs)}",
             f"  order  arms shuffled per case and repeat (seed {a.seed})",
             f"  agent  {suite.model} · tools {suite.tools} · limits {suite.limits['max_turns']} turns, {suite.limits['timeout_s']}s, ${suite.limits['max_usd']:.0f}/trial",
             f"  judge  {suite.judge_model} × {suite.votes} votes, only for rubric cases whose hard checks pass (≤ {est['judge_calls_max']} calls)",
             f"  frozen {'yes, ' + frozen['frozen_at'] + (' — CHANGED: ' + ', '.join(diffs) if diffs else ' (hashes match)') if frozen else 'no FROZEN.json'}",
             f"  estimate{' (calibrated: ' + ', '.join(Path(x).parent.name for x in a.calibrate.split(',')) + ')' if a.calibrate else ' (default rates; --calibrate RESULTS.json for measured ones)'}:",
             f"    agent ${est['agent_usd']:.2f} + judge ≤ ${est['judge_usd']:.2f} + retries ${est['retry_usd']:.2f}"
             f" + probe ${est['probe_usd']:.2f} = ${est['total_usd']:.2f} · ~{est['wall_minutes']:.0f} min with -j {a.jobs}"]
    for arm, r in sorted(est["by_arm"].items(), key=lambda x: list(suite.arms).index(x[0])):
        lines.append(f"    {arm:<5} {r['trials']:>3} trials  ${r['agent_usd'] + r['judge_usd']:.2f}")
    copies = [x for x in arms if x != "v1" and "v1" in arms and suite.arms[x] == suite.arms["v1"] and x not in suite.patches]
    if copies:
        lines.append(f"  A/A    {', '.join(copies)} = same bytes as v1 (its Δ should be ~0)")
    else:
        ref = est["by_arm"].get("v1") or next(iter(est["by_arm"].values()))
        lines.append(f"  A/A    optional: a copy of v1 as one more arm adds ≈ ${ref['agent_usd'] + ref['judge_usd']:.2f} (its Δ should be ~0)")
    if a.max_usd is not None:
        lines.append(f"  cap    --max-usd {a.max_usd:.2f} (waits while spent + reserved would pass it, skips once spent would)")
    return "\n".join(lines)


def cmd_report(a):
    out = Path(a.run_dir).resolve()
    data = json.loads((out / "results.json").read_text())
    html_path, text = report.write_reports(data, out)
    print(text)
    print(f"\nscorecard {html_path}")
    return 0


def cmd_grade(a):
    out = Path(a.run_dir).resolve()
    data = json.loads((out / "results.json").read_text())
    was = data["meta"].get("grading_version", "grading-v1")      # runs before the field existed: seminar-2026-10-31 rules
    if was != checks.GRADING_VERSION and not a.new_grading:
        raise SuiteError(f"this run was graded with {was}; re-grading would apply {checks.GRADING_VERSION} rules. "
                         "Pass --new-grading to do that on purpose (results.json then records both versions).")
    suite = load_suite(os.path.expanduser(data["meta"]["suite_file"]), a.repo)
    cases = {c.id: c for c in suite.cases}
    deny = runner.deny_list(suite, out)
    for rec in data["trials"]:
        # a trial excluded because the grader failed (bad judge votes, a check that raised) has a sound trajectory and is
        # graded again; limits, the agent's own infra errors, runner bugs and isolation errors keep their outcome
        grader_failed = rec["outcome"] == "infra_error" and bool(rec.get("grader_error") or rec.get("grader_exception")) \
            and not rec.get("runner_exception")
        path = out / "trials" / rec["trial_id"] / "trajectory.jsonl"
        if (rec["outcome"] not in ("pass", "fail", "safety_violation", "invalid") and not grader_failed) \
                or rec["case"] not in cases or not path.exists():
            continue
        case = cases[rec["case"]]
        traj = parse_stream(path)
        traj["ws_state"] = rec.get("ws_state")
        hard = checks.run_hard_checks(case, traj, rec["arm"], suite.repo, suite.commit, deny)
        failed = any(h["gate"] and h["ok"] is False for h in hard)
        votes = (judge.judge(case, traj, suite.judge_model, suite.votes, suite.repo, suite.commit)
                 if (case.rubric and not failed and not a.no_judge) else rec.get("votes"))
        used = judge.usable_votes(votes, len(votes) // 2 + 1) if votes and not failed else None
        if votes and not failed and used is None:        # same rule as the runner: a broken judge excludes, never scores 0
            rec.update(hard=hard, votes=votes, outcome="infra_error", score=None, passed=None, rubric=None, grader_error=True,
                       reason=f"grader error: {sum(bool(v.get('grader_error')) for v in votes)}/{len(votes)} judge votes invalid")
            rec["metrics"]["judge_usd"] = sum(v.get("cost_usd", 0) for v in votes)
            continue
        s = checks.score_trial(hard, used, case.pass_threshold)
        rec.update(hard=hard, votes=votes, outcome=s["outcome"], score=s["score"], passed=s["passed"], reason=s["reason"],
                   rubric=s.get("rubric"), grader_error=any(v.get("grader_error") for v in votes or []))
        rec.pop("grader_exception", None)
        rec["metrics"]["judge_usd"] = sum(v.get("cost_usd", 0) for v in votes or [])
    arms = list(data["meta"]["arms"])
    data["aggregate"] = stats.aggregate(data["trials"], arms, list(data["meta"]["cases"]), suite.compare, suite.sensitivity)
    data["meta"]["regraded"] = datetime.now().isoformat(timespec="seconds")
    if was != checks.GRADING_VERSION:
        data["meta"]["graded_first_with"] = data["meta"].get("graded_first_with", was)
    data["meta"]["grading_version"] = checks.GRADING_VERSION
    (out / "results.json").write_text(json.dumps(data, indent=1, ensure_ascii=False, default=str))
    html_path, text = report.write_reports(data, out)
    print(text)
    return 0


def cmd_extract(a):
    out = Path(a.run_dir).resolve()
    rows = extract.extract(out, a.case)
    text = extract.markdown(rows, a.case)
    (out / f"extract-{a.case}.json").write_text(json.dumps({"case": a.case, "trials": rows, "medians": extract.medians(rows)},
                                                           indent=1, ensure_ascii=False))
    (out / f"extract-{a.case}.md").write_text(text + "\n")
    print(text)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="skill-eval", description="Eval harness for Claude Code skills (prototype).")
    sub = p.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("probe", help="prove trial isolation")
    pr.add_argument("--out", default="runs/probe")
    pr.add_argument("--model", default="haiku")
    pr.add_argument("--no-control", action="store_true", help="skip the control call with your normal setup")
    pr.set_defaults(fn=cmd_probe)
    st = sub.add_parser("selftest", help="grade made-up answers ($0): the answer key must pass, broken answers must fail")
    st.add_argument("suite")
    st.add_argument("-v", "--verbose", action="store_true")
    st.add_argument("--repo", help="repo clone (default: repo.path in the suite, e.g. ${MY_REPO})")
    st.set_defaults(fn=cmd_selftest)
    kc = sub.add_parser("keycheck", help="do the answer keys point at real commits, files and lines? ($0)")
    kc.add_argument("suite")
    kc.add_argument("--repo", help="repo clone (default: repo.path in the suite)")
    kc.set_defaults(fn=cmd_keycheck)
    fz = sub.add_parser("freeze", help="write FROZEN.json before any v1 result")
    fz.add_argument("suite")
    fz.add_argument("--reason", help="required when FROZEN.json exists")
    fz.add_argument("--repo", help="repo clone (default: repo.path in the suite)")
    fz.set_defaults(fn=cmd_freeze)
    r = sub.add_parser("run", help="plan, run and grade a suite")
    r.add_argument("suite")
    r.add_argument("--arms", help="comma list, e.g. none,v1 (default: all arms in the suite)")
    r.add_argument("--cases", help="comma list of case ids (default: all)")
    r.add_argument("-k", type=int, help="trials per case and arm (default: suite k)")
    r.add_argument("-j", "--jobs", type=int, default=4)
    r.add_argument("--max-usd", type=float, help="hard cap on total $ (agent + judge)")
    r.add_argument("--dry-run", action="store_true", help="print the plan and the estimate; no model calls")
    r.add_argument("--calibrate", help="results.json of earlier runs (comma list): use measured $ and time per trial")
    r.add_argument("--model")
    r.add_argument("--judge-model")
    r.add_argument("--no-judge", action="store_true")
    r.add_argument("--out")
    r.add_argument("--keep-workspaces", action="store_true")
    r.add_argument("--seed", type=int, default=0, help="arm order shuffle seed")
    r.add_argument("--repo", help="repo clone (default: repo.path in the suite)")
    r.add_argument("--dev", "--unfrozen", dest="unfrozen", action="store_true",
                   help="dev only: run without FROZEN.json or although it does not match")
    r.add_argument("--stop-after-denials", type=int, default=3, metavar="N",
                   help="stop the run after N trials with permission denials (0 = never; default 3)")
    r.add_argument("--no-canary", action="store_true", help="skip the 1-trial-per-arm canary before the rest")
    r.set_defaults(fn=cmd_run)
    rp = sub.add_parser("report", help="rebuild reports from results.json")
    rp.add_argument("run_dir")
    rp.set_defaults(fn=cmd_report)
    g = sub.add_parser("grade", help="re-grade stored trajectories")
    g.add_argument("run_dir")
    g.add_argument("--no-judge", action="store_true", help="keep stored judge votes")
    g.add_argument("--repo", help="repo clone (default: repo.path in the suite)")
    g.add_argument("--new-grading", action="store_true", help="allow re-grading a run graded with an older grading version")
    g.set_defaults(fn=cmd_grade)
    ex = sub.add_parser("extract", help="report-only per-trial extract for one case (pre-registered; not grading)")
    ex.add_argument("run_dir")
    ex.add_argument("--case", required=True)
    ex.set_defaults(fn=cmd_extract)
    a = p.parse_args(argv)
    try:
        return a.fn(a)
    except SuiteError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
