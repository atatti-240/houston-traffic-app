"""Re-checks saved trips and watched multi-stop plans on every clock tick.

Trips (single leg, every chosen weekday): plan / leave earlier / leave later / reroute / leave now.
Watched plans (POST /plan with watch=true): re-planned every 5 min until the first leg starts,
and on the tick its departure comes due; alert on a new stop order or a first departure that
moved >= 5 min earlier / 10 min later, "Hold on" (once) if it's pushed back just as it came
due, then "leave now" per leg. A plan never started whose windows all closed is "Missed".
"""

import logging
from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Notification, SavedPlan, Trip, TripState
from app.notifications.service import NotificationService
from app.plan_io import plan_to_json, request_from_json
from app.planner import plan_trip
from app.recommender import Recommendation, recommend_departure, route_summary
from app.routing.router import Router

LOOKAHEAD = timedelta(hours=3)  # start watching a trip this long before its arrive-by time
SHIFT_ALERT = timedelta(minutes=5)
REPLAN_EVERY = timedelta(minutes=5)

log = logging.getLogger("houston.scheduler")


def _fmt(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _arrival_text(rec: Recommendation, arrive_by: datetime) -> str:
    if rec.on_time:
        return f"Arrive by {_fmt(arrive_by)}"
    late = max(1, round((rec.eta - arrive_by).total_seconds() / 60))
    return f"ETA {_fmt(rec.eta)}, about {late} min after {_fmt(arrive_by)},"


def _top_reason(rec: Recommendation) -> str:
    return rec.route.reasons[0] if rec.route.reasons else ""


class TripScheduler:
    def __init__(
        self, session_factory: sessionmaker[Session], router: Router, notifier: NotificationService
    ) -> None:
        self.session_factory = session_factory
        self.router = router
        self.notifier = notifier

    def tick(self, now: datetime, replan_now: bool = False) -> list[Notification]:
        """replan_now: re-plan watched plans even if they were planned < 5 min ago (live
        conditions just changed)."""
        sent: list[Notification] = []
        with self.session_factory() as session:
            trip_ids = list(session.scalars(select(Trip.id)))
            for trip_id in trip_ids:
                # One broken trip must not stop alerts for everyone else.
                try:
                    n = self._check_trip(session, session.get(Trip, trip_id), now)
                    session.commit()
                except Exception:
                    session.rollback()
                    log.exception("scheduler: skipping trip %s", trip_id)
                    continue
                if n:
                    sent.append(n)
            plan_ids = list(session.scalars(select(SavedPlan.id).where(SavedPlan.watch, ~SavedPlan.done)))
            for plan_id in plan_ids:
                try:
                    notes = self._check_plan(session, session.get(SavedPlan, plan_id), now, replan_now)
                    session.commit()
                except Exception:
                    session.rollback()
                    log.exception("scheduler: skipping plan %s", plan_id)
                    continue
                sent.extend(notes)
        return sent

    # --- watched multi-stop plans -------------------------------------------------------------

    def _check_plan(self, session: Session, sp: SavedPlan, now: datetime, replan_now: bool = False) -> list[Notification]:
        notes: list[Notification] = []
        sent = set(sp.leave_now_sent or [])
        result = sp.result_json

        def note(kind: str, title: str, body: str) -> None:
            notes.append(self.notifier.send(session, None, kind, title, body.strip(), now, plan_id=sp.id))

        # Never left, every stop's window has closed and the planned departure has passed too
        # (e.g. the clock jumped a day): stop watching instead of re-planning into stale
        # "running late" alerts. A plan that's late but hasn't reached its departure still
        # gets its "leave now"; stops without an end time can still be done; and once you've
        # left, the legs play out as planned.
        ends = [leg["window"]["end"] for leg in result["legs"]]
        deadline = [*ends, result["legs"][0]["leave_at"]]
        if 0 not in sent and all(ends) and now > max(map(datetime.fromisoformat, deadline)):
            note("info", f"Missed: {sp.name}", "Its time windows have passed, so it's no longer being watched.")
            sp.done = True
            return notes

        if not sp.announced:
            leg0 = result["legs"][0]
            leave = datetime.fromisoformat(leg0["leave_at"])
            if leave > now:  # when it's already time to go, "leave now" below says so
                note(
                    "plan",
                    f"{sp.name}: leave at {_fmt(leave)}",
                    f"Stops: {' → '.join(result['order'])}. {(leg0['why'] or [''])[0]}",
                )
            sp.announced = True

        # Re-plan until the trip starts (after that the legs are what the user is driving),
        # always on the tick the departure comes due so "leave now" uses fresh conditions,
        # except after a "Hold on": then the deferred time stands.
        new = None
        due = now >= datetime.fromisoformat(result["legs"][0]["leave_at"])
        if 0 not in sent and not (due and sp.held) and (replan_now or due or now - sp.last_planned_at >= REPLAN_EVERY):
            try:
                start, stops, depart_after, weight, buffer_min = request_from_json(sp.request_json)
                plan = plan_trip(
                    self.router, start, stops, max(depart_after, now), now, weight,
                    buffer_min=buffer_min, prefer_order=result["order"],
                )
                new = plan_to_json(plan, sp.id, created_at=sp.created_at, watch=True)
            except Exception:
                # Keep the last good plan (and its "leave now" alerts); retry next tick.
                log.warning("scheduler: re-planning %s failed; keeping the last plan", sp.id, exc_info=True)
        if new is not None and sp.held and new["legs"][0]["leave_at"] > result["legs"][0]["leave_at"]:
            # After a "Hold on" the departure only moves earlier; otherwise a closure with no
            # known end would push it back forever and "leave now" would never come.
            new = None
            sp.last_planned_at = now
        if new is not None:
            old_leave = datetime.fromisoformat(result["legs"][0]["leave_at"])
            new_leave = datetime.fromisoformat(new["legs"][0]["leave_at"])
            why = (new["legs"][0]["why"] or [""])[0]
            if new["order"] != result["order"]:
                note(
                    "order_changed",
                    f"New stop order for {sp.name}",
                    f"{' → '.join(new['order'])}; leave at {_fmt(new_leave)}. {why}",
                )
            elif old_leave <= now:
                # We said go at old_leave. If going now is still right, "leave now" below
                # says so; if the new plan waits (e.g. a train just blocked the way), say that.
                if new_leave > now:
                    note("leave_later", f"Hold on: leave at {_fmt(new_leave)} for {sp.name}", f"Not yet. {why}")
                    sp.held = True
            elif new_leave <= old_leave - SHIFT_ALERT:
                minutes = (old_leave - new_leave).total_seconds() / 60
                note("leave_earlier", f"Leave {minutes:.0f} min earlier for {sp.name}", f"New departure {_fmt(new_leave)}. {why}")
            elif new_leave >= old_leave + 2 * SHIFT_ALERT:
                minutes = (new_leave - old_leave).total_seconds() / 60
                note("leave_later", f"You can leave {minutes:.0f} min later for {sp.name}", f"New departure {_fmt(new_leave)}.")
            sp.result_json = result = new
            sp.last_planned_at = now

        # "Leave now" for the next leg that is due.
        legs = result["legs"]
        for i, leg in enumerate(legs):
            if i in sent:
                continue
            if now >= datetime.fromisoformat(leg["leave_at"]):
                eta = datetime.fromisoformat(leg["arrive_at"])
                title = f"Leave now for {leg['to']}"
                if leg["late_min"] > 0:
                    title = f"Leave now, you're running late for {leg['to']}"
                note("leave_now", title, f"Take {leg['summary']}. ETA {_fmt(eta)}. {(leg['why'] or [''])[0]}")
                sent.add(i)
            break
        sp.leave_now_sent = sorted(sent)
        if len(sent) == len(legs) and now >= datetime.fromisoformat(legs[-1]["arrive_at"]):
            sp.done = True
        return notes

    @staticmethod
    def _watched_arrival(trip: Trip, now: datetime) -> datetime | None:
        """The arrive-by moment being watched right now: today's, or tomorrow's when it is
        shortly after midnight and inside the lookahead window."""
        hh, mm = map(int, trip.arrive_by.split(":"))
        for offset in (0, 1):
            arrive_by = datetime.combine(now.date() + timedelta(days=offset), time(hh, mm))
            if arrive_by.weekday() in trip.day_list and arrive_by - LOOKAHEAD <= now < arrive_by:
                return arrive_by
        return None

    @staticmethod
    def _deferred_arrival(session: Session, trip: Trip, now: datetime) -> datetime | None:
        """An arrive-by that already passed but whose "leave now" is still to come, because
        the departure was put after it (a closed road: leaving later arrives just as soon)."""
        hh, mm = map(int, trip.arrive_by.split(":"))
        for offset in (0, -1):
            arrive_by = datetime.combine(now.date() + timedelta(days=offset), time(hh, mm))
            if arrive_by.weekday() not in trip.day_list or not (arrive_by <= now < arrive_by + LOOKAHEAD):
                continue
            state = session.scalar(
                select(TripState).where(TripState.trip_id == trip.id, TripState.day == arrive_by.date())
            )
            if state and not state.leave_now_sent and state.last_departure and state.last_departure > arrive_by:
                return arrive_by
        return None

    def _check_trip(self, session: Session, trip: Trip, now: datetime) -> Notification | None:
        arrive_by = self._watched_arrival(trip, now) or self._deferred_arrival(session, trip, now)
        if arrive_by is None:
            return None

        day = arrive_by.date()
        state = session.scalar(select(TripState).where(TripState.trip_id == trip.id, TripState.day == day))
        if state is None:
            state = TripState(trip_id=trip.id, day=day)
            session.add(state)
        if state.leave_now_sent:
            return None

        # Never recommend a departure that has already passed.
        rec = recommend_departure(
            self.router, trip.origin, trip.destination, arrive_by, earliest=now, safety_weight=trip.weight
        )
        reason = _top_reason(rec)
        summary = route_summary(rec.route)
        note = None

        if now >= rec.depart_at:
            if rec.on_time:
                title = f"Leave now for {trip.name}"
                body = f"Take {summary}. ETA {_fmt(rec.eta)}."
            elif rec.eta <= arrive_by:
                title = f"Leave now, it's tight for {trip.name}"
                body = f"Take {summary}. ETA {_fmt(rec.eta)}, less than {rec.buffer_min} min to spare."
            else:
                late = max(1, round((rec.eta - arrive_by).total_seconds() / 60))
                title = f"Leave now, you're running late for {trip.name}"
                body = f"Take {summary}. ETA {_fmt(rec.eta)}, about {late} min after {_fmt(arrive_by)}."
            note = self.notifier.send(session, trip, "leave_now", title, f"{body} {reason}".strip(), now)
            state.leave_now_sent = True
        elif state.last_departure is None:
            note = self.notifier.send(
                session,
                trip,
                "plan",
                f"{trip.name}: leave at {_fmt(rec.depart_at)}",
                f"{_arrival_text(rec, arrive_by)} via {summary}. {reason}".strip(),
                now,
            )
        elif rec.depart_at <= state.last_departure - SHIFT_ALERT:
            earlier = (state.last_departure - rec.depart_at).total_seconds() / 60
            note = self.notifier.send(
                session,
                trip,
                "leave_earlier",
                f"Leave {earlier:.0f} min earlier for {trip.name}",
                f"New departure {_fmt(rec.depart_at)} via {summary}. {reason}".strip(),
                now,
            )
        elif rec.depart_at >= state.last_departure + 2 * SHIFT_ALERT:
            later = (rec.depart_at - state.last_departure).total_seconds() / 60
            note = self.notifier.send(
                session,
                trip,
                "leave_later",
                f"You can leave {later:.0f} min later for {trip.name}",
                f"New departure {_fmt(rec.depart_at)} via {summary}.",
                now,
            )
        elif state.last_route and summary != state.last_route:
            note = self.notifier.send(
                session,
                trip,
                "reroute",
                f"New route for {trip.name}",
                f"Still leave at {_fmt(rec.depart_at)}, but take {summary}. {reason}".strip(),
                now,
            )
        state.last_departure = rec.depart_at
        state.last_route = summary
        return note
