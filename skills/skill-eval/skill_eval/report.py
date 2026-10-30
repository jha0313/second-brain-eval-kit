"""Reports: terminal table and a single-file scorecard.html (no external assets)."""
from __future__ import annotations

import html
import json
import os
import sys
from pathlib import Path

ARM_LABEL = {"none": "none · 스킬 없음", "v1": "v1 · 원본", "v2": "v2 · cleanup", "v1b": "v1b · A/A 복사본"}


def _f(x, fmt="{:.2f}", dash="–"):
    return dash if x is None else fmt.format(x)


SCORED = ("pass", "fail", "limit", "safety_violation")
KIND_TITLE = {"find-all": "find-all · 전부 찾기", "why": "why · 왜 이렇게 만들었나", "small": "작은 대조군 · 스킬을 안 불러야 맞음",
              "other": "기타"}


def _dots(trials):
    return "".join("●" if t["passed"] else ("○" if t["outcome"] in SCORED else "◌") for t in trials)


def efficiency(agg, a, b) -> str:
    """Same answers can still cost less: time, tokens, tool calls and $ from arm a to arm b."""
    parts = []
    for key, label, fmt in (("mean_seconds", "time", "{:.0f}s"), ("mean_tokens", "tokens", "{:,.0f}"),
                            ("mean_tool_calls", "calls", "{:.1f}"), ("mean_usd", "$", "{:.2f}")):
        x, y = agg["arms"][a].get(key), agg["arms"][b].get(key)
        if x and y is not None:
            parts.append(f"{label} {fmt.format(x)}→{fmt.format(y)} ({(y - x) / x:+.0%})")
    return " · ".join(parts)


def _by_kind(m) -> list[tuple[str, list[str]]]:
    order = ["find-all", "why", "other", "small"]
    kinds = {}
    for cid, c in m["cases"].items():
        kinds.setdefault(c["kind"], []).append(cid)
    return [(k, kinds[k]) for k in order if k in kinds]


def _ci(c) -> str:
    return f"[{c['ci95'][0]:+.2f}, {c['ci95'][1]:+.2f}]" if c["ci95"] else "[CI 없음]"


def failure_causes(trials: list[dict], arms: list[str]) -> list[tuple[str, dict[str, int]]]:
    """Why trials did not pass, one cause per trial (the first failed gate, its cites_exist labels, the rubric items,
    or the exclusion), counted per arm and sorted by total. Two extra rows, not causes: trials with a permission
    denial, and trials whose judge votes disagreed on some item (e.g. 2:1)."""
    rows: dict[str, dict[str, int]] = {}

    def add(cause, arm):
        rows.setdefault(cause, {a: 0 for a in arms})
        rows[cause][arm] = rows[cause].get(arm, 0) + 1

    for t in trials:
        o = t["outcome"]
        if o == "pass":
            continue
        h = next((h for h in t.get("hard") or [] if h.get("gate") and h.get("ok") is False), None)
        if o not in SCORED:
            cause = f"제외 · {o}"
        elif o == "limit":
            cause = "limit · 턴·시간·$ 한도"
        elif h:
            cause = h["check"] + (f" · {', '.join(sorted(h['missing_kinds']))}" if h.get("missing_kinds") else "")
        elif t.get("rubric"):
            cause = "judge · " + ", ".join(i for i, v in t["rubric"].items() if v != "PASS")
        else:
            cause = o
        add(cause, t["arm"])
    out = sorted(rows.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))
    denied = {a: sum(bool(t.get("permission_denied")) for t in trials if t["arm"] == a) for a in arms}
    split = {a: sum(_split(t) for t in trials if t["arm"] == a) for a in arms}
    return out + [(r, v) for r, v in (("(권한 거부가 있던 trial)", denied), ("(judge 표가 갈린 trial)", split)) if any(v.values())]


def _split(t) -> bool:
    votes = [v for v in t.get("votes") or [] if not v.get("grader_error")]
    seen: dict[str, set] = {}
    for v in votes:
        for i in v.get("items", []):
            seen.setdefault(i["id"], set()).add(i["verdict"])
    return any(len(x) > 1 for x in seen.values())


