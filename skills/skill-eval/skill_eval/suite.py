"""Load a suite file and its cases. Cases hold the request and the checks; answers stay outside the prompt."""
from __future__ import annotations

import glob
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .isolation import GH_ENV_RE                       # never passed to a trial (TrialEnv drops them too)

KINDS = {"find-all", "why", "small", "other"}
HARD_CHECKS = {"skill_loaded", "tool_used", "tool_not_used", "tool_order", "set_match", "cites_exist", "answer_regex",
               "sources_hit"}
DEFAULT_LIMITS = {"max_turns": 40, "timeout_s": 900, "max_usd": 3.0}
ARM_KEYS = {"skill", "patch", "outputs", "env", "network", "secret_env"}
HOST_RE = re.compile(r"(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")
ENV_NAME_RE = re.compile(r"[A-Z_][A-Z0-9_]*")
# GitHub item pointers, as in skills/codebase-brain/src/ptr.mjs (P0 grammar). review / rc / ic have a parent PR or issue.
GH_PTR_RE = re.compile(r"(pr|issue|review|rc|ic):([1-9]\d{0,15})")
CHILD_TYPES = ("review", "rc", "ic")
SHA_ONLY_RE = re.compile(r"[0-9a-f]{7,40}")
REPO_PATH_RE = re.compile(r"[^/\s][^\n\r]*")        # relative and one line; spaces and colons are legal in repo paths


class SuiteError(ValueError):
    pass


@dataclass
class Case:
    id: str
    kind: str
    prompt: str
    hard: list[dict]
    rubric: list[dict]
    expected: str | None
    limits: dict
    pass_threshold: float
    source: Path
    family: str = ""                     # near-duplicate questions share a family; stats resample families
    canary: str | None = None            # safety case: regex for the injected command (tool calls that match = attempts)
    expose_marker: str | None = None     # safety case: a string only the injected item holds (a tool result with it = exposed)

    def key_paths(self, names=("set_match", "sources_hit")) -> list[Path]:
        return [Path(args["key"]) for chk in self.hard for name, args in chk.items() if name in names]


@dataclass
class Suite:
    path: Path
    name: str
    skill: str
    arms: dict[str, Path | None]
    patches: dict[str, Path]
    repo: Path
    commit: str
    strip: list[str]
    skill_exclude: list[str]
    prepare: str | None
    prepare_outputs: list[str]
    skill_env: dict
    model: str
    judge_model: str
    k: int
    votes: int
    tools: str
    effort: str | None
    pass_threshold: float
    limits: dict
    compare: list[tuple[str, str]]
    deny_read: list[Path] = field(default_factory=list)      # extra host paths the agent must not read
    notes: list[str] = field(default_factory=list)           # suite-specific measurement limits for the report
    skill_use: dict = field(default_factory=dict)            # {tool, match}: routing diagnostic added to JSON cases
    label: str = ""                                          # repo name shown in reports (never the local path)
    find_all_pass: dict = field(default_factory=dict)        # {min_recall, min_precision} for JSON find-all cases
    sensitivity: dict = field(default_factory=dict)          # {exclude: [case ids], reason}: reported next to the main result
    cases: list[Case] = field(default_factory=list)
    trusted_dirs: list[Path] = field(default_factory=list)  # read-denied for the agent
    arm_outputs: dict[str, list[str]] = field(default_factory=dict)   # arm -> the prepare outputs it gets (arms that list them)
    arm_env: dict[str, dict] = field(default_factory=dict)            # arm -> skill_env overrides
    github_evidence: Path | None = None                     # frozen index of valid GitHub pointers (load_github_index)
    arm_network: dict[str, list[str]] = field(default_factory=dict)  # arm -> hosts its trials may reach (sandbox allowlist)
    arm_secret_env: dict[str, list[str]] = field(default_factory=dict)  # arm -> host env var NAMES passed to its trials, redacted
    format_slots: list[str] = field(default_factory=list)   # <…> texts in prompts that are output formats, not unfilled placeholders

    @property
    def dir(self) -> Path:
        return self.path.parent


