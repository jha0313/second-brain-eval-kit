"""Trial isolation: what one `claude -p` trial can see, run and write.

A fresh folder is not a security boundary, so a trial gets several layers (probe-verified, `skill-eval probe`):
- a new, empty CLAUDE_CONFIG_DIR per trial -> no user skills, plugins, hooks, memory, CLAUDE.md, MCP
  (auth: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, read from a 0600 file, given only to the child)
- --setting-sources project, --strict-mcp-config with an empty config, --no-chrome
- run settings: bundled skills off, disableAllHooks, auto-memory off, sandbox on, Read/Edit deny rules for
  answer keys, rubrics, skill sources, the token file and ~/.claude
- an env allowlist: the child does not inherit this session's CLAUDE_CODE_* variables
- Read/Edit deny rules (and so the sandbox's read rules for Bash) for host credential stores: ~/.config/gh
  (gh's hosts.yml), ~/.git-credentials, ~/.config/git/credentials, ~/.netrc, ~/.ssh. An empty GH_CONFIG_DIR only
  changes where gh looks; an injected `cat ~/.config/gh/hosts.yml` would still read the file without these
- saved trial files (trajectory, stderr) go through redact(): the Claude token and any GitHub-token-shaped string
- no GitHub or git credential: GH_CONFIG_DIR is a new empty folder, git reads no global or system config (so no
  credential helper such as osxkeychain), git and Git Credential Manager never prompt, and no GH_* / GITHUB_*
  variable passes, not even from skill_env
- the runner refuses a workspace whose parent folders hold CLAUDE.md, CLAUDE.local.md, AGENTS.md or .claude/
Fallback "keychain" mode (no token file) uses the user's login without a clean config dir. It is for
development only; results record which mode ran.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

# Bundled skills and commands that a plain `claude -p` lists. The probe re-checks that none is visible.
BUNDLED_SKILLS = [
    "batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "design", "design-sync",
    "doctor", "fewer-permission-prompts", "init", "keybindings-help", "loop", "plugin-authoring", "run",
    "run-skill-generator", "schedule", "security-review", "simplify", "update-config", "verify",
    "workflow-authoring",
]
ENV_KEEP = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR")   # USER: keychain needs it
GH_ENV_RE = re.compile(r"^(?:GH|GITHUB)_")
NO_GIT_CREDENTIALS = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
                      "GCM_INTERACTIVE": "never"}
TOKEN_FILE = Path(os.environ.get("SKILL_EVAL_TOKEN_FILE", Path.home() / ".config" / "skill-eval" / "oauth-token"))
INSTRUCTION_FILES = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude")
# Host credential stores a trial must never read (files and folders; deny rules cover both forms), including the gh and
# git config folders that the host's GH_CONFIG_DIR / XDG_CONFIG_HOME move elsewhere


def gh_config_dirs(env=os.environ) -> tuple[Path, ...]:
    dirs = [Path.home() / ".config/gh", *([Path(env["XDG_CONFIG_HOME"]) / "gh"] if env.get("XDG_CONFIG_HOME") else []),
            *([Path(env["GH_CONFIG_DIR"])] if env.get("GH_CONFIG_DIR") else [])]
    return tuple(dict.fromkeys(dirs))


def extra_deny(env=os.environ) -> tuple[Path, ...]:
    """SKILL_EVAL_DENY_EXTRA: this machine's other credential files or folders (os.pathsep-separated absolute paths,
    ~ expanded), e.g. a folder of test tokens. Denied like the default credential stores, and the probe reads them."""
    paths = [Path(os.path.expanduser(p)) for p in env.get("SKILL_EVAL_DENY_EXTRA", "").split(os.pathsep) if p]   # kept exactly
    rel = [str(p) for p in paths if not p.is_absolute()]
    if rel:
        raise ValueError(f"SKILL_EVAL_DENY_EXTRA takes absolute paths (or ~/...): {', '.join(rel)}")
    return tuple(dict.fromkeys(paths))


def credential_paths(env=os.environ) -> tuple[Path, ...]:
    git = [Path.home() / ".config/git/credentials", *([Path(env["XDG_CONFIG_HOME"]) / "git/credentials"] if env.get("XDG_CONFIG_HOME") else [])]
    # macOS login keychain: gh falls back to its keyring entry even with an empty GH_CONFIG_DIR (`gh auth token`
    # prints the host's token); the sandbox's read deny on the keychain files stops that lookup
    keychain = [Path.home() / "Library/Keychains"] if sys.platform == "darwin" else []
    return tuple(dict.fromkeys([*gh_config_dirs(env), Path.home() / ".git-credentials", *git, Path.home() / ".netrc", Path.home() / ".ssh",
                                *keychain, *(q for p in extra_deny(env) for q in (p, p.resolve()))]))   # also /private/var for /var


# GitHub token shapes. A trial or probe that printed one anyway must not leave it in a saved file. No \b before it:
# in a JSON line a token after a newline follows the "n" of "\n". After the prefix also "_", "." and "-": an app
# installation token can be ghs_<app id>_<JWT>.
GH_TOKEN_RE = re.compile(r"(?:gh[pousr]_[A-Za-z0-9_.-]{30,}|github_pat_[A-Za-z0-9_]{30,})")
# Keys that would change what a trial can see or do if an auto-synced file in the empty config dir carried them
# (remote-settings.json / policy-limits.json come from the account). Only key NAMES are ever recorded.
RISKY_KEYS = {"hooks", "permissions", "env", "plugins", "enabledPlugins", "extraKnownMarketplaces", "skills",
              "skillOverrides", "mcpServers", "enabledMcpjsonServers", "apiKeyHelper", "model", "sandbox",
              "disableAllHooks", "outputStyle", "statusLine", "autoMemoryEnabled", "additionalDirectories"}


def auth_mode() -> str:
    return "token" if TOKEN_FILE.is_file() and TOKEN_FILE.read_text().strip() else "keychain"


def token() -> str | None:
    return TOKEN_FILE.read_text().strip() if auth_mode() == "token" else None


def trial_settings(arm_skill: str | None, deny_dirs: list[Path], extra_off: list[str] = (), network: list[str] | None = None,
                   env=os.environ) -> dict:
    off = {s: "off" for s in [*BUNDLED_SKILLS, *extra_off] if s != arm_skill}
    paths = [*map(str, deny_dirs), str(Path.home() / ".claude"), str(TOKEN_FILE.parent), *map(str, credential_paths(env))]
    # "//abs/path" is an absolute path rule; "/**" covers a folder's contents, the bare form a single file
    deny = [f"{tool}(/{p}{tail})" for p in paths for tool in ("Read", "Edit") for tail in ("", "/**")]
    sandbox = {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False}
    if network:
        # the arm's hosts only (suite `network`): sandboxed commands reach them through the sandbox's own proxy, every other
        # host is denied, and strictAllowlist makes project/local settings unable to add any
        sandbox["network"] = {"allowedDomains": list(network), "strictAllowlist": True}
    return {
        "skillOverrides": off,                 # only the arm's skill is visible
        "disableAllHooks": True,               # no hooks from any settings source
        "autoMemoryEnabled": False,            # no memory from earlier sessions
        "sandbox": sandbox,
        # The given tools are allowed at the permission layer: in dontAsk mode, commands the permission checker cannot
        # auto-approve (`$B args`, `for … $(…)`, writing to $TMPDIR, Read of a file the agent wrote to $TMPDIR) were
        # denied and ended trials for reasons unrelated to the skill. Deny rules still win over allow; the sandbox stays
        # the boundary for Bash (denied paths unreadable, no writes outside the workspace, no network).
        "permissions": {"allow": ["Bash", "Read", "Grep", "Glob"], "deny": deny},   # deny: keys, rubrics, skill sources, token, ~/.claude
    }


def claude_cmd(prompt: str, *, model: str, settings: dict, tools: str, max_turns: int, max_usd: float,
               effort: str | None = None, output: str = "stream-json") -> list[str]:
    cmd = ["claude", "-p", prompt, "--output-format", output, "--no-session-persistence",
           "--setting-sources", "project",          # no user settings even if a config dir had any
           "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-chrome",
           "--settings", json.dumps(settings),
           "--tools", tools, "--permission-mode", "dontAsk",
           "--model", model, "--max-turns", str(max_turns), "--max-budget-usd", f"{max_usd:.2f}"]
    if output == "stream-json":
        cmd += ["--verbose", "--include-hook-events"]
    if effort:
        cmd += ["--effort", effort]
    return cmd


class TrialEnv:
    """Environment for one child process: allowlisted variables, a fresh config dir, the token if present, and no
    GitHub or git credential (a fresh empty GH_CONFIG_DIR, NO_GIT_CREDENTIALS, no GH_* / GITHUB_* variable)."""

    def __init__(self, extra: dict | None = None, config_dir: Path | None = None):
        self.extra = extra or {}
        self.fixture = config_dir                  # the probe's positive control passes a canary config dir
        self.dir: Path | None = None
        self.gh_dir: Path | None = None
        self.config_keys: dict[str, list[str]] = {}   # files Claude Code wrote into the config dir -> key names

    def __enter__(self) -> dict:
        env = {k: v for k, v in os.environ.items() if k in ENV_KEEP}
        env["DISABLE_AUTOUPDATER"] = "1"
        tok = token()
        if tok:
            self.dir = None if self.fixture else Path(tempfile.mkdtemp(prefix="skill-eval-cfg-"))
            env["CLAUDE_CONFIG_DIR"] = str(self.fixture or self.dir)
            env["CLAUDE_CODE_OAUTH_TOKEN"] = tok
        env.update(self.extra)
        env = {k: v for k, v in env.items() if not GH_ENV_RE.match(k)}   # extra (skill_env) may not add any either
        self.gh_dir = Path(tempfile.mkdtemp(prefix="skill-eval-gh-"))
        env.update(NO_GIT_CREDENTIALS, GH_CONFIG_DIR=str(self.gh_dir))    # last: extra cannot override them
        return env

    def __exit__(self, *exc):
        d = self.dir or self.fixture
        if d:
            self.config_keys = config_file_keys(d)
        if self.dir:
            shutil.rmtree(self.dir, ignore_errors=True)
        if self.gh_dir:
            shutil.rmtree(self.gh_dir, ignore_errors=True)


def config_file_keys(d: Path) -> dict[str, list[str]]:
    """Top-level key names of the JSON files in a config dir (never their values)."""
    out = {}
    for f in sorted(Path(d).glob("*.json")):
        try:
            data = json.loads(f.read_text())
        except (OSError, ValueError):
            out[f.name] = ["(unreadable)"]
            continue
        out[f.name] = sorted(data) if isinstance(data, dict) else [f"({type(data).__name__})"]
    return out


def risky_config_keys(keys: dict[str, list[str]]) -> dict[str, list[str]]:
    skip = {".claude.json"}                        # Claude Code's own state file (onboarding, caches), not settings
    return {f: sorted(RISKY_KEYS & set(k)) for f, k in keys.items() if f not in skip and RISKY_KEYS & set(k)}


def clean_env() -> dict[str, str]:
    """Allowlisted variables only (no token, no config dir). For host-side steps such as `prepare`."""
    env = {k: v for k, v in os.environ.items() if k in ENV_KEEP}
    env["DISABLE_AUTOUPDATER"] = "1"
    return env


def ancestor_instructions(ws: Path) -> list[str]:
    """Instruction files in the workspace's parent folders. Claude Code reads parents, so these must be empty."""
    found = []
    for parent in ws.resolve().parents:
        for name in INSTRUCTION_FILES:
            if (parent / name).exists() and not (parent == Path.home() and name == ".claude"):
                found.append(str(parent / name))
    return found


