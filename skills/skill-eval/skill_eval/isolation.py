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
import secrets
import shutil
import stat
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


def token_file(env=os.environ) -> Path:
    """The token file, absolute against the launcher's cwd: auth reads it there, and the deny rules and the probe must
    name that same file (trials run in another folder, where a relative path is another file or none)."""
    return Path(env.get("SKILL_EVAL_TOKEN_FILE", Path.home() / ".config" / "skill-eval" / "oauth-token")).expanduser().absolute()


TOKEN_FILE = token_file()
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
    paths = [*map(str, deny_dirs), str(Path.home() / ".claude"), str(TOKEN_FILE.parent), *map(str, credential_paths(env)),
             *map(str, shared_tmp())]           # other sessions' scratchpads (the trial's own $TMPDIR is its root)
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


# Claude Code's per-uid temp folder (/tmp/claude-<uid>) is shared by every session of this user: their scratchpads and
# task outputs, maybe eval cases or answer-key drafts. A trial must not read it, so it is denied. But the sandboxed
# shell's $TMPDIR (and Claude Code's cwd files) live there, so each child first gets a short private root:
# CLAUDE_CODE_TMPDIR=<root> moves both to <root>/claude-<uid>. Observed in Claude Code 2.1.329: it does this only
# when <root>/claude-<uid> is at most 44 bytes; else $TMPDIR stays in the shared folder (the probe then FAILs).
TMPDIR_MAX = 44


def shared_tmp() -> tuple[Path, ...]:
    """Claude Code's shared per-uid temp folder in both spellings: /tmp/claude-<uid> and, on macOS, /private/tmp/...
    Only /tmp is resolved: a claude-<uid> that is a symlink is not followed (the probe refuses it)."""
    p = Path(f"/tmp/claude-{os.getuid()}")
    return tuple(dict.fromkeys([p, Path(os.path.realpath("/tmp")) / p.name]))


def check_shared_tmp() -> Path:
    """The shared folder in its /tmp-resolved spelling, made if absent. A symlink, another owner or write access for
    others stops skill-eval before it resolves, writes or removes any path: an output folder under a symlinked
    /tmp/claude-<uid> would land in the link's target, and the probe plants a fake session's folder there."""
    shared = shared_tmp()[-1]
    try:
        shared.mkdir(mode=0o700, exist_ok=True)
        st = shared.lstat()
    except OSError as e:                          # e.g. a symlink to nowhere
        raise RuntimeError(f"{shared} (Claude Code's temp folder): {e}") from e
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise RuntimeError(f"{shared} is not a folder of this user (Claude Code's temp folder) or others can write it: "
                           "fix it and run again")
    return shared


def cwd_slug(p) -> str:
    """The name Claude Code gives a session's cwd in its temp folder (observed in 2.1.329): the real path with each
    character that is not a letter or a digit as "-"."""
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(p))


def root_layouts(tmp: str, uid: int) -> list[tuple[Path, int]]:
    """Where the private roots can go, each with the length of a root's random name that keeps <root>/claude-<uid>
    within TMPDIR_MAX bytes (as long as there is room for, at least 8 and at most 16 hex): <tmp>/sk-<uid>, or for a
    long uid <tmp>/sk, sk0, sk1, ... in that order (another long-uid user may have the first ones)."""
    own = TMPDIR_MAX - len(f"{tmp}/sk-{uid}//claude-{uid}".encode())
    if own >= 8:
        return [(Path(tmp) / f"sk-{uid}", min(own, 16))]
    out = [(Path(tmp) / name, min(room, 16)) for name in ("sk", *(f"sk{i}" for i in range(100)))
           if (room := TMPDIR_MAX - len(f"{tmp}/{name}//claude-{uid}".encode())) >= 8]
    if not out:
        raise RuntimeError(f"{tmp}/sk/<name>/claude-{uid} cannot fit in {TMPDIR_MAX} bytes: Claude Code would keep the "
                           "trial's $TMPDIR in the shared folder")
    return out


