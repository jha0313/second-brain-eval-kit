"""Plan and run trials: case x arm x k, each in a fresh workspace, then grade."""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from . import checks, judge, report, stats
from .stats import EXCLUDED, SCORED
from .isolation import TrialEnv, ancestor_instructions, auth_mode, claude_cmd, clean_env, redact, trial_settings
from .trajectory import parse_stream

# Rough $ per trial before any calibration. `--calibrate` replaces these with measured means.
DEFAULT_AGENT_USD = {
    "haiku": {"find-all": 0.15, "why": 0.10, "small": 0.03, "other": 0.10},
    "sonnet": {"find-all": 0.80, "why": 0.50, "small": 0.12, "other": 0.50},
    "opus": {"find-all": 1.50, "why": 1.00, "small": 0.25, "other": 1.00},
}
DEFAULT_JUDGE_VOTE_USD = {"haiku": 0.02, "sonnet": 0.04, "opus": 0.07}
PROBE_USD = 0.10                 # isolation probe before the run (haiku, a few calls)
RETRY_SHARE = 0.10               # reserve for infra retries (a trial is retried up to 2 times)
DEFAULT_SECONDS = {"find-all": 240, "why": 150, "small": 45, "other": 120}
DENIED_RE = re.compile(r"^Permission to use \w+ has been denied")   # Claude Code's own permission denial (a harness defect)
INFRA_MARKERS = ("Failed to authenticate", "API Error", "overloaded", "rate limit", "ECONNRESET")


def _family(model: str) -> str:
    return next((f for f in ("haiku", "sonnet", "opus") if f in model), "sonnet")


# ---- plan & estimate ----------------------------------------------------------

def plan(suite, arms: list[str], case_ids: list[str] | None, k: int, seed: int = 0) -> list[dict]:
    """rep -> case -> arms in a shuffled order (seeded), so no arm always runs first or last."""
    cases = [c for c in suite.cases if not case_ids or c.id in case_ids]
    rng = random.Random(seed)
    return [{"case": c, "arm": a, "rep": r, "slot": i}
            for r in range(1, k + 1) for c in cases for i, a in enumerate(rng.sample(arms, len(arms)))]


def estimate(suite, trials: list[dict], jobs: int, calibration: dict | None = None, use_judge: bool = True) -> dict:
    fam, jfam = _family(suite.model), _family(suite.judge_model)
    rows, agent, judge_usd, secs = {}, 0.0, 0.0, 0.0
    for t in trials:
        c = t["case"]
        cal = (calibration or {}).get(f"{c.kind}|{t['arm']}") or (calibration or {}).get(c.kind) or {}
        a = cal.get("usd", DEFAULT_AGENT_USD[fam][c.kind])
        j = suite.votes * DEFAULT_JUDGE_VOTE_USD[jfam] if (c.rubric and use_judge) else 0.0
        s = cal.get("seconds", DEFAULT_SECONDS[c.kind])
        agent, judge_usd, secs = agent + a, judge_usd + j, secs + s
        r = rows.setdefault(t["arm"], {"trials": 0, "agent_usd": 0.0, "judge_usd": 0.0})
        r["trials"] += 1
        r["agent_usd"] += a
        r["judge_usd"] += j
    judge_calls = sum(suite.votes for t in trials if t["case"].rubric) if use_judge else 0
    retry = RETRY_SHARE * agent
    return {"trials": len(trials), "agent_usd": agent, "judge_usd": judge_usd, "judge_calls_max": judge_calls,
            "retry_usd": retry, "probe_usd": PROBE_USD, "total_usd": agent + judge_usd + retry + PROBE_USD,
            "wall_minutes": secs / max(1, jobs) / 60, "by_arm": rows, "calibrated": bool(calibration)}


