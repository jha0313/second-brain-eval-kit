"""Arms that reach one server (Phase 2 v3): `network` (sandbox allowlist), `secret_env` (host values, redacted), and
keycheck for find-all items that are memory pointers (pr:N, commit:<sha>, doc:<path>) and declared format slots."""
import json
import shutil
from pathlib import Path

import pytest
from conftest import lines

from skill_eval import isolation, runner
from skill_eval.isolation import redact, register_secret, scan_saved, trial_settings
from skill_eval.keycheck import check_keys
from skill_eval.suite import SuiteError, load_suite

# made up; built from parts so that no connection-string literal sits in the source
PW = "s3cr3t-" + "Pa55word"
URL = "postgresql://brain_reader:" + PW + "@ep-test-123.us-west-2.aws.neon.tech/neondb?sslmode=require"


@pytest.fixture(autouse=True)
def _no_leftover_secrets():
    isolation._SECRETS.clear()
    yield
    isolation._SECRETS.clear()


def _suite(tmp_path, repo, arms_yaml, extra="", cases=None, keys=None):
    repo.write({"docs/a.md": lines(3), "src/x.ts": lines(2)})
    sha = repo.commit("one")
    skill = tmp_path / "skill"
    skill.mkdir(exist_ok=True)
    (skill / "SKILL.md").write_text("---\nname: codebase-brain\n---\n")
    d = tmp_path / "suite"
    (d / "cases" / "answer-keys").mkdir(parents=True)
    for cid, key in (keys or {"W1": {"id": "W1", "sources": [{"path": "docs/a.md"}], "facts": ["a"]}}).items():
        (d / "cases" / "answer-keys" / f"{cid}.json").write_text(json.dumps(key))
    (d / "cases" / "c.json").write_text(json.dumps(ensure_ascii=False, obj=cases or [{"id": "W1", "type": "why", "prompt": "Why a?", "answer_key": "answer-keys/W1.json"}]))
    (d / "suite.yaml").write_text(f"name: t\nskill: codebase-brain\narms:\n  none: null\n{arms_yaml}\n"
                                  f"repo: {{path: {repo.root}, commit: {sha}}}\ncases: cases/c.json\n{extra}")
    return d / "suite.yaml", sha


def test_arm_network_and_secret_env_load(tmp_path, repo):
    y, _ = _suite(tmp_path, repo, f"  v3: {{skill: {tmp_path}/skill, network: [EP-Test-123.us-west-2.aws.neon.tech], secret_env: [BRAIN_READER_URL]}}")
    s = load_suite(y)
    assert s.arm_network == {"v3": ["ep-test-123.us-west-2.aws.neon.tech"]}
    assert s.arm_secret_env == {"v3": ["BRAIN_READER_URL"]}


@pytest.mark.parametrize("arm, msg", [
    ("network: ['https://ep.neon.tech']", "host names only"),
    ("network: ['ep.neon.tech:5432']", "host names only"),
    ("secret_env: [GH_TOKEN]", "secret_env takes env var names"),
    ("secret_env: [bad-name]", "secret_env takes env var names"),
    ("env: {BRAIN_READER_URL: x}, secret_env: [BRAIN_READER_URL]", "both in env and secret_env"),
])
def test_bad_arm_network_or_secret_is_refused(tmp_path, repo, arm, msg):
    y, _ = _suite(tmp_path, repo, f"  v3: {{skill: {tmp_path}/skill, {arm}}}")
    with pytest.raises(SuiteError, match=msg):
        load_suite(y)


def test_trial_settings_network_allowlist():
    assert "network" not in trial_settings(None, [])["sandbox"]
    s = trial_settings("codebase-brain", [], network=["ep-test-123.us-west-2.aws.neon.tech"])
    assert s["sandbox"]["network"] == {"allowedDomains": ["ep-test-123.us-west-2.aws.neon.tech"], "strictAllowlist": True}
    assert s["sandbox"]["enabled"] is True and s["sandbox"]["allowUnsandboxedCommands"] is False


def test_secret_url_and_password_are_redacted(tmp_path):
    register_secret(URL)
    text = f"url={URL}\npassword alone: {PW}\nencoded: {PW}@"
    out = redact(text)
    assert "s3cr3t" not in out and "brain_reader:" not in out and "[REDACTED-SECRET]" in out
    (tmp_path / "trajectory.jsonl").write_text(json.dumps({"tool_result": f"cat .env.local -> BRAIN_READER_URL={URL}"}))
    r = scan_saved(tmp_path)
    assert r["secret_env"] == "found and redacted" and r["files_with_secret"] == 1
    assert "s3cr3t" not in (tmp_path / "trajectory.jsonl").read_text()


def test_secret_env_reads_the_host_and_registers(tmp_path, repo, monkeypatch):
    y, _ = _suite(tmp_path, repo, f"  v3: {{skill: {tmp_path}/skill, secret_env: [BRAIN_READER_URL]}}\n  v2: {tmp_path}/skill")
    s = load_suite(y)
    monkeypatch.delenv("BRAIN_READER_URL", raising=False)
    with pytest.raises(RuntimeError, match="not set on the host"):
        runner.secret_env(s, "v3")
    assert runner.secret_env(s, "v2") == {}           # an arm without secret_env needs nothing
    monkeypatch.setenv("BRAIN_READER_URL", URL)
    assert runner.secret_env(s, "v3") == {"BRAIN_READER_URL": URL}
    assert runner.secret_env(s) == {"BRAIN_READER_URL": URL}     # prepare (host): every arm's
    assert "s3cr3t" not in redact(URL)


def test_keycheck_pointer_items_and_format_slots(tmp_path, repo):
    keys = {"K1": {"id": "K1", "unit": "site", "items": ["pr:12", "issue:7", "commit:SHA8", "doc:docs/a.md", "change:changes/x.md"]}}
    cases = [{"id": "K1", "type": "find-all", "unit": "site", "answer_key": "answer-keys/K1.json",
              "prompt": "List them as pr:N, commit:<SHA 앞 8자>, doc:<경로>."}]
    y, sha = _suite(tmp_path, repo, "", cases=cases, keys=keys)
    k = tmp_path / "suite" / "cases" / "answer-keys" / "K1.json"
    k.write_text(k.read_text().replace("SHA8", sha[:8]))
    (tmp_path / "suite" / "gh.json").write_text(json.dumps({"repo": "o/r", "items": {"pr:12": None, "issue:7": None}}))
    y.write_text(y.read_text() + "github_evidence: gh.json\n")
    problems = [f"{p['where']} {p['problem']}" for p in check_keys(load_suite(y))]
    assert any("<SHA 앞 8자>" in p for p in problems) and any("<경로>" in p for p in problems)   # not declared yet
    assert any("changes/x.md is not a file" in p for p in problems)                             # doc/change: real paths
    assert not any(f"{x} is not" in p for x in ("pr:12", "issue:7", sha[:8], "docs/a.md") for p in problems)
    y.write_text(y.read_text() + 'format_slots: ["<SHA 앞 8자>", "<경로>"]\n')
    problems = [f"{p['where']} {p['problem']}" for p in check_keys(load_suite(y))]
    assert problems and all("changes/x.md" in p for p in problems)
    k.write_text(k.read_text().replace('"pr:12"', '"pr:13"').replace(sha[:8], "deadbeef"))
    problems = [f"{p['where']} {p['problem']}" for p in check_keys(load_suite(y))]
    assert any("pr:13 is not in github_evidence" in p for p in problems)
    assert any("deadbeef is not a commit" in p for p in problems)