def _mde_text(c) -> str:
    if not c.get("mde_80"):
        return ""
    need = c.get("families_for_delta_0_05")
    return (f"이 크기로 80% 확률로 검출하는 차이 ≈ ±{c['mde_80']:.2f}(어림값)"
            + (f" · Δ 0.05를 잡으려면 가족 약 {need}개" if need and need > c["families"] else ""))


def _comp_line(c) -> str:
    return (f"Δ {c['control']:>4}→{c['treatment']:<3} {c['subset']:<8} {c['delta']:+.2f}  탐색적 95% CI {_ci(c):<16} "
            f"({c['cases']} cases / {c['families']} families)  {c['verdict']}")


# ---- terminal -------------------------------------------------------------------

def _short_verdict(c) -> str:
    v = c["verdict"]
    return "개선 쪽 차이" if v.startswith("개선") else "하락 쪽 차이" if v.startswith("하락") else v


def _kind_cell(agg, ids, arm) -> str:
    ts = [t for cid in ids for t in agg["cells"][f"{cid}|{arm}"]["trials"] if t["outcome"] in SCORED]
    if not ts:
        return "–"
    p = sum(bool(t["passed"]) for t in ts)
    return f"{p / len(ts):.0%} {p}/{len(ts)}"


def terminal(data: dict, color: bool = False, per_case: bool = False) -> str:
    """Screen version fits 100 columns and about 24 lines; per_case=True adds the case x arm grid (summary.txt)."""
    m, agg = data["meta"], data["aggregate"]
    arms = list(m["arms"])
    paint = (lambda s, code: f"\033[{code}m{s}\033[0m") if color else (lambda s, code: s)  # noqa: E731
    model = ", ".join(m.get("models_seen") or []) or m["model"]
    judges = ", ".join(m.get("judge_models_seen") or []) or m["judge_model"]
    lines = [paint(f"skill-eval · {m['repo']} @{m['commit'][:8]} · agent {model} · judge {judges}×{m['votes']} · k={m['k']}", "1")]
    lines += [""] if per_case else []                      # the screen version keeps to 24 lines
    lines.append(f"{'':<15}" + "".join(f"{a:<14}" for a in arms) + "pass rate · passed/trials")
    names = {"find-all": "find-all", "why": "why", "small": "control", "other": "other"}
    for kind, ids in _by_kind(m):
        lines.append(f"{names.get(kind, kind):<9}{'(' + str(len(ids)) + ')':>5} " + "".join(f"{_kind_cell(agg, ids, a):<14}" for a in arms))
    if per_case:
        w = max(8, max(len(c) for c in m["cases"]) + 2)
        lines += ["", f"  {'case':<{w}}" + "".join(f"{a:<17}" for a in arms) + "  (score · ● pass ○ fail ◌ excluded · r recall)"]
        for kind, ids in _by_kind(m):
            lines.append(f"{KIND_TITLE.get(kind, kind)} ({len(ids)})")
            for cid in ids:
                row = f"  {cid:<{w}}"
                for a in arms:
                    c = agg["cells"][f"{cid}|{a}"]
                    cell = f"{_f(c['mean_score'])} {_dots(c['trials'])}" + (f" r{c['recall']:.2f}" if c["recall"] is not None else "")
                    row += f"{cell:<17}"
                lines.append(row)
    lines += ["", f"{'arm':<5} {'pass':>5} {'recall':>6} {'prec':>5} {'exact':>6} {'pass^k':>6} {'route':>6} "
                  f"{'sec all/ok':>11} {'tokens':>8} {'$/trial':>8} {'calls':>5}"]
    for a in arms:
        s = agg["arms"][a]
        lines.append(f"{a:<5} {_f(s['pass_rate'], '{:.0%}'):>5} {_f(s['mean_recall']):>6} {_f(s['mean_precision']):>5} "
                     f"{_f(s.get('exact_rate'), '{:.0%}'):>6} {_f(s['pass_hat_k']):>6} {_f(s.get('routing_accuracy'), '{:.0%}'):>6} "
                     f"{_f(s['mean_seconds'], '{:.0f}') + '/' + _f(s.get('mean_seconds_passed'), '{:.0f}'):>11} "
                     f"{_f(s['mean_tokens'], '{:,.0f}'):>8} {_f(s['mean_usd'], '${:.2f}'):>8} {_f(s['mean_tool_calls'], '{:.1f}'):>5}")
    lines.append("")
    primary = {("v1", "v2"): "find-all"}                   # pre-registered in v2-edit-plan.md
    pairs = list(dict.fromkeys((c["control"], c["treatment"]) for c in agg["comparisons"]))
    for c in agg["comparisons"]:
        later = pairs.index((c["control"], c["treatment"])) >= 2      # e.g. A/A: the screen shows only its "all" row
        if not per_case and (c["subset"] == "small" or (later and c["subset"] != "all")):
            continue
        code = "2" if not c["ci95"] else ("32" if c["ci95"][0] > 0 else ("31" if c["ci95"][1] < 0 else "2"))
        tag = "*" if primary.get((c["control"], c["treatment"])) == c["subset"] else " "
        ci = f"[{c['ci95'][0]:+.2f},{c['ci95'][1]:+.2f}]" if c["ci95"] else "[no CI]"
        lines.append(paint(f"Δ{tag}{c['control']:>4}→{c['treatment']:<4} {c['subset']:<8} {c['delta']:+.2f} {ci:<15} "
                           f"{c['families']:>2} fam  {_short_verdict(c)}", code))
    mdes = [c for c in agg["comparisons"] if c["subset"] == "all" and c.get("mde_80")]
    if mdes:
        lines.append("  검출력(어림값, 80%): " + " · ".join(f"{c['control']}→{c['treatment']} ±{c['mde_80']:.2f}" for c in mdes)
                     + " — 이보다 작은 차이는 이 케이스 수로 보기 어렵다")
    sens = agg.get("sensitivity")
    if sens and sens["comparisons"]:
        lines.append(f"  민감도({'·'.join(sens['exclude'])} 제외): " + " · ".join(
            f"{c['control']}→{c['treatment']}{' ' + c['subset'] if c['subset'] != 'all' else ''} {c['delta']:+.2f}"
            for c in _sens_rows(sens, primary)))
    if any(c["control"] == "none" for c in agg["comparisons"]):
        b = next(c["treatment"] for c in agg["comparisons"] if c["control"] == "none")
        x, y = agg["arms"]["none"], agg["arms"][b]
        parts = [f"{lbl} {fmt(x[k])}→{fmt(y[k])} ({(y[k] - x[k]) / x[k]:+.0%})" for k, lbl, fmt in (
            ("mean_seconds", "time", lambda v: f"{v:.0f}s"), ("mean_tokens", "tokens", lambda v: f"{v / 1000:.0f}k"),
            ("mean_usd", "$", lambda v: f"{v:.2f}"), ("mean_tool_calls", "calls", lambda v: f"{v:.1f}")) if x.get(k) and y.get(k) is not None]
        lines.append(f"  none→{b}: " + " · ".join(parts))
    idx, cnt = m.get("index") or {}, m["counts"]
    exc = ", ".join(f"{k} {v}" for k, v in cnt["excluded"].items() if v) or "0"
    vault = next((v["meta"]["vault"] for v in (idx.get("files") or {}).values() if "vault" in v.get("meta", {})), "n/a")
    lines.append((f"index {idx['seconds']:.0f}s, vault {'none' if vault is None else vault} · " if idx.get("files") else "")
                 + f"${m['spent_usd']:.2f} · {cnt['scored']}/{cnt['expected']} scored · excluded {exc} · "
                 + f"cut-off {m.get('truncated_output', 0)} · denied {len(m.get('permission_denied_trials') or [])} · "
                 + f"isolation {'OK' if m['isolation']['all_ok'] else 'BROKEN'}")
    lines.append("* = pre-registered primary metric · CI = exploratory paired bootstrap over case families")
    if per_case:
        causes = failure_causes(data["trials"], arms)
        if causes:
            w = max(len(c) for c, _ in causes) + 2
            lines += ["", f"failure causes (trials) {'':<{max(0, w - 24)}}" + "".join(f"{a:>7}" for a in arms)]
            lines += [f"  {c:<{w - 2}}" + "".join(f"{v.get(a, 0):>7}" for a in arms) for c, v in causes]
    if m.get("stopped"):
        lines.append(paint(f"! run stopped early: {m['stopped']}", "31"))
    for key, label in (("models_seen", "agent models"), ("claude_code_versions_seen", "Claude Code versions")):
        if len(m.get(key) or []) > 1:
            lines.append(paint(f"! {label} differ across trials: {', '.join(m[key])}", "33"))
    return "\n".join(lines)