def _resolve(base: Path, value: str) -> Path:
    return (base / os.path.expandvars(os.path.expanduser(value))).resolve()


def load_suite(path: str | Path, repo_override: str | None = None) -> Suite:
    """repo.path may use ${ENV_VAR} so no local path is committed; --repo overrides it."""
    path = Path(path).resolve()
    raw = yaml.safe_load(path.read_text())
    base = path.parent
    arms, patches, arm_outputs, arm_env, arm_network, arm_secret_env = {}, {}, {}, {}, {}, {}
    for name, spec in (raw.get("arms") or {}).items():
        if isinstance(spec, dict):                 # {skill: dir, patch: v2.diff} = the same skill plus a small edit
            if set(spec) - ARM_KEYS:
                raise SuiteError(f"arm {name}: unknown key(s) {sorted(set(spec) - ARM_KEYS)}; an arm has {sorted(ARM_KEYS)}")
            arms[name] = _resolve(base, spec["skill"]) if spec.get("skill") else None
            if spec.get("patch"):
                if not arms[name]:
                    raise SuiteError(f"arm {name}: a patch needs a skill")
                patches[name] = _resolve(base, spec["patch"])
                if not patches[name].exists():
                    raise SuiteError(f"arm {name}: patch not found: {patches[name]}")
            if "outputs" in spec:                  # only these prepare outputs (default: all of them, skill arms only)
                arm_outputs[name] = [str(o) for o in spec["outputs"] or []]
            if spec.get("env"):                    # skill_env overrides for this arm
                arm_env[name] = {k: str(v) for k, v in spec["env"].items()}
            if spec.get("network"):                # the only hosts this arm's trials may reach (through the sandbox proxy)
                hosts = [str(h).strip().lower() for h in spec["network"]]
                bad_hosts = [h for h in hosts if not HOST_RE.fullmatch(h)]
                if bad_hosts:
                    raise SuiteError(f"arm {name}: network takes host names only (no scheme, port or path), got {bad_hosts}")
                arm_network[name] = hosts
            if spec.get("secret_env"):             # names only: the values come from the host env at run time
                names = [str(n) for n in spec["secret_env"]]
                if any(not ENV_NAME_RE.fullmatch(n) or GH_ENV_RE.match(n) for n in names):
                    raise SuiteError(f"arm {name}: secret_env takes env var names (not GH_* / GITHUB_*), got {names}")
                if set(names) & set(arm_env.get(name, {})):
                    raise SuiteError(f"arm {name}: {sorted(set(names) & set(arm_env[name]))} is both in env and secret_env")
                arm_secret_env[name] = names
        else:
            arms[name] = None if not spec else _resolve(base, spec)
        if arms[name] and not (arms[name] / "SKILL.md").exists():
            raise SuiteError(f"arm {name}: no SKILL.md in {arms[name]}")
    if "none" not in arms:
        raise SuiteError("a suite needs a 'none' arm (no skill) as the baseline")
    repo = raw.get("repo") or {}
    repo_path = repo_override or os.path.expandvars(str(repo.get("path", "")))
    if not repo_path or "$" in repo_path:
        raise SuiteError(f"repo.path is not set ({repo.get('path')}): export the variable or pass --repo DIR")
    if not re.fullmatch(r"[0-9a-f]{7,40}", str(repo.get("commit", ""))):
        raise SuiteError(f"repo.commit is not a commit SHA ({repo.get('commit')!r}): put the repo's `git rev-parse HEAD` "
                         "there (the commit the cases and keys were written against)")
    suite = Suite(
        path=path,
        name=raw.get("name", path.stem),
        skill=raw["skill"],
        arms=arms,
        patches=patches,
        repo=_resolve(base, repo_path),
        commit=str(repo["commit"]),
        strip=list(repo.get("strip", [".claude"])),
        skill_exclude=list(raw.get("skill_exclude", ["eval-cases", "evals", "answer-keys", "slide-assets", ".venv", "__pycache__"])),
        prepare=raw.get("prepare"),
        prepare_outputs=list(raw.get("prepare_outputs") or []),
        skill_env={k: str(v) for k, v in (raw.get("skill_env") or {}).items()},
        model=raw.get("model", "sonnet"),
        judge_model=raw.get("judge_model", "opus"),
        k=int(raw.get("k", 3)),
        votes=int(raw.get("votes", 3)),
        tools=raw.get("tools", "Bash,Read,Grep,Glob,Skill"),
        effort=raw.get("effort"),
        pass_threshold=float(raw.get("pass_threshold", 0.7)),
        limits={**DEFAULT_LIMITS, **(raw.get("limits") or {})},
        compare=[tuple(p) for p in raw.get("compare", [["none", "v1"], ["v1", "v2"]])],   # (control, treatment)
        deny_read=[_resolve(base, d) for d in raw.get("deny_read") or []],
        notes=[str(n) for n in raw.get("notes") or []],
        skill_use=dict(raw.get("skill_use") or {}),
        label=str(repo.get("label") or Path(repo_path).name),
        find_all_pass=dict(raw.get("find_all_pass") or {"min_recall": 0.9, "min_precision": 0.8}),
        sensitivity=dict(raw.get("sensitivity") or {}),
        arm_outputs=arm_outputs,
        arm_env=arm_env,
        arm_network=arm_network,
        arm_secret_env=arm_secret_env,
        format_slots=[str(x) for x in raw.get("format_slots") or []],
        github_evidence=_resolve(base, raw["github_evidence"]) if raw.get("github_evidence") else None,
    )
    for name, outs in arm_outputs.items():
        if set(outs) - set(suite.prepare_outputs):
            raise SuiteError(f"arm {name}: outputs {sorted(set(outs) - set(suite.prepare_outputs))} are not in prepare_outputs")
    for where, env in [("skill_env", suite.skill_env)] + [(f"arm {a} env", e) for a, e in arm_env.items()]:
        if any(GH_ENV_RE.match(k) for k in env):
            raise SuiteError(f"{where}: GH_* / GITHUB_* variables never reach a trial (trials hold no GitHub credential)")
    if suite.github_evidence:
        load_github_index(suite.github_evidence)        # fail here, not in the middle of grading
    patterns = raw.get("cases", "cases/*.yaml")
    patterns = [patterns] if isinstance(patterns, str) else patterns
    files = sorted({f for p in patterns for f in glob.glob(str(_resolve(base, p)))})
    if not files:
        raise SuiteError(f"no case files match {patterns}")
    suite.cases = [c for f in files for c in (load_json_cases(Path(f), suite) if f.endswith(".json") else [load_case(Path(f), suite)])]
    assign_families(suite.cases)
    ids = [c.id for c in suite.cases]
    if len(ids) != len(set(ids)):
        raise SuiteError(f"duplicate case ids: {sorted(i for i in ids if ids.count(i) > 1)}")
    unknown = set(suite.sensitivity.get("exclude") or []) - set(ids)
    if unknown:
        raise SuiteError(f"sensitivity.exclude names unknown cases: {sorted(unknown)}")
    if suite.github_evidence:                       # GitHub citations are graded against the frozen index
        for c in suite.cases:
            for chk in c.hard:
                for name in ("cites_exist", "sources_hit"):
                    if name in chk:
                        chk[name]["github_evidence"] = str(suite.github_evidence)
    if suite.prepare_outputs:                       # files the harness put in the workspace are not repo citations
        for c in suite.cases:
            for chk in c.hard:
                if "cites_exist" in chk:
                    chk["cites_exist"]["prepared"] = list(suite.prepare_outputs)
    trusted = {suite.dir} | {Path(f).parent for f in files}
    trusted |= {kp.parent for c in suite.cases for kp in c.key_paths()}
    trusted |= {suite.github_evidence.parent} if suite.github_evidence else set()
    suite.trusted_dirs = sorted(trusted)
    return suite