def load_calibration(results_paths: str) -> dict:
    """Mean measured agent $ and seconds per (kind, arm) and per kind, from one or more results.json (comma list)."""
    acc: dict[str, list] = {}
    trials = [t for p in results_paths.split(",") for t in json.loads(Path(p.strip()).read_text())["trials"]]
    for t in trials:
        if t["outcome"] in SCORED:
            for key in (f"{t['kind']}|{t['arm']}", t["kind"]):
                acc.setdefault(key, []).append((t["metrics"]["agent_usd"], t["metrics"]["seconds"]))
    return {k: {"usd": sum(u for u, _ in v) / len(v), "seconds": sum(s for _, s in v) / len(v), "n": len(v)} for k, v in acc.items()}


# ---- workspaces -----------------------------------------------------------------

def _run(*cmd, cwd=None):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True)


def _checkout(suite, dest: Path) -> Path:
    """repo@commit with the repo's own agent config (suite.strip) left out; no remote back to the source."""
    _run("git", "clone", "--quiet", "--local", "--no-checkout", str(suite.repo), str(dest))
    patterns = ["/*"] + [p for s in suite.strip for p in (f"!/{s}", f"!/{s}/")]
    _run("git", "-C", str(dest), "sparse-checkout", "set", "--no-cone", *patterns)
    _run("git", "-C", str(dest), "reset", "--quiet", "--hard", suite.commit)
    subprocess.run(["git", "-C", str(dest), "remote", "remove", "origin"], capture_output=True)
    ignored = {".claude"} | {o.split("/")[0] for o in suite.prepare_outputs}
    with open(dest / ".git" / "info" / "exclude", "a") as f:
        f.write("".join(f"\n{d}/" for d in sorted(ignored)) + "\n")
    return dest


