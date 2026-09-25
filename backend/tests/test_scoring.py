from datetime import date, datetime

import pytest

from app.scoring.congestion import CongestionModel, congestion_ratio
from app.scoring.store import ScoreStore
from app.seed.synthetic import SpeedObservation, TrainEvent

MONDAY = date(2026, 9, 28)


def at(h, m=0, day=MONDAY):
    return datetime(day.year, day.month, day.day, h, m)


# --- EMA / congestion unit tests --------------------------------------------------------


def test_ema_first_observation_initializes_then_converges():
    store = ScoreStore()
    store.ema("t", "a", "b", 0.8, alpha=0.2)
    assert store.get("t", "a", "b").value == pytest.approx(0.8)
    for _ in range(60):
        store.ema("t", "a", "b", 0.3, alpha=0.2)
    assert store.get("t", "a", "b").value == pytest.approx(0.3, abs=1e-4)


def test_ema_with_prior_starts_from_prior():
    store = ScoreStore()
    store.ema("t", "a", "b", 1.0, alpha=0.1, prior=0.0)
    assert store.get("t", "a", "b").value == pytest.approx(0.1)


def test_congestion_reacts_to_sustained_change_and_stays_in_range(trained):
    network, _, _, _ = trained
    model = CongestionModel(ScoreStore(), network, alpha=0.2)
    seg = network.segments["I10W:downtown>i10_610w"]
    for week in range(10):
        model.update_from_observations(MONDAY, [SpeedObservation(seg.id, 32, seg.free_flow_mph * 0.9)])
    low = model.get_score(seg.id, at(8))
    for week in range(10):
        model.update_from_observations(MONDAY, [SpeedObservation(seg.id, 32, seg.free_flow_mph * 0.2)])
    high = model.get_score(seg.id, at(8))
    assert low == pytest.approx(0.1, abs=0.01)
    assert high > 0.7
    # Absurd inputs are clamped.
    model.update_from_observations(MONDAY, [SpeedObservation(seg.id, 32, -50)])
    model.update_from_observations(MONDAY, [SpeedObservation(seg.id, 33, 500)])
    assert 0.0 <= model.get_score(seg.id, at(8)) <= 1.0
    assert model.get_score(seg.id, at(8, 15)) == 0.0
    assert congestion_ratio(80, 65) == 0.0 and congestion_ratio(0, 65) == 1.0


def test_travel_time_grows_with_congestion(trained):
    network, models, _, _ = trained
    seg = network.segments["I45N:i45_610n>downtown"]
    rush = models.congestion.get_segment_travel_time(seg.id, at(7, 45))
    night = models.congestion.get_segment_travel_time(seg.id, at(3))
    assert night == pytest.approx(seg.free_flow_seconds, rel=0.1)
    assert rush > 2 * night


# --- Models after replaying history ------------------------------------------------------


def test_rush_hour_bucket_beats_3am_on_i45(trained):
    _, models, _, _ = trained
    seg = "I45N:i45_610n>downtown"
    assert models.congestion.get_score(seg, at(7, 45)) > 0.5
    assert models.congestion.get_score(seg, at(3)) < 0.1
    # Outbound direction peaks in the evening instead.
    out = "I45N:downtown>i45_610n"
    assert models.congestion.get_score(out, at(17, 30)) > models.congestion.get_score(out, at(7, 45))


def test_all_scores_in_unit_range(trained):
    _, models, _, _ = trained
    for model in ("congestion", "train"):
        assert all(0.0 <= e.value <= 1.0 for _, _, e in models.store.items(model))


def test_recurring_crossing_blockage_is_learned(trained):
    _, models, _, _ = trained
    assert models.train.get_block_probability("x_cullen", at(7, 30)) > 0.5
    assert models.train.get_block_probability("x_cullen", at(12, 0)) < 0.15
    assert models.train.get_expected_delay("x_cullen", at(7, 40)) > models.train.get_expected_delay(
        "x_cullen", at(12, 0)
    )
    # Weekend has no recurring Cullen train.
    assert models.train.get_block_probability("x_cullen", at(7, 30, date(2026, 9, 27))) < 0.15


def test_live_blockage_overrides_prediction(trained):
    _, models, _, _ = trained
    live = [TrainEvent("x_wayside", at(12, 0), at(12, 20))]
    assert models.train.get_expected_delay("x_wayside", at(12, 5)) < 60
    assert models.train.get_expected_delay("x_wayside", at(12, 5), live) == pytest.approx(15 * 60)
    assert models.train.get_expected_delay("x_wayside", at(12, 25), live) < 60


def test_crash_prone_links_score_higher(trained):
    network, models, _, _ = trained
    hot = ["L610W:i10_610w>i69_610sw", "L610S:288_610s>i45_610s", "I45S:gulf_ee>downtown"]
    calm = ["I10E:i10_610e>downtown", "L610E:i45_610s>i10_610e", "BW8:290_bw8>i10_bw8w"]

    def avg(ids):
        return sum(models.crash.get_crash_risk(s, at(h)) for s in ids for h in range(6, 20)) / (len(ids) * 14)

    assert avg(hot) > 1.5 * avg(calm)
    # Rush hour is riskier than the middle of the night on the same road.
    assert models.crash.get_crash_risk(hot[0], at(8)) > models.crash.get_crash_risk(hot[0], at(3))
    top = [sid for sid, _ in models.crash.top_risky(at(8), 10)]
    assert any(s.startswith(("L610W", "L610S", "I45S")) for s in top)
    assert all(0.0 <= r <= 1.0 for _, r in models.crash.top_risky(at(8), 100))
