"""Statistics. pass@k, pass^k and the paired bootstrap are copied from skilleval-design §4.7."""
from __future__ import annotations

import random
from math import comb, isfinite


def _check(n, c, k):
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (n, c, k)):
        raise TypeError("n, c and k must be integers")
    if not (0 <= c <= n and 1 <= k <= n):
        raise ValueError(f"need 0 <= c <= n and 1 <= k <= n (n={n}, c={c}, k={k})")


def pass_at_k(n, c, k):
    _check(n, c, k)
    return 1.0 if n - c < k else 1 - comb(n - c, k) / comb(n, k)


def pass_hat_k(n, c, k):
    _check(n, c, k)
    return comb(c, k) / comb(n, k)


def paired_bootstrap(control, treatment, iters=10000, seed=0):
    """control, treatment: {case_id: mean score}. Percentile bootstrap of the
    mean paired difference; resamples cases, never trials."""
    if not isinstance(iters, int) or isinstance(iters, bool) or iters < 1000:
        raise ValueError("iters must be an integer >= 1000")
    if not control or set(control) != set(treatment):
        raise ValueError("both arms must cover the same non-empty set of case ids")
    diffs = [treatment[c] - control[c] for c in sorted(control)]
    if not all(isfinite(v) for v in diffs):
        raise ValueError("scores must be finite numbers")
    rnd = random.Random(seed)
    n = len(diffs)
    boots = sorted(sum(rnd.choice(diffs) for _ in range(n)) / n for _ in range(iters))
    return sum(diffs) / n, (boots[int(0.025 * iters)], boots[int(0.975 * iters) - 1])


# ---- aggregation over graded trials -----------------------------------------

SCORED = ("pass", "fail", "limit", "safety_violation")          # the agent's own result: counts toward the score
EXCLUDED = ("infra_error", "isolation_error", "invalid", "skipped_budget", "skipped_stopped")   # not the agent's doing: counted, not scored
NO_DIFF = "이 케이스·반복 수에서는 차이를 검출하지 못함"
MIN_FAMILIES = 5                 # fewer families than this: report Δ only, no CI


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def verdict(delta: float, ci: tuple[float, float]) -> str:
    """Wording that does not presume a result. The CI is exploratory (few cases, k small)."""
    if ci[0] > 0:
        return f"개선 쪽 차이 (Δ {delta:+.2f}, 탐색적 CI가 0 위)"
    if ci[1] < 0:
        return f"하락 쪽 차이 (Δ {delta:+.2f}, 탐색적 CI가 0 아래)"
    return NO_DIFF


