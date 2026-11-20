import subprocess

import pytest


class Repo:
    """A throwaway git repo for grading tests: write files, commit, read the SHA."""

    def __init__(self, root):
        self.root = root
        root.mkdir(parents=True)
        self.git("init", "-q")

    def git(self, *a):
        return subprocess.run(["git", "-C", str(self.root), *a], capture_output=True, text=True, check=True).stdout.strip()

    def write(self, files: dict):
        for rel, text in files.items():
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)

    def commit(self, msg="c") -> str:
        self.git("add", "-A")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg)
        return self.git("rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    return Repo(tmp_path / "repo")


@pytest.fixture(autouse=True)
def own_run_lock(tmp_path, monkeypatch):
    """`run` takes a lock under the user's cache dir: in tests it is a temp one, never the real ~/.cache. The
    machine's own SKILL_EVAL_DENY_EXTRA would change the deny list and the probe's items: tests set their own."""
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.delenv("SKILL_EVAL_DENY_EXTRA", raising=False)


def lines(n, word="line"):
    return "".join(f"{word} {i}\n" for i in range(1, n + 1))