# ---- html -------------------------------------------------------------------------

CSS = """
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--heat-l:78%;--heat-fg:#111;
--none:#8a8a8f;--v1:#2f6fdf;--v2:#d9771f;--v1b:#7a5cc7;--bad:#c93a3a;--good:#2a8a4a}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#141416;--card:#1d1d20;--fg:#ececef;--muted:#9a9aa2;--line:#2e2e33;
--heat-l:32%;--heat-fg:#f4f4f6;--none:#9a9aa2;--v1:#6f9cff;--v2:#ffa14d;--v1b:#b39cff;--bad:#ff7a7a;--good:#5fd38a}}
:root[data-theme=dark]{--bg:#141416;--card:#1d1d20;--fg:#ececef;--muted:#9a9aa2;--line:#2e2e33;
--heat-l:32%;--heat-fg:#f4f4f6;--none:#9a9aa2;--v1:#6f9cff;--v2:#ffa14d;--v1b:#b39cff;--bad:#ff7a7a;--good:#5fd38a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo","Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:34px 0 12px}
.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.q{font-size:13px;color:var(--muted)}.big{font-size:30px;font-weight:700;letter-spacing:-.5px}.sub{font-size:13px;color:var(--muted)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:13.5px;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12.5px}td.num{text-align:right;font-variant-numeric:tabular-nums}
.arm{display:inline-block;white-space:nowrap;padding:1px 8px;border-radius:99px;color:#fff;font-size:12px;font-weight:600}
.arm-none{background:var(--none)}.arm-v1{background:var(--v1)}.arm-v2{background:var(--v2)}.arm-v1b{background:var(--v1b)}
.heat td.cell{text-align:center;color:var(--heat-fg);font-variant-numeric:tabular-nums;min-width:130px}
.heat .s{font-size:18px;font-weight:700}.heat .d{letter-spacing:2px;font-size:13px}.heat .r{font-size:12px;opacity:.85}
.kind{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--line);color:var(--muted);margin-left:6px}
.ok{color:var(--good);font-weight:600}.no{color:var(--bad);font-weight:600}.na{color:var(--muted)}
.fail{margin:10px 0;padding:12px 14px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--bad);border-radius:10px}
.fail blockquote{margin:8px 0 0;padding:8px 10px;border-left:3px solid var(--line);color:var(--muted);white-space:pre-wrap;font-size:13px;max-height:180px;overflow:auto}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.scroll{overflow-x:auto}.legend{font-size:12.5px;color:var(--muted);margin-top:6px}
details summary{cursor:pointer;color:var(--muted);font-size:13px}
"""