# Values an arm's `secret_env` passed to its trials (e.g. a database URL), and the password inside each URL. Registered
# by the runner before anything runs; redact() and scan_saved() cover them like the token. Never written anywhere.
_SECRETS: set[str] = set()


def register_secret(value: str) -> None:
    """Add a secret (and, for a URL, its password and every ?password=) to what redact() removes."""
    from urllib.parse import urlsplit, parse_qs, unquote
    parts = {value}
    try:
        u = urlsplit(value)
        if u.password:
            parts |= {u.password, unquote(u.password)}
        for pw in parse_qs(u.query).get("password", []):
            parts.add(pw)
    except ValueError:
        pass
    _SECRETS.update(p for p in parts if p and len(p) >= 8)


def redact(text: str, also=()) -> str:
    """Remove the token, registered secrets, any GitHub-token-shaped string and the token file's folder (in any
    spelling) from text that will be saved or shown. also: the token a child process was given (the file may have
    changed since). Each value also as a JSON string holds it (\\ and \" escaped, \\u or UTF-8), once or twice (a tool
    result that is itself JSON): the streams are JSON lines."""
    values = [(v, "[REDACTED-TOKEN]") for v in dict.fromkeys([*also, token()]) if v]
    values += [(sec, "[REDACTED-SECRET]") for sec in sorted(_SECRETS, key=len, reverse=True)]   # whole URL first
    for value, mark in values:                    # the longest spelling first: "a\\" before "a\" (valid JSON stays)
        forms = {value}
        for _ in range(2):
            forms |= {json.dumps(f, ensure_ascii=a)[1:-1] for f in forms for a in (True, False)}
        for form in sorted(forms, key=len, reverse=True):
            text = text.replace(form, mark)
    text = GH_TOKEN_RE.sub("[REDACTED-GITHUB-TOKEN]", text)
    folder = str(TOKEN_FILE.parent)
    home = str(Path.home())
    for form in {folder, os.path.realpath(folder), folder.replace(home, "~", 1), folder.replace(home, "$HOME", 1)}:
        text = text.replace(form, "[TOKEN-DIR]")
    return text


def scan_saved(out: Path) -> dict:
    """grep every saved file under `out` for the token; redact any hit in place. Returns counts, never the token."""
    tok, hits, sec_hits = token(), [], []
    needles = ([tok] if tok else []) + sorted(_SECRETS)
    if not needles:
        return {"token": "no token in use", "files_with_token": 0}
    for f in Path(out).rglob("*"):
        if f.is_file() and f.stat().st_size < 200_000_000:
            text = f.read_text(errors="replace")
            if tok and tok in text:
                hits.append(f.name)
            if any(s in text for s in _SECRETS):
                sec_hits.append(f.name)
            if (tok and tok in text) or any(s in text for s in _SECRETS):
                f.write_text(redact(text))
    r = {"token": "no token in use" if not tok else "absent" if not hits else "found and redacted", "files_with_token": len(hits)}
    if _SECRETS:
        r.update(secret_env="absent" if not sec_hits else "found and redacted", files_with_secret=len(sec_hits))
    return r