def build_template(suite, arm: str, root: Path) -> Path:
    """One prepared workspace per arm: the checkout plus the arm's skill in .claude/skills/.
    It lives under the unlistable ws root with a random name, so other arms cannot find it."""
    t = _checkout(suite, root / f"tmpl-{arm}-{secrets.token_hex(6)}")
    skill_dir = suite.arms[arm]
    if skill_dir:
        dest = t / ".claude" / "skills" / suite.skill
        shutil.copytree(skill_dir, dest, ignore=shutil.ignore_patterns(*suite.skill_exclude), symlinks=True)
        if arm in suite.patches:                   # v2 = v1 + the recorded one-line edit, applied exactly (no fuzz)
            r = subprocess.run(["patch", "--forward", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-d", str(dest),
                                "-i", str(suite.patches[arm])], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(f"arm {arm}: {suite.patches[arm].name} does not apply to {skill_dir}; "
                                   f"re-create it from the current SKILL.md\n{r.stdout}{r.stderr}")
        leak_guard(dest, suite)
    return t


def build_index(suite, root: Path, templates: dict[str, Path]) -> dict:
    """`prepare` runs ONCE, on the host, in a checkout with no skill in it. Its outputs are copied read-only into
    every skill arm, so v1 and v2 query the same bytes. The none arm gets nothing."""
    skill_arms = [a for a in templates if suite.arms[a]]
    if not suite.prepare or not skill_arms:
        return {}
    idx = _checkout(suite, root / f"idx-{secrets.token_hex(6)}")
    skill_copy = templates[skill_arms[0]] / ".claude" / "skills" / suite.skill
    env = {**clean_env(), **skill_env(suite, idx), "SKILL_DIR": str(skill_copy), "REPO_DIR": str(idx)}
    start = time.time()
    r = subprocess.run(suite.prepare, shell=True, cwd=idx, env=env, capture_output=True, text=True)
    seconds = time.time() - start
    if r.returncode != 0:
        raise RuntimeError(f"prepare failed ({r.returncode}):\n{r.stdout[-2000:]}{r.stderr[-2000:]}")
    files = {}
    for rel in suite.prepare_outputs:
        src = idx / rel
        digest = hashlib.sha256(src.read_bytes()).hexdigest()
        for a in skill_arms:
            dst = templates[a] / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            os.chmod(dst, 0o444)
            if hashlib.sha256(dst.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"{rel}: copy for arm {a} differs from the built file")
        files[rel] = {"sha256": digest, "bytes": src.stat().st_size, **sqlite_meta(src)}
    return {"checkout": idx, "seconds": round(seconds, 1), "files": files, "arms": skill_arms, "command": suite.prepare}


def sqlite_meta(path: Path) -> dict:
    """If the index is SQLite with a key/value `meta` table, record what it was built from (e.g. vault: null)."""
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = dict(con.execute("SELECT key, value FROM meta").fetchall())
        con.close()
    except sqlite3.Error:
        return {}
    def val(v):
        try:
            return json.loads(v)
        except (TypeError, ValueError):
            return v
    return {"meta": {k: val(rows[k]) for k in ("vault", "commit") if k in rows}, "meta_keys": sorted(rows)}


def skill_env(suite, ws: Path) -> dict:
    """Extra environment for arms that install the skill only, e.g. BRAIN_DB: "{ws}/.codebase-brain/brain.db"."""
    return {k: v.format(ws=ws) for k, v in suite.skill_env.items()}


def leak_guard(skill_copy: Path, suite) -> None:
    """Abort if any case, answer key or rubric file was copied into the trial workspace."""
    skill_dirs = [p for p in suite.arms.values() if p] + [skill_copy.parents[2]]           # + the template being built
    files = [f for d in suite.trusted_dirs if d != suite.dir for f in Path(d).rglob("*")]   # case and key folders
    files += [f for f in suite.dir.rglob("*")                                                 # suite files, not the skill itself
              if "runs" not in f.relative_to(suite.dir).parts and not any(f.is_relative_to(sd) for sd in skill_dirs)]
    secret = {hashlib.sha256(f.read_bytes()).hexdigest() for f in files
              if f.is_file() and f.suffix in (".json", ".yaml", ".yml", ".txt", ".md", ".diff") and f.stat().st_size < 5_000_000}
    for f in skill_copy.rglob("*"):
        if f.is_file() and f.name != "SKILL.md" and f.stat().st_size < 5_000_000:
            if hashlib.sha256(f.read_bytes()).hexdigest() in secret:
                raise RuntimeError(f"answer-key leak: {f} matches a trusted file; refusing to run")


def make_workspace(template: Path, ws_root: Path) -> Path:
    ws = ws_root / secrets.token_hex(8)            # unguessable name; ws_root is not listable (0300)
    r = subprocess.run(["cp", "-cR", str(template), str(ws)], capture_output=True)   # APFS clone: ~1 s
    if r.returncode != 0:
        shutil.copytree(template, ws, symlinks=True)
    return ws


# ---- one trial -------------------------------------------------------------------

class Budget:
    """Spent + reserved (estimates of running trials) must stay under the cap. If only reservations block a new
    trial, wait for running ones to settle; skip only when real spend would cross the cap."""

    def __init__(self, cap: float | None):
        self.cap, self.spent, self.reserved, self.cv = cap, 0.0, 0.0, threading.Condition()

    def reserve(self, est: float) -> bool:
        with self.cv:
            while self.cap is not None and self.spent + self.reserved + est > self.cap:
                if self.reserved <= 1e-9:
                    return False
                self.cv.wait()
            self.reserved += est
            return True

    def settle(self, est: float, actual: float):
        with self.cv:
            self.reserved -= est
            self.spent += actual
            self.cv.notify_all()


def ws_state(ws: Path, commit: str) -> dict:
    """What the agent left behind. Tool calls are not proof of "read only": Bash can write."""
    st = subprocess.run(["git", "-C", str(ws), "status", "--porcelain", "--untracked-files=all"],
                        capture_output=True, text=True).stdout.splitlines()
    head = subprocess.run(["git", "-C", str(ws), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return {"tracked_changes": [ln for ln in st if not ln.startswith("??")],
            "untracked": [ln[3:] for ln in st if ln.startswith("??")], "head": head, "head_ok": head == commit}


def _sum_tokens(per_model: Iterable[dict]) -> dict:
    total: dict = {}
    for d in per_model:
        for m, t in d.items():
            row = total.setdefault(m, {})
            for k, v in t.items():
                row[k] = row.get(k, 0) + v
    return total


def _redact_files(*paths: Path) -> None:
    for p in paths:
        text = p.read_text(errors="replace")
        clean = redact(text)
        if clean != text:
            p.write_text(clean)


def run_trial(suite, spec: dict, out: Path, ws_root: Path, templates: dict, deny: list[Path], use_judge: bool,
              keep_ws: bool) -> dict:
    case, arm, rep = spec["case"], spec["arm"], spec["rep"]
    tid = f"{case.id}__{arm}__{rep}"
    tdir = out / "trials" / tid
    tdir.mkdir(parents=True, exist_ok=True)
    arm_skill = suite.skill if suite.arms[arm] else None
    settings = trial_settings(arm_skill, deny)
    lim = case.limits
    cmd = claude_cmd(case.prompt, model=suite.model, settings=settings, tools=suite.tools,
                     max_turns=lim["max_turns"], max_usd=lim["max_usd"], effort=suite.effort)
    attempts = []                                 # every attempt is paid for: keep each one's cost, time and tokens
    for attempt in range(3):                      # infra errors: retry up to 2 times
        ws = make_workspace(templates[arm], ws_root)
        start, timed_out = time.time(), False
        te = TrialEnv(extra=skill_env(suite, ws) if arm_skill else None)
        with open(tdir / "trajectory.jsonl", "w") as so, open(tdir / "stderr.txt", "w") as se, te as env:
            p = subprocess.Popen(cmd, cwd=ws, env=env, stdin=subprocess.DEVNULL, stdout=so, stderr=se)
            try:
                p.wait(timeout=lim["timeout_s"])
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
                timed_out = True
        seconds = time.time() - start
        state = ws_state(ws, suite.commit)
        if not keep_ws:
            shutil.rmtree(ws, ignore_errors=True)
        _redact_files(tdir / "trajectory.jsonl", tdir / "stderr.txt")
        traj = parse_stream(tdir / "trajectory.jsonl")
        traj["ws_state"] = state
        infra = not timed_out and (not traj["has_result"] or (traj["is_error"] and (
            traj["terminal_reason"] == "api_error" or any(m in traj["error_text"] for m in INFRA_MARKERS))))
        attempts.append({"seconds": round(seconds, 1), "usd": traj["cost_usd"], "usd_known": traj["has_result"],
                         "tokens_total": sum(traj["tokens"].values()), "infra": infra})
        if not infra:
            break
        time.sleep(5 * (attempt + 1))
    rec = {"trial_id": tid, "case": case.id, "kind": case.kind, "family": case.family, "arm": arm, "rep": rep,
           "slot": spec.get("slot"), "attempts": attempt + 1, "model": traj["model"],
           "claude_code_version": traj["claude_code_version"], "visible": traj["visible"],
           "hook_events": traj["hook_events"], "skills_loaded": traj["skills_loaded"], "ws_state": state,
           "models_used": traj["models_used"], "config_files": te.config_keys,
           "truncated_output": checks.truncated_output(traj)}
    rec["isolation_ok"], rec["isolation_detail"] = isolation_ok(traj, arm_skill)
    tokens = traj["tokens"]
    # seconds and tokens describe the attempt that was graded; $ is every attempt (an infra attempt with no result
    # line has an unknown cost: counted in cost_unknown_attempts, not assumed 0)
    rec["metrics"] = {"seconds": round(seconds, 1), "agent_usd": sum(x["usd"] for x in attempts), "judge_usd": 0.0, "tokens": tokens,
                      "tokens_total": sum(tokens.values()), "tool_calls": len(traj["tool_calls"]), "turns": traj["num_turns"],
                      "permission_denials": traj["permission_denials"], "tokens_by_model": traj["tokens_by_model"],
                      "attempts": attempts, "cost_unknown_attempts": sum(not x["usd_known"] for x in attempts),
                      "seconds_all_attempts": round(sum(x["seconds"] for x in attempts), 1),
                      "tokens_total_all_attempts": sum(x["tokens_total"] for x in attempts)}
    rec["permission_denied"] = [f"{c['name']} {json.dumps(c['input'], ensure_ascii=False)[:120]}"
                                for c in traj["tool_calls"] if DENIED_RE.search(c["output"] or "")]
    rec["final_excerpt"] = (traj["final"] or "")[:1500]
    rec["last_calls"] = [f"{c['name']} {json.dumps(c['input'], ensure_ascii=False)[:160]}" for c in traj["tool_calls"][-5:]]
    try:
        _grade(rec, suite, case, traj, arm, deny, use_judge, infra, timed_out)
    except Exception as e:                        # a grader bug must not stop the run or score the agent
        rec.update(hard=rec.get("hard", []), outcome="infra_error", score=None, passed=None,
                   reason=f"grader exception: {type(e).__name__}: {e}"[:200], grader_exception=True)
        rec.setdefault("skill_loaded", None)
    (tdir / "grade.json").write_text(json.dumps(rec, indent=1, ensure_ascii=False))
    return rec


def _grade(rec, suite, case, traj, arm, deny, use_judge, infra, timed_out) -> None:
    hard = checks.run_hard_checks(case, traj, arm, suite.repo, suite.commit, deny)
    rec["hard"] = hard
    sl = [h for h in hard if h["check"] == "skill_loaded"]
    rec["skill_loaded"] = (bool(traj["skills_loaded"]) if arm == "none" else
                           (sl[0]["loaded"] if sl else (suite.skill in traj["skills_loaded"])))
    key_access = next((h for h in hard if h["category"] == "integrity" and h["ok"] is False), None)
    if infra:
        rec.update(outcome="infra_error", score=None, passed=None, reason=f"infra error after 3 attempts: {traj['error_text'][:160]}")
    elif not rec["isolation_ok"]:
        rec.update(outcome="isolation_error", score=None, passed=None, reason=rec["isolation_detail"])
    elif key_access:
        rec.update(outcome="invalid", score=None, passed=None, reason=f"touched answer keys: {key_access['detail']}")
    elif timed_out or (traj["result_subtype"] or "").startswith("error_"):
        why = "timeout" if timed_out else traj["result_subtype"]
        rec.update(outcome="limit", score=0.0, passed=False, reason=f"agent hit a trial limit: {why}")
    else:
        failed_gate = any(h["gate"] and h["ok"] is False for h in hard)
        votes = (judge.judge(case, traj, suite.judge_model, suite.votes, suite.repo, suite.commit)
                 if (use_judge and case.rubric and not failed_gate) else None)
        if votes:
            rec["votes"] = votes
            rec["judge_models"] = sorted({m for v in votes for m in v.get("models", [])})
            rec["metrics"]["judge_usd"] = sum(v["cost_usd"] for v in votes)
            rec["metrics"]["judge_tokens_by_model"] = _sum_tokens(v.get("tokens_by_model") or {} for v in votes)
            rec["grader_error"] = any(v.get("grader_error") for v in votes)
        s = checks.score_trial(hard, votes, case.pass_threshold)
        rec.update(outcome=s["outcome"], score=s["score"], passed=s["passed"], reason=s["reason"], rubric=s.get("rubric"))
        if case.rubric and not use_judge and not failed_gate:
            rec["reason"] += " (judge skipped: --no-judge)"


def isolation_ok(traj: dict, arm_skill: str | None) -> tuple[bool, str]:
    v = traj["visible"]
    problems = []
    extra = [s for s in (v["skills"] or []) if s != arm_skill]
    if extra:
        problems.append(f"unexpected skills visible: {extra[:5]}")
    if v["mcp_servers"]:
        problems.append(f"MCP servers visible: {v['mcp_servers'][:5]}")
    if v["memory_paths"]:
        problems.append("auto-memory enabled")
    if traj["hook_events"]:
        problems.append(f"{traj['hook_events']} hook events")
    if any(s != arm_skill for s in traj["skills_loaded"]):
        problems.append(f"loaded a skill outside the arm: {traj['skills_loaded']}")
    return (not problems, "; ".join(problems) or "ok")


# ---- whole run -------------------------------------------------------------------

def short(p) -> str:
    """Paths as shown on screen: relative to the current folder if inside it, else ~ for home, $TMPDIR for temp."""
    s = str(p)
    if os.path.isabs(s):                          # a path; other text (JSON, messages) only gets the replacements below
        try:
            rel = Path(s).resolve().relative_to(Path.cwd().resolve())
            return str(rel) if str(rel) != "." else "."
        except ValueError:
            pass
    for root, name in ((os.path.realpath(tempfile.gettempdir()), "$TMPDIR"), (tempfile.gettempdir(), "$TMPDIR"),
                       (str(Path.home()), "~")):
        s = s.replace(root.rstrip("/"), name)
    return s


def _git_root(p: Path) -> Path | None:
    r = subprocess.run(["git", "-C", str(p), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return Path(r.stdout.strip()) if r.returncode == 0 else None


def host_deny() -> list[Path]:
    """This machine's extra paths from SKILL_EVAL_DENY (os.pathsep-separated), e.g. other copies of the answer keys or
    a clone with newer history. Kept out of suite.yaml and out of every saved record (only the count is recorded)."""
    return [Path(os.path.expanduser(p)) for p in os.environ.get("SKILL_EVAL_DENY", "").split(os.pathsep) if p.strip()]


def deny_list(suite, out: Path) -> list[Path]:
    """Host paths a trial must not read (Read/Edit deny) and must not name in any tool call (no_answer_key_access):
    cases, keys, rubrics, the suite and its repo, skill sources (they hold eval cases), run records, extras."""
    paths = [*suite.trusted_dirs, out / "trials", *suite.deny_read, *host_deny()]
    paths += [p for p in suite.arms.values() if p]
    paths += [r for r in {_git_root(suite.dir), *(_git_root(p) for p in suite.arms.values() if p)} if r]
    return sorted({p.resolve() for p in paths})


COLOR = {"pass": "32", "fail": "31", "limit": "31", "safety_violation": "35"}


def progress_line(n: int, total: int, rec: dict, elapsed: float, tty: bool) -> str:
    out = rec["outcome"].upper() if rec["outcome"] in ("pass", "fail") else rec["outcome"]
    if tty:
        out = f"\033[{COLOR.get(rec['outcome'], '33')}m{out}\033[0m"
    m = rec["metrics"]
    sm = next((h for h in rec["hard"] if h["check"] in ("set_match", "sources_hit")), None)
    extra = (f"recall {sm['recall']:.2f} · " if sm and sm.get("recall") is not None else "") + f"{m['seconds']:.0f}s · ${m['agent_usd'] + m['judge_usd']:.2f}"
    return (f"[{n:>{len(str(total))}}/{total}] {rec['case']} · {rec['arm']} · #{rec['rep']} · {out} · "
            f"{int(elapsed // 60):02d}:{int(elapsed % 60):02d}   ({extra})")


def run(suite, specs: list[dict], out: Path, jobs: int, max_usd: float | None, est: dict,
        use_judge: bool = True, keep_ws: bool = False, log=print, seed: int = 0, manifest: dict | None = None) -> dict:
    if auth_mode() != "token" and os.environ.get("SKILL_EVAL_ALLOW_KEYCHAIN") != "1":
        raise RuntimeError("no token file: trials would use your own Claude Code config. Run `claude setup-token` "
                           "and save the token (see SKILL.md), or set SKILL_EVAL_ALLOW_KEYCHAIN=1 for a dev run.")
    out.mkdir(parents=True, exist_ok=True)
    (out / "trials").mkdir(exist_ok=True)
    ws_root = Path(tempfile.mkdtemp(prefix="skill-eval-ws-"))        # outside the suite, the kit and the run records
    found = ancestor_instructions(ws_root / "x")
    if found:
        raise RuntimeError(f"instruction files above the workspace would be read by every trial: {found}")
    deny = deny_list(suite, out)
    extra = {p.resolve() for p in host_deny()}
    if any(ws_root.is_relative_to(d) for d in deny):
        raise RuntimeError(f"workspace root {ws_root} is inside a denied folder")
    arms = sorted({s["arm"] for s in specs}, key=list(suite.arms).index)
    log(f"preparing {len(arms)} arm workspace(s): {suite.label} @{suite.commit[:8]}, without {', '.join(suite.strip)} ...")
    templates = {a: build_template(suite, a, ws_root) for a in arms}
    index = build_index(suite, ws_root, templates)
    if index:
        log(f"index: built once in {index['seconds']:.0f}s, " + ", ".join(
            f"{v['bytes'] / 1e6:.0f} MB, sha256 {v['sha256'][:12]}" + (f", vault {v['meta'].get('vault') or 'none'}" if "vault" in v.get("meta", {}) else "")
            for v in index["files"].values()) + f", read-only in {', '.join(index['arms'])}")
    os.chmod(ws_root, 0o300)                      # same user can enter its own workspace but cannot list siblings
    skill_hashes = {a: hashlib.sha256((t / ".claude" / "skills" / suite.skill / "SKILL.md").read_bytes()).hexdigest()[:12]
                    for a, t in templates.items() if suite.arms[a]}
    budget = Budget(max_usd)
    per_trial_est = est["total_usd"] / max(1, est["trials"])
    started, t0 = datetime.now(timezone.utc).isoformat(timespec="seconds"), time.time()
    done, results, lock = [0], [], threading.Lock()
    tty = sys.stdout.isatty() or bool(os.environ.get("FORCE_COLOR"))

    def work(spec):
        c = spec["case"]
        if not budget.reserve(per_trial_est):
            rec = {"trial_id": f"{c.id}__{spec['arm']}__{spec['rep']}", "case": c.id, "kind": c.kind, "family": c.family,
                   "arm": spec["arm"], "rep": spec["rep"], "slot": spec.get("slot"), "outcome": "skipped_budget",
                   "score": None, "passed": None, "hard": [], "reason": f"--max-usd {max_usd} reached", "skill_loaded": None,
                   "metrics": {"seconds": 0, "agent_usd": 0, "judge_usd": 0, "tokens": {}, "tokens_total": 0, "tool_calls": 0, "turns": 0}}
        else:
            rec = run_trial(suite, spec, out, ws_root, templates, deny, use_judge, keep_ws)
            budget.settle(per_trial_est, rec["metrics"]["agent_usd"] + rec["metrics"]["judge_usd"])
        with lock:
            done[0] += 1
            results.append(rec)
            log(progress_line(done[0], len(specs), rec, time.time() - t0, tty))
            if rec["outcome"] in ("isolation_error", "invalid", "safety_violation") or rec.get("grader_exception") \
                    or rec.get("grader_error"):
                log(f"  !! {rec['outcome']}: {rec['reason']}"[:100])
            if rec.get("permission_denied"):
                log(f"  !! permission denied ({len(rec['permission_denied'])}): {rec['permission_denied'][0]}"[:100])
        return rec

    try:
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            list(ex.map(work, specs))
    finally:
        os.chmod(ws_root, 0o700)
        if not keep_ws:
            shutil.rmtree(ws_root, ignore_errors=True)
    results.sort(key=lambda r: (r["case"], list(suite.arms).index(r["arm"]), r["rep"]))
    case_ids = list(dict.fromkeys(s["case"].id for s in specs))
    agg = stats.aggregate(results, arms, case_ids, suite.compare, suite.sensitivity)
    meta = {
        "suite": suite.name, "suite_file": short(suite.path), "skill": suite.skill,
        "arms": {a: (short(p) if p else None) for a, p in suite.arms.items() if a in arms},
        "skill_sha256": skill_hashes,
        "patches": {a: short(p) for a, p in suite.patches.items() if a in arms},
        "repo": suite.label, "commit": suite.commit, "strip": suite.strip,
        "repo_instructions": repo_instructions(suite),
        "model": suite.model, "effort": suite.effort, "tools": suite.tools,
        "models_seen": sorted({r["model"] for r in results if r.get("model")}),           # the agent model (init event)
        "models_used_seen": sorted({m for r in results for m in r.get("models_used") or []}),   # incl. Claude Code helpers
        "judge_models_seen": sorted({m for r in results for m in r.get("judge_models", [])}),
        "config_files_seen": {f: sorted({k for r in results for k in (r.get("config_files") or {}).get(f, [])})
                              for f in sorted({f for r in results for f in (r.get("config_files") or {})})},
        "truncated_output": sum(bool(r.get("truncated_output")) for r in results),
        "claude_code_versions_seen": sorted({r["claude_code_version"] for r in results if r.get("claude_code_version")}),
        "compare": suite.compare, "judge_model": suite.judge_model, "judge_version": judge.JUDGE_VERSION, "votes": suite.votes,
        "auth_mode": auth_mode(), "seed": seed, "manifest": manifest,
        "index": {k: v for k, v in index.items() if k != "checkout"},
        "families": {c.id: c.family for c in suite.cases if c.id in case_ids},
        "k": max(s["rep"] for s in specs), "jobs": jobs, "max_usd": max_usd, "started": started,
        "finished": datetime.now(timezone.utc).isoformat(timespec="seconds"), "wall_seconds": round(time.time() - t0),
        "estimate": est, "limits": suite.limits, "notes": suite.notes,
        "find_all_pass": suite.find_all_pass, "sensitivity": suite.sensitivity,
        "permission_denied_trials": sorted(r["trial_id"] for r in results if r.get("permission_denied")),
        "grader_exceptions": sorted(r["trial_id"] for r in results if r.get("grader_exception")), "limitations": report.LIMITS + suite.notes,
        "cases": {c.id: {"kind": c.kind, "prompt": c.prompt, "family": c.family} for c in suite.cases if c.id in case_ids},
        "counts": {"expected": len(specs), "attempted": sum(r["outcome"] != "skipped_budget" for r in results),
                   "scored": sum(r["outcome"] in SCORED for r in results),
                   "excluded": {o: sum(r["outcome"] == o for r in results) for o in EXCLUDED}},
        "spent_usd": round(budget.spent, 4),
        "isolation": {"all_ok": all(r.get("isolation_ok", True) for r in results),
                      "skills_visible_in_none": sorted({s for r in results if r["arm"] == "none" for s in (r.get("visible", {}).get("skills") or [])}),
                      "hook_events_total": sum(r.get("hook_events", 0) for r in results),
                      "denied_paths": [short(d) for d in deny if d not in extra] + ([f"+{len(extra)} host path(s) from SKILL_EVAL_DENY"] if extra else [])},
    }
    data = {"meta": meta, "aggregate": agg, "trials": results}
    (out / "results.json").write_text(json.dumps(data, indent=1, ensure_ascii=False, default=str))
    return data


def repo_instructions(suite) -> dict:
    """Instruction files the repo itself tracks. They stay in every arm (same text), so they are not a difference."""
    files = subprocess.run(["git", "-C", str(suite.repo), "ls-tree", "-r", "--name-only", suite.commit],
                           capture_output=True, text=True).stdout.split()
    names = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md")
    kept = [f for f in files if f.split("/")[-1] in names and not any(f.startswith(s + "/") for s in suite.strip)]
    return {"kept_in_all_arms": len(kept), "root": [f for f in kept if "/" not in f], "stripped": suite.strip}
