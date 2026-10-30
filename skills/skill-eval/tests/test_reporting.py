"""Report additions (E3): failure causes, split judge votes, a rough detection-power line. Offline."""
import pytest
from fakes import fake_run, make_case, make_rec

from skill_eval import report, stats


def test_mde_and_families_needed():
    diffs = [0.0, 0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.0, 0.5, -0.5]
    m = stats.mde_80(diffs)
    sd = (sum(d * d for d in diffs) / 9) ** 0.5
    assert m == pytest.approx(2.8 * sd / 10 ** 0.5)
    assert stats.families_for(m, 10, m / 2) == 40               # half the difference needs 4x the families
    assert stats.mde_80([0.0] * 8) is None and stats.mde_80([0.1, 0.2]) is None


def test_reports_show_causes_splits_and_detection_power(monkeypatch, tmp_path):
    cases = [make_case(f"W{i}") for i in range(6)]
    hard_fail = [{"check": "cites_exist", "category": "correctness", "gate": True, "ok": False, "detail": "1 missing",
                  "missing_kinds": {"not_a_commit": 1}}]
    split = [{"items": [{"id": "answers_question", "verdict": v}]} for v in ("PASS", "PASS", "FAIL")]

    def trial(spec, n):
        if spec["arm"] == "none" and spec["case"].id in ("W1", "W2"):
            return make_rec(spec, outcome="fail", score=0.0, hard=hard_fail)
        return make_rec(spec, votes=split, score=1.0 if n % 2 else 0.5)
    data, _ = fake_run(monkeypatch, tmp_path, cases, trial, k=2, canary=False)
    causes = dict(report.failure_causes(data["trials"], ["none", "v1"]))
    assert causes["cites_exist · not_a_commit"] == {"none": 4, "v1": 0}
    assert causes["(judge 표가 갈린 trial)"]["v1"] == 12
    html_path, text = report.write_reports(data, tmp_path / "out")
    page, summary = html_path.read_text(), (tmp_path / "out" / "summary.txt").read_text()
    assert "실패 원인" in page and "cites_exist · not_a_commit" in summary
    comp = next(c for c in data["aggregate"]["comparisons"] if c["subset"] == "all")
    assert comp["families"] == 6 and comp["mde_80"] and "검출력" in text and "어림값" in page


def test_spend_with_unknown_attempt_costs_reads_as_a_lower_bound(monkeypatch, tmp_path):
    # review r2 (optional): an attempt with no result line has no known cost; the total is "at least", not exact
    def trial(spec, n):
        r = make_rec(spec)
        if n == 1:
            r["metrics"]["cost_unknown_attempts"] = 1
        return r
    data, _ = fake_run(monkeypatch, tmp_path, [make_case("W0")], trial, canary=False)
    assert data["meta"]["cost_unknown_attempts"] == 1
    html_path, text = report.write_reports(data, tmp_path / "out")
    assert "≥$" in text and "1 attempt(s) of unknown cost" in text and "≥$" in html_path.read_text()


def test_an_arm_with_no_scored_trial_reads_na(monkeypatch, tmp_path):
    # review r3 #3: none is fully excluded and v1 has retried attempts; the token line must show N/A, not raise
    def trial(spec, n):
        if spec["arm"] == "none":
            return make_rec(spec, outcome="infra_error", score=None)
        r = make_rec(spec)
        r["metrics"]["tokens_total_all_attempts"] = 30
        return r
    data, _ = fake_run(monkeypatch, tmp_path, [make_case("W0"), make_case("W1")], trial, canary=False)
    assert data["aggregate"]["arms"]["none"]["mean_tokens_all_attempts"] is None
    html_path, text = report.write_reports(data, tmp_path / "out")
    assert "none N/A" in text and "v1 30" in text and html_path.exists()