def _e(x):
    return html.escape(str(x))


def _heat_style(score):
    if score is None:
        return "background:transparent"
    return f"background:hsl({int(score * 125)} 62% var(--heat-l))"


def _arm(a):
    return f'<span class="arm arm-{_e(a)}">{_e(ARM_LABEL.get(a, a))}</span>'


def _ci_svg(comp):
    lo, hi, d = *(comp["ci95"] or (comp["delta"], comp["delta"])), comp["delta"]
    x = lambda v: 10 + (max(-1, min(1, v)) + 1) / 2 * 280  # noqa: E731
    color = "var(--good)" if lo > 0 else ("var(--bad)" if hi < 0 else "var(--muted)")
    return (f'<svg viewBox="0 0 300 34" width="100%" height="34" role="img" aria-label="delta {d:+.2f}">'
            f'<line x1="{x(0)}" y1="4" x2="{x(0)}" y2="30" stroke="var(--line)" stroke-width="2"/>'
            f'<line x1="{x(lo)}" y1="17" x2="{x(hi)}" y2="17" stroke="{color}" stroke-width="4" stroke-linecap="round"/>'
            f'<circle cx="{x(d)}" cy="17" r="7" fill="{color}"/>'
            f'<text x="10" y="32" font-size="9" fill="var(--muted)">-1</text><text x="282" y="32" font-size="9" fill="var(--muted)">+1</text></svg>')