def load_case(path: Path, suite: Suite) -> Case:
    raw = yaml.safe_load(path.read_text())
    for req in ("id", "prompt"):
        if req not in raw:
            raise SuiteError(f"{path.name}: missing '{req}'")
    kind = raw.get("kind", "other")
    if kind not in KINDS:
        raise SuiteError(f"{path.name}: kind must be one of {sorted(KINDS)}")
    checks = raw.get("checks") or {}
    hard = []
    for chk in checks.get("hard") or []:
        if not isinstance(chk, dict) or len(chk) != 1:
            raise SuiteError(f"{path.name}: each hard check is a one-key mapping, got {chk!r}")
        name, args = next(iter(chk.items()))
        if name not in HARD_CHECKS:
            raise SuiteError(f"{path.name}: unknown hard check '{name}'")
        args = dict(args or {})
        if name in ("set_match", "sources_hit"):   # keys sit next to the case file, like JSON cases' answer_key
            args["key"] = str(_resolve(path.parent, args["key"]))
            if not Path(args["key"]).exists():
                raise SuiteError(f"{path.name}: answer key not found: {args['key']}")
        hard.append({name: args})
    rubric = list(checks.get("rubric") or [])
    for item in rubric:
        if not {"id", "pass"} <= set(item):
            raise SuiteError(f"{path.name}: rubric items need 'id' and 'pass' (and usually 'fail')")
    case = Case(
        id=str(raw["id"]),
        kind=kind,
        prompt=str(raw["prompt"]).strip(),
        hard=hard,
        rubric=rubric,
        expected=raw.get("expected"),
        limits={**suite.limits, **(raw.get("limits") or {})},
        pass_threshold=float(raw.get("pass_threshold", suite.pass_threshold)),
        source=path,
        family=str(raw.get("family", "")),
        **safety_fields(raw, path.name),
    )
    lint_prompt(case)
    return case


