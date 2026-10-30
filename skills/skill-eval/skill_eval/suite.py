"""Load a suite file and its cases. Cases hold the request and the checks; answers stay outside the prompt."""
from __future__ import annotations

import glob
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

KINDS = {"find-all", "why", "small", "other"}
HARD_CHECKS = {"skill_loaded", "tool_used", "tool_not_used", "tool_order", "set_match", "cites_exist", "answer_regex",
               "sources_hit"}
DEFAULT_LIMITS = {"max_turns": 40, "timeout_s": 900, "max_usd": 3.0}


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
    arms, patches = {}, {}
    for name, spec in (raw.get("arms") or {}).items():
        if isinstance(spec, dict):                 # {skill: dir, patch: v2.diff} = the same skill plus a small edit
            arms[name] = _resolve(base, spec["skill"])
            if spec.get("patch"):
                patches[name] = _resolve(base, spec["patch"])
                if not patches[name].exists():
                    raise SuiteError(f"arm {name}: patch not found: {patches[name]}")
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
    )
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
    trusted = {suite.dir} | {Path(f).parent for f in files}
    trusted |= {kp.parent for c in suite.cases for kp in c.key_paths()}
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
        if name == "set_match":
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
    )
    lint_prompt(case)
    return case


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
                     limits=dict(suite.limits), pass_threshold=suite.pass_threshold, source=path, family=raw.get("family", ""))
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
    """why answer key: [{"commit": sha} | {"path": p, "lines": [a, b]?}, ...]"""
    return json.loads(Path(path).read_text())["sources"]


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
                tag = f"commit:{src['commit'][:7]}" if "commit" in src else f"path:{src['path']}:{src.get('lines')}"
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
    """Refuse a case whose prompt leaks its own answer key."""
    for kp in case.key_paths(("set_match",)):
        key = load_key(kp)
        leaked = [k for k in key if k and k in case.prompt]
        if len(leaked) > max(1, len(key) // 10):
            raise SuiteError(f"{case.source.name}: the prompt contains {len(leaked)} answer-key items, e.g. {leaked[:3]}")
