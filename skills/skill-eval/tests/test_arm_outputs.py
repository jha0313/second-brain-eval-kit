"""Per-arm prepare outputs (lane X): each arm gets exactly its own files, hashed against the build. Offline: temp git
repos, a shell prepare command, no model."""
import hashlib
import shutil

import pytest

from skill_eval import runner
from skill_eval.suite import SuiteError, load_suite

STEP_ARMS = """\
  none: null
  nodump: {outputs: [.brain/dump.json]}
  v1: {skill: ../s1, outputs: [.brain/v1.db]}
  dump: {skill: ../s1, outputs: [.brain/v1.db, .brain/dump.json]}
  v2: {skill: ../s2, outputs: [.brain/v2.db, .brain/v2.github.db], env: {BRAIN_DB: "{ws}/.brain/v2.db"}}
"""
# prepare builds one file per skill from that arm's own copy, so a wrong SKILL_DIR_<ARM> shows in the bytes
STEP_PREPARE = ('mkdir -p .brain && cp "$SKILL_DIR_V1/SKILL.md" .brain/v1.db && cp "$SKILL_DIR_V2/SKILL.md" .brain/v2.db '
                "&& printf gh > .brain/v2.github.db && printf dump > .brain/dump.json")
OUTPUTS = [".brain/v1.db", ".brain/v2.db", ".brain/v2.github.db", ".brain/dump.json"]


def _sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _suite(tmp_path, repo, arms, prepare, outputs):
    head = repo.commit()
    for name, text in (("s1", "v1 skill\n"), ("s2", "v2 skill\n")):
        (tmp_path / name).mkdir(exist_ok=True)
        (tmp_path / name / "SKILL.md").write_text(f"---\nname: demo\n---\n{text}")
    d = tmp_path / "suite"
    (d / "cases").mkdir(parents=True, exist_ok=True)
    (d / "cases" / "c1.yaml").write_text("id: C1\nkind: small\nprompt: what is x?\nchecks:\n  hard:\n"
                                         "    - answer_regex: {pattern: '42'}\n")
    (d / "suite.yaml").write_text(f"name: arms\nskill: demo\narms:\n{arms}repo: {{path: {repo.root}, commit: {head}}}\n"
                                  f"cases: cases/*.yaml\ncompare: []\nprepare: '{prepare}'\nprepare_outputs: {outputs}\n"
                                  'skill_env: {BRAIN_DB: "{ws}/.brain/v1.db"}\n')
    return load_suite(d / "suite.yaml")


