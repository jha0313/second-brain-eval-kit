"""Trial isolation: what one `claude -p` trial can see, run and write.

A fresh folder is not a security boundary, so a trial gets several layers (probe-verified, `skill-eval probe`):
- a new, empty CLAUDE_CONFIG_DIR per trial -> no user skills, plugins, hooks, memory, CLAUDE.md, MCP
  (auth: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, read from a 0600 file, given only to the child)
- --setting-sources project, --strict-mcp-config with an empty config, --no-chrome
- run settings: bundled skills off, disableAllHooks, auto-memory off, sandbox on, Read/Edit deny rules for
  answer keys, rubrics, skill sources, the token file and ~/.claude
- an env allowlist: the child does not inherit this session's CLAUDE_CODE_* variables
- the runner refuses a workspace whose parent folders hold CLAUDE.md, CLAUDE.local.md, AGENTS.md or .claude/
Fallback "keychain" mode (no token file) uses the user's login without a clean config dir. It is for
development only; results record which mode ran.
"""
from __future__ import annotations

import json
import os
import shutil
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
TOKEN_FILE = Path(os.environ.get("SKILL_EVAL_TOKEN_FILE", Path.home() / ".config" / "skill-eval" / "oauth-token"))
INSTRUCTION_FILES = ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude")
# Keys that would change what a trial can see or do if an auto-synced file in the empty config dir carried them
# (remote-settings.json / policy-limits.json come from the account). Only key NAMES are ever recorded.
RISKY_KEYS = {"hooks", "permissions", "env", "plugins", "enabledPlugins", "extraKnownMarketplaces", "skills",
              "skillOverrides", "mcpServers", "enabledMcpjsonServers", "apiKeyHelper", "model", "sandbox",
              "disableAllHooks", "outputStyle", "statusLine", "autoMemoryEnabled", "additionalDirectories"}


def auth_mode() -> str:
    return "token" if TOKEN_FILE.is_file() and TOKEN_FILE.read_text().strip() else "keychain"


def token() -> str | None:
    return TOKEN_FILE.read_text().strip() if auth_mode() == "token" else None


def trial_settings(arm_skill: str | None, deny_dirs: list[Path], extra_off: list[str] = ()) -> dict:
    off = {s: "off" for s in [*BUNDLED_SKILLS, *extra_off] if s != arm_skill}
    paths = [*map(str, deny_dirs), str(Path.home() / ".claude"), str(TOKEN_FILE.parent)]
    deny = [f"{tool}(/{p}/**)" for p in paths for tool in ("Read", "Edit")]
    return {
        "skillOverrides": off,                 # only the arm's skill is visible
        "disableAllHooks": True,               # no hooks from any settings source
        "autoMemoryEnabled": False,            # no memory from earlier sessions
        "sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False},
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
    """Environment for one child process: allowlisted variables, a fresh config dir, the token if present."""

    def __init__(self, extra: dict | None = None, config_dir: Path | None = None):
        self.extra = extra or {}
        self.fixture = config_dir                  # the probe's positive control passes a canary config dir
        self.dir: Path | None = None
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
        return env

    def __exit__(self, *exc):
        d = self.dir or self.fixture
        if d:
            self.config_keys = config_file_keys(d)
        if self.dir:
            shutil.rmtree(self.dir, ignore_errors=True)


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


def redact(text: str) -> str:
    """Remove the token and the token file's folder (in any spelling) from text that will be saved or shown."""
    tok = token()
    if tok:
        text = text.replace(tok, "[REDACTED-TOKEN]")
    folder = str(TOKEN_FILE.parent)
    home = str(Path.home())
    for form in {folder, os.path.realpath(folder), folder.replace(home, "~", 1), folder.replace(home, "$HOME", 1)}:
        text = text.replace(form, "[TOKEN-DIR]")
    return text


def scan_saved(out: Path) -> dict:
    """grep every saved file under `out` for the token; redact any hit in place. Returns counts, never the token."""
    tok, hits = token(), []
    if not tok:
        return {"token": "no token in use", "files_with_token": 0}
    for f in Path(out).rglob("*"):
        if f.is_file() and f.stat().st_size < 200_000_000:
            text = f.read_text(errors="replace")
            if tok in text:
                hits.append(f.name)
                f.write_text(redact(text))
    return {"token": "absent" if not hits else "found and redacted", "files_with_token": len(hits)}
