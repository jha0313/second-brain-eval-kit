"""keycheck: do the answer keys point at things that exist at the suite commit? ($0, no model call)

A key that names a file, a line range or a commit that is not there grades every trial against nothing, and a
template placeholder (<path/to/file.ts>) left in a case or a key does the same. selftest asks "does the grader
accept the key?"; this asks "is the key itself real?". freeze refuses to fix a suite that fails it."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .checks import _git, line_count, lines_ok, tracked_files
from .suite import load_key, load_sources

# Template placeholders as suites/example writes them: <path/to/file.ts>, <40자 커밋 SHA>, <module or behavior>, and the
# one-word slots <function> and <condition>. Code in a prompt such as Promise<void>, Map<string, number>, <Meter />,
# </div>, <a href="/x"> or <!-- … --> is not one.
SLOT = re.compile(r"<[^<>\n]{1,160}>")
SIGNAL = re.compile(r"/|[가-힣]|…|\s(?:or|to)\s")
TEMPLATE_WORDS = {"<function>", "<condition>"}          # one word, nothing else to tell them from code by
TAG = re.compile(r"<[A-Za-z][\w.:-]*(?:\s+[\w:@.-]+\s*=|\s*/>$)")      # <a href=…>, <Meter />


def find_placeholders(text: str) -> list[str]:
    out = []
    for m in SLOT.finditer(text):
        s = m.group(0)
        markup = s.startswith(("</", "<!")) or TAG.match(s)
        if s in TEMPLATE_WORDS or (SIGNAL.search(s) and not markup):
            out.append(s)
    return out


def _site(item: str) -> tuple[str, tuple[int, int] | None]:
    m = re.fullmatch(r"(.+?):(\d+)(?:-(\d+))?", item)
    if not m:
        return item, None
    a = int(m.group(2))
    return m.group(1), (a, int(m.group(3) or a))


def check_keys(suite) -> list[dict]:
    """[{"where": file or case id, "problem": text}], empty when every key points at something real."""
    problems = []

    def bad(where, problem):
        problems.append({"where": where, "problem": problem})

    texts = {suite.path} | {c.source for c in suite.cases} | {Path(k) for c in suite.cases for k in c.key_paths()}
    texts |= {Path(chk["answer_regex"]["source_key"]) for c in suite.cases for chk in c.hard
              if "answer_regex" in chk and chk["answer_regex"].get("source_key")}
    for f in sorted(texts):
        text = f.read_text()
        if f.suffix in (".yaml", ".yml"):
            text = re.sub(r"(?m)(^|\s)#.*$", "", text)       # comments may explain the placeholders
        for slot in find_placeholders(text):
            bad(f.name, f"unfilled placeholder {slot}")
    if _git(suite.repo, "cat-file", "-e", f"{suite.commit}^{{commit}}").returncode != 0:
        bad("suite", f"repo.commit {suite.commit[:12]} is not a commit in {suite.label}")
        return problems
    files = tracked_files(suite.repo, suite.commit)

    def path_at(where, path, lines=None):
        if path not in files:
            bad(where, f"{path} is not a file at {suite.commit[:8]} (keys use full repo paths)")
        elif lines and not lines_ok(tuple(lines), line_count(suite.repo, suite.commit, path)):
            bad(where, f"{path}:{lines[0]}-{lines[1]} is outside the file ({line_count(suite.repo, suite.commit, path)} lines)")

    for c in suite.cases:
        for chk in c.hard:
            name, args = next(iter(chk.items()))
            if name == "set_match":
                for item in sorted(load_key(args["key"])):
                    path, lines = _site(item) if args.get("unit") == "site" else (item, None)
                    path_at(c.id, path, lines)
            elif name == "sources_hit":
                for src in load_sources(args["key"]):
                    if "commit" in src:
                        if _git(suite.repo, "cat-file", "-e", f"{src['commit']}^{{commit}}").returncode != 0:
                            bad(c.id, f"commit {src['commit']} is not a commit")
                    else:
                        path_at(c.id, src["path"], src.get("lines"))
            elif name == "answer_regex" and args.get("source_key"):
                k = json.loads(Path(args["source_key"]).read_text())
                if k.get("cite"):
                    path, lines = _site(k["cite"])
                    path_at(c.id, path, lines)
                if k.get("file"):
                    path_at(c.id, k["file"])
    return problems