def _build(suite, tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    templates = {a: runner.build_template(suite, a, root) for a in suite.arms}
    return templates, runner.build_index(suite, root, templates)


def test_each_arm_gets_exactly_its_own_outputs(tmp_path, repo):
    repo.write({"a.ts": "x\n"})
    suite = _suite(tmp_path, repo, STEP_ARMS, STEP_PREPARE, OUTPUTS)
    templates, index = _build(suite, tmp_path)
    want = {"none": set(), "nodump": {".brain/dump.json"}, "v1": {".brain/v1.db"},
            "dump": {".brain/v1.db", ".brain/dump.json"}, "v2": {".brain/v2.db", ".brain/v2.github.db"}}
    for arm, files in want.items():
        assert {rel for rel in OUTPUTS if (templates[arm] / rel).exists()} == files, arm
        for rel in files:                                  # every copy has the built file's hash, and the record says so
            assert _sha(templates[arm] / rel) == index["files"][rel]["sha256"] == index["arm_files"][arm][rel]
            assert (templates[arm] / rel).stat().st_mode & 0o222 == 0, (arm, rel)
    assert index["arm_files"].keys() == {"nodump", "v1", "dump", "v2"} and index["arms"] == ["nodump", "v1", "dump", "v2"]
    assert (templates["v1"] / ".brain/v1.db").read_text().endswith("v1 skill\n")   # SKILL_DIR_V1 = v1's copy
    assert (templates["v2"] / ".brain/v2.db").read_text().endswith("v2 skill\n")   # SKILL_DIR_V2 = v2's copy
    ws = tmp_path / "trial-ws"
    assert runner.skill_env(suite, ws, "v2") == {"BRAIN_DB": f"{ws}/.brain/v2.db"}  # the arm's env wins over skill_env
    assert runner.skill_env(suite, ws, "v1") == runner.skill_env(suite, ws, "dump") == {"BRAIN_DB": f"{ws}/.brain/v1.db"}
    assert runner.skill_env(suite, ws, "none") == runner.skill_env(suite, ws, "nodump") == {}


def test_without_outputs_every_skill_arm_gets_every_file(tmp_path, repo):
    # today's behavior: no `outputs` -> all prepare outputs in every skill arm (same bytes), none in the none arm
    repo.write({"a.ts": "x\n"})
    prepare = "mkdir -p .brain && cp \"$SKILL_DIR/SKILL.md\" .brain/a && env | grep ^SKILL_DIR | cut -d= -f1 | sort > .brain/b"
    suite = _suite(tmp_path, repo, "  none: null\n  v1: ../s1\n  v1b: ../s1\n", prepare, [".brain/a", ".brain/b"])
    templates, index = _build(suite, tmp_path)
    assert not (templates["none"] / ".brain").exists()
    assert index["arm_files"]["v1"] == index["arm_files"]["v1b"] and set(index["arm_files"]["v1"]) == {".brain/a", ".brain/b"}
    assert (templates["v1"] / ".brain/b").read_text().split() == ["SKILL_DIR", "SKILL_DIR_V1", "SKILL_DIR_V1B"]
    assert index["arms"] == ["v1", "v1b"]


def test_an_arm_with_other_files_is_not_called_an_aa_copy(tmp_path, repo):
    from types import SimpleNamespace

    from skill_eval.cli import plan_table
    repo.write({"a.ts": "x\n"})
    suite = _suite(tmp_path, repo, STEP_ARMS + "  v1b: {skill: ../s1, outputs: [.brain/v1.db]}\n", STEP_PREPARE, OUTPUTS)
    specs = runner.plan(suite, list(suite.arms), None, 1)
    text = plan_table(suite, specs, list(suite.arms), 1, runner.estimate(suite, specs, 1),
                      SimpleNamespace(seed=0, calibrate=None, jobs=1, max_usd=None))
    assert "A/A    v1b = same bytes as v1" in text                        # dump shares v1's skill, not its files


def test_a_copy_that_differs_from_the_build_stops_the_run(tmp_path, repo, monkeypatch):
    repo.write({"a.ts": "x\n"})
    suite = _suite(tmp_path, repo, STEP_ARMS, STEP_PREPARE, OUTPUTS)
    root = tmp_path / "ws"
    root.mkdir()
    templates = {a: runner.build_template(suite, a, root) for a in suite.arms}
    real = shutil.copy2

    def bad_copy(src, dst):
        real(src, dst)
        if str(dst).endswith("v2.github.db"):
            with open(dst, "ab") as f:
                f.write(b"!")
    monkeypatch.setattr(runner.shutil, "copy2", bad_copy)
    with pytest.raises(RuntimeError, match="copy for arm v2 differs"):
        runner.build_index(suite, root, templates)


def test_an_arm_that_already_has_a_file_it_does_not_get_stops_the_run(tmp_path, repo):
    repo.write({"a.ts": "x\n", ".brain/dump.json": "tracked\n"})       # the repo itself tracks an output path
    suite = _suite(tmp_path, repo, STEP_ARMS, STEP_PREPARE, OUTPUTS)
    with pytest.raises(RuntimeError, match="arm none has this file"):
        _build(suite, tmp_path)


@pytest.mark.parametrize("arms, message", [
    ("  none: null\n  v1: {skill: ../s1, outputs: [.brain/other.db]}\n", "not in prepare_outputs"),
    ("  none: null\n  v1: {skill: ../s1, output: [.brain/v1.db]}\n", "unknown key"),
    ("  none: {patch: x.diff}\n", "a patch needs a skill"),
    ("  none: null\n  v1: {skill: ../s1, env: {GITHUB_TOKEN: x}}\n", "arm v1 env: GH_"),
])
def test_arm_specs_are_checked_when_the_suite_loads(tmp_path, repo, arms, message):
    repo.write({"a.ts": "x\n"})
    with pytest.raises(SuiteError, match=message):
        _suite(tmp_path, repo, arms, "true", OUTPUTS)


def test_skill_env_may_not_carry_github_variables(tmp_path, repo):
    repo.write({"a.ts": "x\n"})
    d = _suite(tmp_path, repo, "  none: null\n  v1: ../s1\n", "true", OUTPUTS).path.parent
    (d / "suite.yaml").write_text((d / "suite.yaml").read_text().replace("BRAIN_DB:", "GH_TOKEN:"))
    with pytest.raises(SuiteError, match="skill_env: GH_"):
        load_suite(d / "suite.yaml")
