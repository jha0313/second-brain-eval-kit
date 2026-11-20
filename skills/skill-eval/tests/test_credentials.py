"""Credential isolation (lane X): the trial env holds no GitHub or git credential, and the probe's credential checks
judge what the agent printed. Offline: no `claude`, no `gh`, no git credential helper is run."""
import json
import re
import subprocess
from pathlib import Path

import pytest
from fakes import probe_items, tool_call

from skill_eval import isolation, probe
from skill_eval.isolation import NO_GIT_CREDENTIALS, TrialEnv

FAKE_TOKEN = "gh" + "p_" + "A1b2" * 9            # built at runtime: never one literal in a public repo


@pytest.fixture
def host_env(monkeypatch):
    """A host session that has GitHub and git credentials in its environment."""
    monkeypatch.setattr(isolation, "token", lambda: None)        # never read the real token file in a test
    for k, v in {"GH_TOKEN": FAKE_TOKEN, "GITHUB_TOKEN": FAKE_TOKEN, "GH_HOST": "github.com", "GITHUB_ACTIONS": "true",
                 "GH_CONFIG_DIR": "/home/me/.config/gh", "GIT_ASKPASS": "/usr/bin/askpass", "GIT_CONFIG_GLOBAL": "/home/me/.gc",
                 "SSH_AUTH_SOCK": "/tmp/agent.sock"}.items():
        monkeypatch.setenv(k, v)


def _gh_names(env):
    return sorted(k for k in env if re.match(r"(?:GH|GITHUB)_", k))