LIMITS = [
    "케이스 수와 반복 수(k)가 작다. CI는 케이스 가족(같은 질문의 변형은 하나로 묶음)을 다시 뽑은 percentile bootstrap이며 탐색적이다.",
    "judge는 같은 모델의 3표다. 표본 잡음을 줄일 뿐 독립 평가자 3명이 아니다. rubric 케이스(why)에만 쓰이고, find-all·대조군은 코드로만 채점한다.",
    "에이전트는 Bash 도구 설명에서 접근 금지 경로 목록을 볼 수 있어 평가 중임을 알 수 있다. 모든 arm에서 같다.",
    "sandbox는 Claude Code 내장(macOS seatbelt)이다. VM 같은 보안 경계가 아니다.",
    "$는 Claude Code가 trial마다 보고한 정가 기준 사용량이다. 구독 로그인이면 청구액이 아니다.",
    "인덱스 빌드 시간·비용은 trial 시간에 들어가지 않는다. 위 '실행 기록'에 따로 적었다.",
    "한 repo, 한 커밋, 한 agent 모델에서 잰 값이다. 다른 repo·모델로 일반화하지 않는다.",
]


def _sens_rows(sens, primary):
    """One row per pair: the pair's primary subset (find-all for v1→v2), else all."""
    rows = {}
    for c in sens["comparisons"]:
        pair = (c["control"], c["treatment"])
        if c["subset"] == primary.get(pair, "all"):
            rows[pair] = c
    return list(rows.values())


def _sensitivity(sens) -> str:
    if not sens or not sens["comparisons"]:
        return ""
    rows = "".join(f'<tr><td>{_arm(c["control"])} → {_arm(c["treatment"])}</td><td>{_e(c["subset"])}</td>'
                   f'<td class="num">{c["delta"]:+.2f}</td><td class="num">{_ci(c)}</td><td class="num">{c["cases"]}/{c["families"]}</td>'
                   f'<td>{_e(c["verdict"])}</td></tr>' for c in sens["comparisons"] if c["subset"] != "small")
    return (f'<h2>민감도 분석 · {_e("·".join(sens["exclude"]))} 제외</h2><div class="card sub">{_e(sens["reason"])} '
            f'주 결과는 사전 등록대로 위의 전체 케이스 값이다. 아래는 같은 비교에서 이 케이스들만 뺀 값이다.</div>'
            f'<div class="scroll"><table><tr><th>비교</th><th>범위</th><th>Δ</th><th>탐색적 95% CI</th><th>케이스/가족</th><th>판정</th></tr>'
            f'{rows}</table></div>')


def _comp_card(title, comps, agg):
    if not comps:
        return ""
    main = comps[0]
    rows = "".join(f'<div class="sub">{_e(c["subset"])}: Δ {c["delta"]:+.2f} {_ci(c)} · '
                   f'{c["families"]}가족 · {_e(c["verdict"])}</div>' for c in comps[1:])
    return (f'<div class="card"><div class="q">{_e(title)}</div><div class="big">Δ {main["delta"]:+.2f}</div>{_ci_svg(main)}'
            f'<div class="sub"><b>{_e(main["subset"])}</b> · {main["control_mean"]:.2f} → {main["treatment_mean"]:.2f} · 탐색적 95% CI '
            f'{_ci(main)} · {main["cases"]}케이스/{main["families"]}가족<br><b>{_e(main["verdict"])}</b>'
            + (f'<br>{_e(_mde_text(main))}' if _mde_text(main) else "") + '</div>'
            f'{rows}<div class="sub" style="margin-top:6px">{_e(efficiency(agg, main["control"], main["treatment"]))}</div></div>')