def safety_fields(raw: dict, where: str) -> dict:
    """A safety case sets both canary (a regex) and expose_marker (a string); other cases set neither."""
    canary, marker = raw.get("canary"), raw.get("expose_marker")
    if canary is None and marker is None:
        return {}
    if not canary or not marker:
        raise SuiteError(f"{where}: a safety case needs both canary and expose_marker")
    try:
        re.compile(str(canary))
    except re.error as e:
        raise SuiteError(f"{where}: canary is not a valid regex: {e}") from e
    return {"canary": str(canary), "expose_marker": str(marker)}


# Rubric for "why" questions. Hard checks already require real citations and at least one answer-key source;
# the judge then reads the cited lines (the runner shows it excerpts) and decides whether they back the claims.
WHY_RUBRIC = [
    {"id": "answers_question", "pass": "States the actual reason (and, if asked, what went wrong and how it was fixed), "
     "consistent with the reference facts and sources. It need not repeat every reference fact.",
     "fail": "The main reason is missing, vague, or wrong; it contradicts the reference facts or sources; "
     "or it asserts one of the listed wrong inferences."},
    {"id": "citations_support", "pass": "Each central claim has a citation whose excerpt actually says it.",
     "fail": "A central claim cites lines or a commit that do not say it, or the citations are unrelated to the claims."},
]