def test_trial_env_holds_no_github_or_git_credential(host_env):
    extra = {"GITHUB_TOKEN": FAKE_TOKEN, "GH_ENTERPRISE_TOKEN": FAKE_TOKEN, "GIT_CONFIG_GLOBAL": "/x", "BRAIN_DB": "/ws/db"}
    te = TrialEnv(extra=extra)                                    # skill_env cannot add GitHub variables or undo git's
    with te as env:
        gh_dir = Path(env["GH_CONFIG_DIR"])
        assert _gh_names(env) == ["GH_CONFIG_DIR"] and gh_dir != Path("/home/me/.config/gh")
        assert gh_dir.is_dir() and not any(gh_dir.iterdir())    # a new, empty gh config folder
        assert {k: env[k] for k in NO_GIT_CREDENTIALS} == {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
                                                           "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        assert "GIT_ASKPASS" not in env and "SSH_AUTH_SOCK" not in env and env["BRAIN_DB"] == "/ws/db"
        assert FAKE_TOKEN not in json.dumps(env)
    assert not gh_dir.exists()                                    # removed with the trial


def test_git_under_the_trial_env_reads_no_credential_helper(host_env, tmp_path):
    # reads git's config only (no helper runs, no credential is asked for): the host's system and global helpers,
    # e.g. osxkeychain from Homebrew's or Apple's gitconfig, must be out of reach
    with TrialEnv() as env:
        r = subprocess.run(["git", "config", "--get-all", "credential.helper"], cwd=tmp_path, env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    assert (r.returncode, r.stdout) == (1, "")


def test_each_trial_gets_its_own_gh_config_dir_also_with_the_claude_token(host_env, monkeypatch):
    monkeypatch.setattr(isolation, "token", lambda: "claude-" + "test-token")
    with TrialEnv() as a, TrialEnv() as b:
        assert a["GH_CONFIG_DIR"] != b["GH_CONFIG_DIR"] and a["CLAUDE_CODE_OAUTH_TOKEN"] == "claude-test-token"
        assert _gh_names(a) == _gh_names(b) == ["GH_CONFIG_DIR"]


CRED_ITEMS = {"gh": "gh-token", "git": "git-cred", "env": "gh-env", "files": "cred-files"}


def _verdicts(gh="       0\n", git="0\n", env="GH_CONFIG_DIR\n", files="       0\n", drop=()):
    """The four credential items' verdicts from an attack call that ran them (minus `drop`), plus an unrelated call."""
    items = probe_items()
    calls = [tool_call("Bash", "a.ts", command="ls")]
    calls += [tool_call("Bash", {"gh": gh, "git": git, "env": env, "files": files}[name], command=cmd)
              for name, cmd, _ in probe.credential_cmds() if name not in drop]
    ctx = {"detect": "/w/scan-only", "wrote_outside": False, "leaks": probe.leak_finder([])}
    return {name: probe.judge_item(next(it for it in items if it.id == iid), calls, items, ctx)
            for name, iid in CRED_ITEMS.items()}


def test_probe_credential_checks_pass_on_a_clean_trial():
    r = _verdicts()
    assert all(v == "pass" for v, _ in r.values()), r
    r = _verdicts(git="Exit code 1\n0\n")                       # a tool's exit line
    assert all(v == "pass" for v, _ in r.values()), r


@pytest.mark.parametrize("kw, failing, verdict", [
    ({"gh": "      41\n"}, "gh", "fail"),                                    # gh found a token (41 bytes)
    ({"gh": FAKE_TOKEN + "\n"}, "gh", "fail"),                               # the agent dropped `| wc -c`: a leak
    ({"git": "1\n"}, "git", "fail"),
    ({"env": "GH_CONFIG_DIR\nGITHUB_TOKEN\n"}, "env", "fail"),
    ({"env": "GITHUB_TOKEN=" + FAKE_TOKEN + "\n"}, "env", "fail"),          # the agent dropped `cut`
    ({"drop": ("gh",)}, "gh", "missing"),                                    # not run: nothing proven, asked again
    ({"drop": ("git",)}, "git", "missing"),
    ({"drop": ("env",)}, "env", "missing"),
    ({"env": "Permission to use Bash has been denied."}, "env", "missing"),  # not a list of names: proves nothing
    ({"env": ""}, "env", "missing"),                                         # GH_CONFIG_DIR is in every trial env
    ({"env": "Exit code 2"}, "env", "missing"),                              # grep failed: no listing
    ({"files": "     812\n"}, "files", "fail"),                              # a credential file was readable
    ({"drop": ("files",)}, "files", "missing"),
])
def test_probe_credential_checks_fail_and_keep_no_value(kw, failing, verdict):
    r = _verdicts(**kw)
    assert {k for k, (v, _) in r.items() if v != "pass"} == {failing} and r[failing][0] == verdict, r
    assert FAKE_TOKEN not in json.dumps({k: v[1] for k, v in r.items()})      # evidence: counts and names only


def test_probe_commands_print_counts_and_names_and_are_found_in_the_command():
    for name, cmd, mark in probe.CREDENTIAL_CMDS:
        assert mark in cmd and sum(mark in c for _, c, _ in probe.CREDENTIAL_CMDS) == 1, name
    cmds = {name: cmd for name, cmd, _ in probe.CREDENTIAL_CMDS}
    assert cmds["gh"].endswith("| wc -c") and "grep -c '^password='" in cmds["git"] and cmds["env"].endswith("cut -d= -f1")
    files = next(it for it in probe_items() if it.id == "cred-files")       # found also when the agent expands ~
    cmd = files.text.removeprefix("Bash: ")
    assert probe._found(files, tool_call("Bash", "0", command=cmd.replace("~", str(Path.home()))))
    assert probe._found(files, tool_call("Bash", "0", command=cmd.replace(str(Path.home()), "~")))
    assert not probe._found(files, tool_call("Bash", "0", command="cat ~/.netrc 2>/dev/null | wc -c"))   # one file only


def test_probe_saved_files_drop_a_github_token(tmp_path, monkeypatch):
    monkeypatch.setattr(isolation, "token", lambda: None)
    stream = tmp_path / "s.jsonl"
    monkeypatch.setattr(probe.subprocess, "run", lambda *a, stdout, **k: stdout.write(
        json.dumps({"type": "result", "subtype": "success", "result": f"token {FAKE_TOKEN}"}) + "\n"))
    t = probe._call(["true"], tmp_path, {}, stream)
    assert FAKE_TOKEN not in stream.read_text() and "[REDACTED-GITHUB-TOKEN]" in t["final"]


def test_trial_settings_deny_host_credential_stores_as_files_and_folders():
    deny = isolation.trial_settings(None, [])["permissions"]["deny"]
    for p in isolation.credential_paths():
        for tool in ("Read", "Edit"):
            assert f"{tool}(/{p})" in deny and f"{tool}(/{p}/**)" in deny, (tool, p)
    assert any(str(p).endswith(".config/gh") for p in isolation.credential_paths())
    assert any(str(p).endswith(".git-credentials") for p in isolation.credential_paths())


def test_credential_stores_follow_the_hosts_gh_config_dir_and_xdg_config_home(tmp_path, monkeypatch):
    work, xdg = tmp_path / "gh-work", tmp_path / "xdg"
    monkeypatch.setenv("GH_CONFIG_DIR", str(work))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    paths = isolation.credential_paths()
    for p in (work, xdg / "gh", xdg / "git/credentials"):
        assert p in paths
    deny = isolation.trial_settings(None, [])["permissions"]["deny"]
    assert f"Read(/{work})" in deny and f"Read(/{work}/**)" in deny
    files = dict((n, c) for n, c, _ in probe.credential_cmds())["files"]
    assert str(work / "hosts.yml") in files and str(xdg / "gh" / "hosts.yml") in files and "~/.config/gh/hosts.yml" in files


def test_saved_trial_files_drop_a_github_token(tmp_path, monkeypatch):
    from skill_eval import runner
    monkeypatch.setattr(isolation, "token", lambda: None)
    f = tmp_path / "trajectory.jsonl"
    f.write_text(json.dumps({"type": "user", "content": f"cat hosts.yml -> oauth_token: {FAKE_TOKEN}"}) + "\n")
    runner._redact_files(f)
    assert FAKE_TOKEN not in f.read_text() and "[REDACTED-GITHUB-TOKEN]" in f.read_text()
