from datetime import datetime, timedelta

from sqlalchemy import select

from app.models import Notification, Trip
from app.recommender import recommend_departure, route_summary

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731


def test_recommendation_arrives_on_time_with_buffer(services):
    rec = recommend_departure(services.router, "eastend", "medcenter", MON(8, 30))
    assert rec.on_time
    assert rec.eta + timedelta(minutes=rec.buffer_min) <= MON(8, 30)
    assert rec.depart_at.minute % 5 == 0
    # Leaving 5 minutes later would be too late (otherwise we'd have recommended it).
    later = services.router.best_route("eastend", "medcenter", rec.depart_at + timedelta(minutes=5))
    assert later.arrive_at + timedelta(minutes=rec.buffer_min) > MON(8, 30)
    assert 0.3 <= rec.confidence <= 0.99
    assert "→" in route_summary(rec.route) or rec.route.segments


def test_rush_hour_needs_more_lead_time_than_early_morning(services):
    early = recommend_departure(services.router, "energy", "downtown", MON(5, 30))
    rush = recommend_departure(services.router, "energy", "downtown", MON(8, 30))
    assert rush.lead_minutes > early.lead_minutes


def test_impossible_arrival_flags_late(services):
    rec = recommend_departure(services.router, "energy", "hobby", MON(8, 30), earliest=MON(8, 20))
    assert not rec.on_time
    assert rec.depart_at == MON(8, 20)


def _add_trip(services, **kw):
    with services.session_factory() as s:
        trip = Trip(
            name=kw.get("name", "Work"),
            origin=kw.get("origin", "eastend"),
            destination=kw.get("destination", "medcenter"),
            arrive_by=kw.get("arrive_by", "08:30"),
            days=kw.get("days", "0,1,2,3,4"),
            safe_path=kw.get("safe_path", False),
        )
        s.add(trip)
        s.commit()
        return trip.id


def _notifications(services):
    with services.session_factory() as s:
        return s.scalars(select(Notification).order_by(Notification.id)).all()


def test_scheduler_sends_plan_then_leave_now_once(services):
    _add_trip(services)
    services.clock.set(MON(4, 0))  # too early: outside the 3h lookahead
    assert services.tick() == []

    services.clock.set(MON(7, 0))
    [plan] = services.tick()
    assert plan.kind == "plan"
    rec = recommend_departure(services.router, "eastend", "medcenter", MON(8, 30))

    services.clock.set(rec.depart_at - timedelta(minutes=5))
    assert services.tick() == []  # nothing changed yet

    services.clock.set(rec.depart_at)
    [leave] = services.tick()
    assert leave.kind == "leave_now" and "ETA" in leave.body

    services.clock.advance(5)
    assert services.tick() == []  # leave-now only once per day
    assert [n.kind for n in _notifications(services)] == ["plan", "leave_now"]


def test_scheduler_warns_to_leave_earlier_when_a_train_blocks_the_route(services):
    _add_trip(services, origin="eastend", destination="downtown", arrive_by="12:30", days="0", safe_path=True)
    services.clock.set(MON(11, 30))
    [plan] = services.tick()
    assert "Navigation" in plan.body

    # A long train parks on Navigation and Harrisburg; the whole plan shifts.
    for x in ("x_navigation", "x_harrisburg"):
        services.sources.trains.inject(x, MON(11, 31), 50)
    services.clock.set(MON(11, 35))
    [update] = services.tick()
    assert update.kind == "leave_earlier"
    assert "min earlier" in update.title


def test_scheduler_skips_trips_not_scheduled_today(services):
    _add_trip(services, days="5,6")  # weekends only; clock is on a Monday
    services.clock.set(MON(7, 30))
    assert services.tick() == []


def test_scheduler_sends_reroute_when_route_changes_but_time_does_not(services):
    _add_trip(services, arrive_by="08:00")
    services.clock.set(MON(7, 0))
    [plan] = services.tick()
    assert "Old Spanish Trail" in plan.body
    services.sources.trains.inject("x_ost", MON(7, 20), 40)
    services.clock.set(MON(7, 20))
    [reroute] = services.tick()
    assert reroute.kind == "reroute"
    assert "Rerouted around Old Spanish Trail" in reroute.body
    assert reroute.body.count("Old Spanish Trail @ Almeda") == 1