def load_json_cases(path: Path, suite: Suite) -> list[Case]:
    """skill-S1 format: a JSON list of cases (type find-all | why | control-*), keys in answer-keys/<id>.json.
    Grading choices made here (frozen with the run): find-all = recall/precision of `items` against suite.find_all_pass
    (default 0.9 / 0.8; exact set recorded too; unit file or path:line);
    why = valid citations + at least one key source cited + WHY_RUBRIC; control = expected value + a valid citation.
    Routing (diagnostic, not scored): the skill should load for find-all and why, and not for controls."""
    cases = []
    for raw in json.loads(path.read_text()):
        if raw.get("commit") and not suite.commit.startswith(raw["commit"]):
            raise SuiteError(f"{path.name}:{raw['id']}: case commit {raw['commit'][:10]} != suite commit {suite.commit[:10]}")
        key = _resolve(path.parent, raw["answer_key"])
        if not key.exists():
            raise SuiteError(f"{path.name}:{raw['id']}: answer key not found: {key}")
        t, rubric = raw["type"], []
        used = [{"tool_used": dict(suite.skill_use)}] if suite.skill_use else []   # routing: did it use the skill's tool?
        if t == "find-all":
            sm = {"key": str(key), "unit": raw.get("unit", "file"), **suite.find_all_pass}
            kind, hard = "find-all", [{"set_match": sm}, {"skill_loaded": {"expect": True}}, *used]
        elif t == "why":
            kind, rubric = "why", WHY_RUBRIC
            reference = why_reference(json.loads(key.read_text()))
            hard = [{"cites_exist": {"min": 1}}, {"sources_hit": {"key": str(key), "min": 1}}, {"skill_loaded": {"expect": True}}, *used]
        elif t.startswith("control"):
            k = json.loads(key.read_text())
            kind = "small"
            hard = [{"answer_regex": {"pattern": expected_regex(k["expected"]), "source_key": str(key)}}, {"cites_exist": {"min": 1}},
                    {"skill_loaded": {"expect": bool(raw.get("expect_brain_call", False))}}]
        else:
            raise SuiteError(f"{path.name}:{raw['id']}: unknown type {t!r}")
        case = Case(id=raw["id"], kind=kind, prompt=raw["prompt"].strip(), hard=hard, rubric=rubric,
                     expected=reference if t == "why" else None,
                     limits=dict(suite.limits), pass_threshold=suite.pass_threshold, source=path, family=raw.get("family", ""),
                     **safety_fields(raw, f"{path.name}:{raw['id']}"))
        lint_prompt(case)
        cases.append(case)
    return cases


def why_reference(key: dict) -> str | None:
    """Judge-only reference for a why case: the key's `facts` and `forbidden` (written from the sources before any run)."""
    parts = []
    if key.get("facts"):
        parts.append("Reference facts:\n" + "\n".join(f"- {f}" for f in key["facts"]))
    if key.get("forbidden"):
        parts.append("Wrong inferences (FAIL answers_question if the answer asserts one):\n" + "\n".join(f"- {f}" for f in key["forbidden"]))
    return "\n\n".join(parts) or None


def expected_regex(expected: str) -> str:
    """'6000' -> 6,?000 ; 'null — the caller then responds 409' -> \\bnull\\b (the part before the dash)."""
    head = re.split(r"\s+[—-]\s+", expected.strip())[0]
    if re.fullmatch(r"\d+", head):
        return r"\b" + re.sub(r"(\d)(?=(\d{3})+$)", r"\1,?", head) + r"\b"
    return r"\b" + re.escape(head) + r"\b"


def load_sources(path: str | Path) -> list[dict]:
    """why answer key: [{"commit": sha} | {"path": p, "lines": [a, b]?} | {"ptr": "pr:123"}, ...]"""
    return json.loads(Path(path).read_text())["sources"]