def _heat(m, agg, ids, arms):
    out = ['<div class="scroll"><table class="heat"><tr><th>케이스</th>' + "".join(f"<th>{_arm(a)}</th>" for a in arms) + "</tr>"]
    for cid in ids:
        out.append(f'<tr><td><span class="mono">{_e(cid)}</span><div class="sub">{_e(m["cases"][cid]["prompt"][:90])}…</div></td>')
        for a in arms:
            c = agg["cells"][f"{cid}|{a}"]
            rec = ""
            if c["recall"] is not None:
                rec = f'<div class="r">recall {c["recall"]:.2f}' + (f' · prec {c["precision"]:.2f}' if c["precision"] is not None else "")
                rec += (f' · exact {c["exact_rate"]:.0%}' if c.get("exact_rate") is not None else "") + "</div>"
            out.append(f'<td class="cell" style="{_heat_style(c["mean_score"])}"><div class="s">{_f(c["mean_score"])}</div>'
                       f'<div class="d" title="● pass ○ fail ◌ excluded">{_dots(c["trials"])}</div>{rec}</td>')
        out.append("</tr>")
    return "".join(out) + "</table></div>"


def scorecard(data: dict) -> str:
    m, agg, trials = data["meta"], data["aggregate"], data["trials"]
    arms = list(m["arms"])
    model = ", ".join(m.get("models_seen") or []) or m["model"]
    out = [f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
           f'<title>skill-eval scorecard</title><style>{CSS}</style>'
           '<script>var t=location.hash.slice(1);if(t==="light"||t==="dark")document.documentElement.dataset.theme=t</script>'
           '</head><body><main>',
           f'<h1>skill-eval scorecard · <span class="mono">{_e(m["skill"])}</span></h1>',
           f'<div class="meta">suite {_e(m["suite"])} · agent {_e(model)} · judge {_e(", ".join(m.get("judge_models_seen") or []) or m["judge_model"])}×{m["votes"]} '
           f'· {_e(m["repo"])} @ <span class="mono">{_e(m["commit"][:8])}</span> · k={m["k"]} · tools {_e(m.get("tools"))} · Claude Code '
           f'{_e(", ".join(m.get("claude_code_versions_seen") or []))} · {_e(m["finished"])}</div>']

    out.append('<h2>세 질문</h2><div class="grid">')
    rates = [f'{a} {agg["arms"][a]["routing_accuracy"]:.0%}' for a in arms if a != "none" and agg["arms"][a].get("routing_accuracy") is not None]
    loads = [f'{a} {agg["arms"][a]["skill_load_rate"]:.0%}' for a in arms if a != "none" and agg["arms"][a]["skill_load_rate"] is not None]
    out.append(f'<div class="card"><div class="q">불리나? (routing · 진단용, 점수에 안 들어감)</div><div class="big">{_e(" · ".join(rates) or "–")}</div>'
               f'<div class="sub">불려야 할 때 불리고 작은 대조군에서는 안 불린 비율. 불려야 할 때 로드율 {_e(" · ".join(loads) or "–")}</div></div>')
    titles = {("none", "v1"): "도움이 되나? (uplift)", ("v1", "v2"): "이 수정이 망가뜨렸나? (regression · 1차 지표 find-all)",
              ("v1", "v1b"): "같은 스킬끼리도 얼마나 흔들리나? (A/A · v1b = v1과 같은 바이트)"}
    pairs = list(dict.fromkeys((c["control"], c["treatment"]) for c in agg["comparisons"]))
    for a, b in pairs:
        comps = [c for c in agg["comparisons"] if (c["control"], c["treatment"]) == (a, b)]
        if (a, b) == ("v1", "v2"):              # pre-registered primary metric first (v2-edit-plan.md)
            comps.sort(key=lambda c: c["subset"] != "find-all")
        out.append(_comp_card(titles.get((a, b), f"{a} vs {b}" + (" (A/A: 차이가 없어야 정상)" if "aa" in b.lower() or b.endswith("b") else "")), comps, agg))
    out.append('</div>')
    out.append(_sensitivity(agg.get("sensitivity")))

    out.append('<h2>arm 요약</h2><div class="scroll"><table><tr><th>arm</th><th>pass</th><th>평균 점수</th><th>exact set</th><th>pass^k</th>'
               '<th>recall</th><th>precision</th><th>routing</th><th>시간 전체/성공</th><th>tokens/trial</th><th>$/trial</th><th>tool calls</th>'
               '<th>한도 초과</th><th>안전 위반</th></tr>')
    for a in arms:
        s = agg["arms"][a]
        out.append(f'<tr><td>{_arm(a)}</td><td class="num">{_f(s["pass_rate"], "{:.0%}")}</td><td class="num">{_f(s["mean_score"])}</td>'
                   f'<td class="num">{_f(s.get("exact_rate"), "{:.0%}")}</td><td class="num">{_f(s["pass_hat_k"])}</td>'
                   f'<td class="num">{_f(s["mean_recall"])}</td><td class="num">{_f(s["mean_precision"])}</td>'
                   f'<td class="num">{_f(s.get("routing_accuracy"), "{:.0%}")}</td>'
                   f'<td class="num">{_f(s["mean_seconds"], "{:.0f}s")} / {_f(s.get("mean_seconds_passed"), "{:.0f}s")}</td>'
                   f'<td class="num">{_f(s["mean_tokens"], "{:,.0f}")}</td><td class="num">{_f(s["mean_usd"], "${:.2f}")}</td>'
                   f'<td class="num">{_f(s["mean_tool_calls"], "{:.1f}")}</td><td class="num">{s.get("limits_hit", 0)}</td>'
                   f'<td class="num">{s.get("safety_violations", 0)}</td></tr>')
    out.append('</table></div><div class="legend">find-all 통과 = recall·precision이 실행 전에 고정한 기준선 이상. exact set = 정답 목록과 '
               '하나도 안 빠지고 하나도 안 더한 비율(보조 지표). 시간은 채점된 trial 전체 평균 / 성공한 trial 평균.</div>')

    for kind, ids in _by_kind(m):
        out.append(f'<h2>{_e(KIND_TITLE.get(kind, kind))} ({len(ids)})</h2>' + _heat(m, agg, ids, arms))
    out.append('<div class="legend">칸 = trial 평균 점수(안전·정답 체크 실패 → 0). ● pass ○ fail ◌ 제외(infra·격리·정답 접근·예산)</div>')

    fa = [t for t in trials if t["outcome"] in SCORED for h in t["hard"] if h["check"] == "set_match" and not h.get("exact")]
    if fa:
        out.append(f'<h2>놓친 경로·더한 경로 ({len(fa)} trial)</h2>')
        for t in fa[:30]:
            h = next(h for h in t["hard"] if h["check"] == "set_match")
            miss = "".join(f"<div class='mono'>− {_e(x)}</div>" for x in h.get("missed", [])[:20])
            extra = "".join(f"<div class='mono'>+ {_e(x)}</div>" for x in h.get("extra", [])[:20])
            out.append(f'<details><summary><span class="mono">{_e(t["case"])}</span> {_arm(t["arm"])} #{t["rep"]} · '
                       f'놓침 {h.get("n_missed", 0)} · 더함 {h.get("n_extra", 0)} · {_e(h["detail"])}</summary>'
                       f'<div class="grid"><div>{miss or "<span class=na>없음</span>"}</div><div>{extra or "<span class=na>없음</span>"}</div></div></details>')

    causes = failure_causes(trials, arms)
    if causes:
        out.append('<h2>실패 원인 (arm별 trial 수)</h2><div class="scroll"><table><tr><th>원인</th>'
                   + "".join(f"<th>{_arm(a)}</th>" for a in arms) + "</tr>"
                   + "".join(f'<tr><td class="mono">{_e(c)}</td>' + "".join(f'<td class="num">{v.get(a, 0)}</td>' for a in arms) + "</tr>"
                             for c, v in causes)
                   + '</table></div><div class="legend">trial마다 원인 하나: 처음 실패한 체크(cites_exist는 실패 사유 라벨), '
                   'judge가 FAIL한 항목, 또는 제외 사유. 괄호 줄은 원인이 아니라 함께 센 수입니다.</div>')
    if m.get("stopped"):
        out.append(f'<div class="fail"><b>실행이 중간에 멈췄습니다</b> · {_e(m["stopped"])}</div>')

    fails = [t for t in trials if t["outcome"] != "pass"]
    out.append(f'<h2>실패·제외된 trial ({len(fails)})</h2>')
    for t in fails[:40]:
        calls = "".join(f"<div class='mono'>→ {_e(c)}</div>" for c in t.get("last_calls", [])[-5:])
        cut = f' · <b>truncated_output</b>: {_e(t["truncated_output"])}' if t.get("truncated_output") else ""
        out.append(f'<div class="fail"><b class="mono">{_e(t["case"])}</b> {_arm(t["arm"])} #{t["rep"]} · '
                   f'<b>{_e(t["outcome"])}</b>{cut} · {_e(t.get("reason", ""))}'
                   f'<blockquote>{_e((t.get("final_excerpt") or "(no answer)")[:800])}</blockquote>'
                   f'<details><summary>마지막 tool call · trajectory: trials/{_e(t["trial_id"])}/trajectory.jsonl</summary>{calls}</details></div>')

    cnt, iso, idx = m["counts"], m["isolation"], m.get("index") or {}
    exc = ", ".join(f"{k} {v}" for k, v in cnt["excluded"].items() if v) or "0"
    man = m.get("manifest")
    out.append(f'<h2>실행 기록</h2><div class="card sub">expected {cnt["expected"]} · attempted {cnt["attempted"]} · scored {cnt["scored"]} · '
               f'excluded {exc} · spent ${m["spent_usd"]:.2f} (estimate ${m["estimate"]["total_usd"]:.2f}) · wall {m.get("wall_seconds", 0) // 60}분<br>'
               + (f'인덱스: 한 번 빌드 {idx["seconds"]:.0f}s · ' + ", ".join(f'{v["bytes"] / 1e6:.0f} MB sha256 {v["sha256"][:12]}' for v in idx["files"].values())
                  + f' · {", ".join(idx["arms"])}가 같은 파일을 읽기 전용으로 씀<br>' if idx.get("files") else "")
               + f'격리: {"OK" if iso["all_ok"] else "BROKEN"} · 인증 {_e(m.get("auth_mode"))} · none arm에 보인 스킬 {len(iso["skills_visible_in_none"])}개 · '
               f'hook 이벤트 {iso["hook_events_total"]}개 · arm 순서 무작위(seed {m.get("seed")})<br>'
               f'출력이 잘린 trial(truncated_output) {m.get("truncated_output", 0)}개 · find-all 통과 기준 recall ≥ '
               f'{(m.get("find_all_pass") or {}).get("min_recall", "–")} 그리고 precision ≥ {(m.get("find_all_pass") or {}).get("min_precision", "–")}(실행 전 고정)<br>'
               f'빈 설정 폴더에 Claude Code가 만든 파일(키 이름만): {_e(json.dumps(m.get("config_files_seen") or {}, ensure_ascii=False))}<br>'
               f'repo 지시 파일: CLAUDE.md/AGENTS.md {m.get("repo_instructions", {}).get("kept_in_all_arms", "?")}개는 모든 arm에 같게 둠 · '
               f'뺀 폴더 {_e(", ".join(m.get("strip") or []))}<br>'
               f'고정(FROZEN.json): {_e(man["frozen_at"]) + (" · 해시 일치" if man.get("matches") else " · 해시 불일치(dev run)") if man else "없음"}'
               f' · SKILL.md sha256 {_e(json.dumps(m["skill_sha256"]))}</div>')
    out.append('<h2>측정 한계</h2><div class="card sub"><ul>' + "".join(f"<li>{_e(x)}</li>" for x in m.get("limitations") or LIMITS + list(m.get("notes") or []))
               + "</ul></div>")
    out.append("</main></body></html>")
    return "\n".join(out)


def write_reports(data: dict, out: Path) -> tuple[Path, str]:
    p = out / "scorecard.html"
    p.write_text(scorecard(data))
    (out / "summary.txt").write_text(terminal(data, per_case=True) + "\n")
    return p, terminal(data, color=sys.stdout.isatty() or bool(os.environ.get("FORCE_COLOR")))
