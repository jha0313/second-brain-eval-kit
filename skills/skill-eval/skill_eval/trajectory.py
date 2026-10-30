"""Parse a `claude -p --output-format stream-json` transcript into one trajectory record."""
from __future__ import annotations

import json
from pathlib import Path


def parse_stream(path: Path) -> dict:
    init, result = None, None
    calls: dict[str, dict] = {}
    order: list[str] = []
    texts: list[str] = []
    hook_events = 0
    max_tokens_stops = 0
    for line in path.read_text(errors="replace").splitlines():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = ev.get("type")
        if t == "system":
            sub = ev.get("subtype", "")
            if sub == "init":
                init = ev
            elif sub.startswith("hook"):
                hook_events += 1
        elif t == "assistant":
            max_tokens_stops += ev.get("message", {}).get("stop_reason") == "max_tokens"
            for c in ev.get("message", {}).get("content", []):
                if c.get("type") == "tool_use":
                    calls[c["id"]] = {"name": c["name"], "input": c.get("input", {}), "is_error": None, "output": ""}
                    order.append(c["id"])
                elif c.get("type") == "text":
                    texts.append(c.get("text", ""))
        elif t == "user":
            content = ev.get("message", {}).get("content", [])
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in calls:
                    out = c.get("content")
                    if isinstance(out, list):
                        out = "\n".join(x.get("text", "") for x in out if isinstance(x, dict))
                    calls[c["tool_use_id"]]["is_error"] = bool(c.get("is_error"))
                    calls[c["tool_use_id"]]["output"] = str(out or "")[:2000]
        elif t == "result":
            result = ev
    tool_calls = [calls[i] for i in order]
    usage = (result or {}).get("usage") or {}
    tokens = {
        "input": usage.get("input_tokens", 0),
        "cache_write": usage.get("cache_creation_input_tokens", 0),
        "cache_read": usage.get("cache_read_input_tokens", 0),
        "output": usage.get("output_tokens", 0),
    }
    return {
        "model": (init or {}).get("model"),
        "claude_code_version": (init or {}).get("claude_code_version"),
        "visible": {
            "skills": (init or {}).get("skills"),
            "mcp_servers": [m.get("name") for m in (init or {}).get("mcp_servers", [])],
            "plugins": [p.get("name") for p in (init or {}).get("plugins", [])],
            "memory_paths": (init or {}).get("memory_paths"),
        },
        "hook_events": hook_events,
        "tool_calls": tool_calls,
        "skills_loaded": [skill_name(c["input"]) for c in tool_calls if c["name"] == "Skill"],
        "final": (result or {}).get("result") if result and not result.get("is_error") else (texts[-1] if texts else ""),
        "result_subtype": (result or {}).get("subtype"),
        "terminal_reason": (result or {}).get("terminal_reason"),
        "is_error": bool((result or {}).get("is_error")) if result else True,
        "error_text": str((result or {}).get("result") or "") if (result or {}).get("is_error") else "",
        "num_turns": (result or {}).get("num_turns", 0),
        "duration_ms": (result or {}).get("duration_ms", 0),
        "cost_usd": float((result or {}).get("total_cost_usd") or 0.0),
        "tokens": tokens,
        "has_result": result is not None,
        "permission_denials": len((result or {}).get("permission_denials") or []),
        "permission_denied_tools": [d.get("tool_name") for d in (result or {}).get("permission_denials") or []],
        "stop_reason": (result or {}).get("stop_reason"),
        "max_tokens_stops": max_tokens_stops,
        "models_used": sorted((result or {}).get("modelUsage") or {}),
        "tokens_by_model": model_tokens((result or {}).get("modelUsage")),
    }


def skill_name(inp: dict) -> str:
    name = inp.get("skill") or inp.get("command") or inp.get("name") or ""
    return str(name).lstrip("/").split(":")[-1]


def model_tokens(model_usage: dict | None) -> dict:
    """Per-model token counts from the result event's modelUsage (main model plus Claude Code's helper calls)."""
    return {m: {"input": u.get("inputTokens", 0), "cache_write": u.get("cacheCreationInputTokens", 0),
                "cache_read": u.get("cacheReadInputTokens", 0), "output": u.get("outputTokens", 0)}
            for m, u in (model_usage or {}).items()}