def private_root() -> Path:
    """A new folder for one child process (its CLAUDE_CODE_TMPDIR, config and gh dirs; a judge's cwd too). Its parent
    has mode 0300: nobody lists it, so a trial cannot find another trial's root (the same design as the workspaces)."""
    uid = os.getuid()
    layouts = root_layouts(os.path.realpath("/tmp"), uid)
    for parent, n in layouts:                     # one made now, or one an earlier call made (this uid, 0300)
        try:
            parent.mkdir(mode=0o300)
            os.chmod(parent, 0o300)               # the umask may have taken bits
        except FileExistsError:
            pass
        st = parent.lstat()
        if stat.S_ISDIR(st.st_mode) and st.st_uid == uid and st.st_mode & 0o777 == 0o300:
            break
    else:
        raise RuntimeError(f"{layouts[0][0]} is not this user's 0300 folder for trial temp roots: remove it and run again")
    root = parent / secrets.token_hex(8)[:n]
    root.mkdir(mode=0o700)
    found = ancestor_instructions(root / "cwd")    # a judge runs in a root: Claude Code would read these
    if found:
        root.rmdir()
        raise RuntimeError(f"instruction files above the trial temp folders would be read by every judge: {found}")
    return root


def harness_dir(prefix: str) -> Path:
    """A new folder for the harness's own files (workspaces, probe fixtures), never inside the shared Claude Code
    folder that trials cannot read ($TMPDIR is in it when skill-eval runs from a sandboxed Claude Code shell)."""
    base = Path(os.path.realpath(tempfile.gettempdir()))
    if any(base.is_relative_to(s) for s in shared_tmp()):
        base = Path(os.path.realpath("/tmp"))
    return Path(tempfile.mkdtemp(prefix=prefix, dir=base))


class TrialEnv:
    """Environment for one child process: allowlisted variables, a fresh config dir, the token if present, and no
    GitHub or git credential (a fresh empty GH_CONFIG_DIR, NO_GIT_CREDENTIALS, no GH_* / GITHUB_* variable)."""

    def __init__(self, extra: dict | None = None, config_dir: Path | None = None):
        self.extra = extra or {}
        self.fixture = config_dir                  # the probe's positive control passes a canary config dir
        self.dir: Path | None = None
        self.gh_dir: Path | None = None
        self.root: Path | None = None              # CLAUDE_CODE_TMPDIR: the child's own temp folder, removed on exit
        self.config_keys: dict[str, list[str]] = {}   # files Claude Code wrote into the config dir -> key names

    def __enter__(self) -> dict:
        env = {k: v for k, v in os.environ.items() if k in ENV_KEEP}
        env["DISABLE_AUTOUPDATER"] = "1"
        self.root = private_root()
        try:
            tok = token()
            if tok:
                self.dir = None if self.fixture else Path(tempfile.mkdtemp(prefix="cfg-", dir=self.root))
                env["CLAUDE_CONFIG_DIR"] = str(self.fixture or self.dir)
                env["CLAUDE_CODE_OAUTH_TOKEN"] = tok
            env.update(self.extra)
            env = {k: v for k, v in env.items() if not GH_ENV_RE.match(k)}   # extra (skill_env) may not add any either
            self.gh_dir = Path(tempfile.mkdtemp(prefix="gh-", dir=self.root))
            # last: extra cannot override them
            env.update(NO_GIT_CREDENTIALS, GH_CONFIG_DIR=str(self.gh_dir), CLAUDE_CODE_TMPDIR=str(self.root))
            return env
        except BaseException:                      # no __exit__ follows a failed __enter__
            self._remove_root()
            raise

    def __exit__(self, *exc):
        try:
            d = self.dir or self.fixture
            if d:
                self.config_keys = config_file_keys(d)
        finally:
            self._remove_root()

    def _remove_root(self):
        if self.root:                              # the config and gh dirs are in it too
            shutil.rmtree(self.root, ignore_errors=True)
            if self.root.exists():
                print(f"warning: could not remove {self.root} (a trial's temp files)", file=sys.stderr)


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