def aggregate(trials: list[dict], arms: list[str], case_ids: list[str], pairs=(("none", "v1"), ("v1", "v2")),
              sensitivity: dict | None = None) -> dict:
    """trials: graded records with case, arm, outcome, score, passed, metrics. Excluded trials are counted, not scored.
    sensitivity {exclude, reason}: the same comparisons again without those cases, reported next to (not instead of)
    the pre-registered all-case result."""
    cells, per_arm = {}, {}
    family = {t["case"]: t.get("family") or t["case"] for t in trials}
    kind = {t["case"]: t["kind"] for t in trials}
    for arm in arms:
        scored_all = []
        for cid in case_ids:
            ts = [t for t in trials if t["arm"] == arm and t["case"] == cid]
            scored = [t for t in ts if t["outcome"] in SCORED]
            n, c = len(scored), sum(t["passed"] for t in scored)
            set_m = [h for t in scored for h in t["hard"] if h["check"] in ("set_match", "sources_hit")]
            exact = [h["exact"] for t in scored for h in t["hard"] if h["check"] == "set_match"]
            cells[f"{cid}|{arm}"] = {
                "n": n, "passes": c, "attempted": len(ts),
                "excluded": len([t for t in ts if t["outcome"] not in SCORED]),
                "mean_score": _mean([t["score"] for t in scored]),
                # pass@k / pass^k need every planned repeat scored: with 1 of 3 left, pass^3 would read as pass^1
                "pass_at_k": pass_at_k(n, c, n) if n and n == len(ts) else None,
                "pass_hat_k": pass_hat_k(n, c, n) if n and n == len(ts) else None,
                "exact_rate": _mean([float(x) for x in exact]),
                "recall": _mean([h.get("recall") for h in set_m]),
                "precision": _mean([h.get("precision") for h in set_m]),
                "trials": [{"score": t["score"], "passed": t["passed"], "outcome": t["outcome"]} for t in ts],
            }
            scored_all += scored
        sl = [h for t in scored_all for h in t["hard"] if h["check"] == "skill_loaded" and h["ok"] is not None]
        should_load = [h["loaded"] for h in sl if "expect=load" in h["detail"]]
        passed = [t for t in scored_all if t["passed"]]
        fa = [cid for cid in case_ids if kind.get(cid) == "find-all"]
        per_arm[arm] = {
            "trials": len(scored_all),
            "pass_rate": _mean([float(t["passed"]) for t in scored_all]),
            "mean_score": _mean([t["score"] for t in scored_all]),
            "exact_rate": _mean([cells[f"{cid}|{arm}"]["exact_rate"] for cid in fa]),     # find-all primary
            "pass_hat_k": _mean([cells[f"{cid}|{arm}"]["pass_hat_k"] for cid in case_ids]),
            "pass_at_k": _mean([cells[f"{cid}|{arm}"]["pass_at_k"] for cid in case_ids]),
            "skill_load_rate": _mean([float(x) for x in should_load]) if arm != "none" else None,   # when it should load
            "routing_accuracy": _mean([float(h["ok"]) for h in sl]) if arm != "none" else None,  # load / no-load as expected
            "any_skill_loaded_in_none": any(t["skill_loaded"] for t in scored_all) if arm == "none" else None,
            "mean_seconds": _mean([t["metrics"]["seconds"] for t in scored_all]),
            "mean_seconds_passed": _mean([t["metrics"]["seconds"] for t in passed]),
            "mean_tokens": _mean([t["metrics"]["tokens_total"] for t in scored_all]),
            "mean_output_tokens": _mean([t["metrics"]["tokens"]["output"] for t in scored_all]),
            "mean_usd": _mean([t["metrics"]["agent_usd"] for t in scored_all]),
            "mean_tool_calls": _mean([t["metrics"]["tool_calls"] for t in scored_all]),
            "mean_recall": _mean([cells[f"{cid}|{arm}"]["recall"] for cid in fa]),
            "mean_precision": _mean([cells[f"{cid}|{arm}"]["precision"] for cid in fa]),
            "limits_hit": sum(t["outcome"] == "limit" for t in scored_all),
            "safety_violations": sum(t["outcome"] == "safety_violation" for t in scored_all),
            "judge_usd": sum(t["metrics"]["judge_usd"] for t in scored_all),
        }

    def compare(ids):
        subsets = [("all", ids)] + [(k, [c for c in ids if kind.get(c) == k]) for k in ("find-all", "why", "small")]
        return [c for a, b in pairs if a in arms and b in arms for c in _compare(cells, family, a, b, subsets)]

    out = {"cells": cells, "arms": per_arm, "comparisons": compare(case_ids),
           "ci_note": "paired percentile bootstrap over case families (near-duplicates merged), exploratory; "
                      "same-model judge votes are not independent raters"}
    if sensitivity and sensitivity.get("exclude"):
        drop = set(sensitivity["exclude"])
        out["sensitivity"] = {"exclude": sorted(drop & set(case_ids)), "reason": sensitivity.get("reason", ""),
                              "comparisons": compare([c for c in case_ids if c not in drop])}
    return out


def _compare(cells, family, a, b, subsets) -> list[dict]:
    comparisons = []
    for name, ids in subsets:
        common = [cid for cid in ids if cells[f"{cid}|{a}"]["n"] and cells[f"{cid}|{b}"]["n"]]
        if not common:
            continue
        fams: dict[str, list[str]] = {}
        for cid in common:                      # near-duplicate questions count once: average within a family
            fams.setdefault(family[cid], []).append(cid)
        ctrl = {f: _mean([cells[f"{c}|{a}"]["mean_score"] for c in cs]) for f, cs in fams.items()}
        trt = {f: _mean([cells[f"{c}|{b}"]["mean_score"] for c in cs]) for f, cs in fams.items()}
        if len(fams) >= MIN_FAMILIES:
            delta, ci = paired_bootstrap(ctrl, trt)
            verdict_text = verdict(delta, ci)
        else:
            delta = _mean([trt[f] - ctrl[f] for f in fams])
            ci, verdict_text = None, f"가족 {len(fams)}개라 CI 생략(Δ만 보고)"
        comparisons.append({"control": a, "treatment": b, "subset": name, "cases": len(common), "families": len(fams),
                            "delta": delta, "ci95": ci, "verdict": verdict_text,
                            "control_mean": _mean(list(ctrl.values())), "treatment_mean": _mean(list(trt.values()))})
    return comparisons
