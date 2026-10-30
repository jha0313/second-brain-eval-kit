"""keycheck and unfilled template placeholders (E6). Offline: a temp repo and a copy of suites/example."""
import json
import shutil
from pathlib import Path

import pytest
from conftest import lines

from skill_eval import cli
from skill_eval.keycheck import PLACEHOLDER, check_keys
from skill_eval.suite import SuiteError, load_suite

EXAMPLE = Path(__file__).resolve().parents[1] / "suites" / "example"


def _filled_example(tmp_path, repo):
    """suites/example with every <…> filled for a three-file repo, as a new user would."""
    repo.write({"src/lib/credits.ts": lines(6), "src/lib/charge.ts": "import './credits'\n",
                "__tests__/charge.test.ts": "import '../src/lib/charge'\n",
                "changes/20261001-reserve-first.md": lines(3), "docs/credits.md": lines(5)})
    sha = repo.commit("reserve credits first")
    d = tmp_path / "suites" / "example"
    shutil.copytree(EXAMPLE, d)
    (d / "suite.yaml").write_text((d / "suite.yaml").read_text().replace("<40자 커밋 SHA>", sha)
                                  .replace("../../../codebase-brain", str(tmp_path / "skill")))
    (tmp_path / "skill").mkdir()
    (tmp_path / "skill" / "SKILL.md").write_text("---\nname: codebase-brain\n---\n")
    c = d / "cases"
    for f, old, new in (("find-all.json", "<path/to/module.ts>", "src/lib/credits.ts"),
                        ("why.json", "<module or behavior>", "credit reservation"),
                        ("controls.json", "<path/to/file.ts>", "src/lib/credits.ts"),
                        ("controls.json", "<function>", "reserve"), ("controls.json", "<condition>", "the balance is short")):
        (c / f).write_text((c / f).read_text().replace(old, new))
    k = c / "answer-keys"
    (k / "EX-FA1.json").write_text(json.dumps({"id": "EX-FA1", "unit": "file", "method": "git grep",
                                               "items": ["src/lib/charge.ts", "__tests__/charge.test.ts"]}))
    (k / "EX-W1.json").write_text(json.dumps({"id": "EX-W1", "sources": [{"commit": sha[:8]}, {"path": "changes/20261001-reserve-first.md"},
                                                                         {"path": "docs/credits.md", "lines": [1, 5]}],
                                              "facts": ["reserve first"], "forbidden": ["charge after"]}))
    (k / "EX-C1.json").write_text(json.dumps({"id": "EX-C1", "file": "src/lib/credits.ts", "expected": "null",
                                              "cite": "src/lib/credits.ts:4"}))
    return d / "suite.yaml", sha


def test_placeholder_pattern_skips_code():
    assert PLACEHOLDER.findall("In <path/to/file.ts>, <40자 커밋 SHA>, <module or behavior>, <…>") == [
        "<path/to/file.ts>", "<40자 커밋 SHA>", "<module or behavior>", "<…>"]
    assert PLACEHOLDER.findall("returns Promise<void> or Map<string, number> and a <T>") == []


def test_unfilled_example_is_refused(tmp_path, repo, monkeypatch):
    repo.write({"a.ts": "x\n"})
    repo.commit()
    monkeypatch.setenv("MY_REPO", str(repo.root))
    d = tmp_path / "example"
    shutil.copytree(EXAMPLE, d)                       # the skill folder filled in, the commit left as the template has it
    (tmp_path / "skill").mkdir()
    (tmp_path / "skill" / "SKILL.md").write_text("---\nname: codebase-brain\n---\n")
    (d / "suite.yaml").write_text((d / "suite.yaml").read_text().replace("../../../codebase-brain", str(tmp_path / "skill")))
    with pytest.raises(SuiteError, match="repo.commit is not a commit SHA"):
        load_suite(d / "suite.yaml")


def test_filled_example_passes_and_broken_keys_are_named(tmp_path, repo):
    suite_file, _ = _filled_example(tmp_path, repo)
    s = load_suite(suite_file, str(repo.root))
    assert check_keys(s) == []
    assert cli.main(["keycheck", str(suite_file), "--repo", str(repo.root)]) == 0
    assert cli.main(["selftest", str(suite_file), "--repo", str(repo.root)]) == 0
    k = suite_file.parent / "cases" / "answer-keys"
    w = json.loads((k / "EX-W1.json").read_text())
    w["sources"] = [{"commit": "deadbee1"}, {"path": "docs/credits.md", "lines": [3, 9]}, {"path": "credits.md"}]
    (k / "EX-W1.json").write_text(json.dumps(w))
    fa = json.loads((k / "EX-FA1.json").read_text())
    fa["items"].append("<path/to/importer-b.test.ts>")
    (k / "EX-FA1.json").write_text(json.dumps(fa))
    found = [(p["where"], p["problem"]) for p in check_keys(load_suite(suite_file, str(repo.root)))]
    assert ("EX-W1", "commit deadbee1 is not a commit") in found
    assert ("EX-W1", "docs/credits.md:3-9 is outside the file (5 lines)") in found
    assert any(w_ == "EX-W1" and "credits.md is not a file" in p for w_, p in found)          # keys use full paths
    assert ("EX-FA1.json", "unfilled placeholder <path/to/importer-b.test.ts>") in found
    assert cli.main(["freeze", str(suite_file), "--repo", str(repo.root)]) == 1             # freeze refuses
    assert not (suite_file.parent / "FROZEN.json").exists()