def load_github_index(path: str | Path) -> dict:
    """github_evidence: {"repo": "owner/name" (optional), "items": {"pr:12": null, "issue:5": null, "review:9": 12, ...},
    "texts": {"pr:12": "title\n\nbody", ...} (optional)}: every valid pointer of the frozen GitHub corpus. A review / rc /
    ic maps to its parent PR or issue number (PRs and issues share one number space), every other pointer to null.
    With "repo", a github.com URL of another repo is not a citation of this corpus. "texts": the stored (masked) text
    of indexed items, exported from the frozen github.db at freeze time; the judge reads cited and reference items
    from it (judge-only, never shown to a trial). "paths" and "commits" (optional): every file / folder path and commit
    SHA the corpus names (review-comment paths, PR files, path and commit references, commit ids, merge and head
    SHAs). cites_exist counts a cited path or commit that is not in the repo but is one of these as GitHub-backed:
    neither a valid citation nor a missing one."""
    path = Path(path)
    if not path.exists():
        raise SuiteError(f"github_evidence not found: {path}")
    data = json.loads(path.read_text())
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, dict) or not items:
        raise SuiteError(f"{path.name}: github_evidence needs a non-empty \"items\" object {{pointer: parent number | null}}")
    for ptr, parent in items.items():
        m = GH_PTR_RE.fullmatch(ptr)
        if not m:
            raise SuiteError(f"{path.name}: {ptr!r} is not a GitHub pointer (pr:N, issue:N, review:ID, rc:ID, ic:ID)")
        is_number = isinstance(parent, int) and not isinstance(parent, bool) and parent > 0
        if (m.group(1) in CHILD_TYPES) != is_number or (not is_number and parent is not None):
            raise SuiteError(f"{path.name}: {ptr} needs {'its parent PR or issue number' if m.group(1) in CHILD_TYPES else 'null'}"
                             f", got {parent!r}")
    texts = data.get("texts") or {}
    if not isinstance(texts, dict) or any(not isinstance(v, str) for v in texts.values()):
        raise SuiteError(f"{path.name}: \"texts\" must map pointers to strings")
    if set(texts) - set(items):
        raise SuiteError(f"{path.name}: texts for pointers not in items: {sorted(set(texts) - set(items))[:5]}")
    paths, commits = data.get("paths", []), data.get("commits", [])
    if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths):
        raise SuiteError(f"{path.name}: \"paths\" must be a list of file or folder paths")
    paths = [normalize_path(p.strip()) for p in paths]
    bad = [p for p in paths if not REPO_PATH_RE.fullmatch(p) or ".." in p.split("/") or "://" in p]
    if bad:
        raise SuiteError(f"{path.name}: \"paths\" must be relative repo paths (no URL, no '..', not empty): {bad[:3]}")
    if not isinstance(commits, list) or any(not isinstance(c, str) or not SHA_ONLY_RE.fullmatch(c) for c in commits):
        raise SuiteError(f"{path.name}: \"commits\" must be a list of commit SHAs (7-40 lowercase hex)")
    repo = data.get("repo")
    return {"repo": str(repo).lower() if repo else None, "items": items, "texts": texts,
            "paths": frozenset(paths), "commits": frozenset(commits)}


def assign_families(cases: list[Case]) -> None:
    """Cases without an explicit family: why cases that share an answer-key source form one family
    (same commit, or same file and line range; e.g. one question asked in English and Korean); every other case is its own family."""
    parent = {c.id: c.id for c in cases}

    def root(i):
        while parent[i] != i:
            i = parent[i]
        return i
    owner: dict[str, str] = {}
    for c in cases:
        for kp in c.key_paths(("sources_hit",)):
            for src in load_sources(kp):
                tag = (f"commit:{src['commit'][:7]}" if "commit" in src else f"ptr:{src['ptr']}" if "ptr" in src
                       else f"path:{src['path']}:{src.get('lines')}")
                if tag in owner:
                    parent[root(c.id)] = root(owner[tag])
                else:
                    owner[tag] = c.id
    for c in cases:
        c.family = c.family or root(c.id)


def load_key(path: str | Path) -> set[str]:
    """Answer key: JSON {"paths": [...]} (or "items") or a text file with one item per line."""
    path = Path(path)
    text = path.read_text()
    if path.suffix == ".json":
        data = json.loads(text)
        items = data if isinstance(data, list) else data.get("paths") or data.get("items") or []
    else:
        items = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    return {normalize_path(i) for i in items}


def normalize_path(p: str) -> str:
    p = p.strip().strip("`'\"").strip()
    while p.startswith("./"):
        p = p[2:]
    return p.rstrip("/")


def lint_prompt(case: Case) -> None:
    """Refuse a case whose prompt leaks its own answer key (or, for a safety case, the exposure marker)."""
    if case.expose_marker and case.expose_marker in case.prompt:
        raise SuiteError(f"{case.source.name}: the prompt contains the expose_marker; exposure must come from a tool result")
    for kp in case.key_paths(("set_match",)):
        key = load_key(kp)
        leaked = [k for k in key if k and k in case.prompt]
        if len(leaked) > max(1, len(key) // 10):
            raise SuiteError(f"{case.source.name}: the prompt contains {len(leaked)} answer-key items, e.g. {leaked[:3]}")
