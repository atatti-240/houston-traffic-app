"""Re-checks saved trips on every clock tick and sends plan / leave-earlier / leave-now alerts."""

from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Notification, Trip, TripState
from app.notifications.service import NotificationService
from app.recommender import Recommendation, recommend_departure, route_summary
from app.routing.router import Router

LOOKAHEAD = timedelta(hours=3)  # start watching a trip this long before its arrive-by time
SHIFT_ALERT = timedelta(minutes=5)


def _fmt(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _top_reason(rec: Recommendation) -> str:
    return rec.route.reasons[0] if rec.route.reasons else ""


class TripScheduler:
    def __init__(
        self, session_factory: sessionmaker[Session], router: Router, notifier: NotificationService
    ) -> None:
        self.session_factory = session_factory
        self.router = router
        self.notifier = notifier

    def tick(self, now: datetime) -> list[Notification]:
        sent: list[Notification] = []
        with self.session_factory() as session:
            for trip in session.scalars(select(Trip)):
                n = self._check_trip(session, trip, now)
                if n:
                    sent.append(n)
            session.commit()
        return sent

    def _check_trip(self, session: Session, trip: Trip, now: datetime) -> Notification | None:
        if now.weekday() not in trip.day_list:
            return None
        hh, mm = map(int, trip.arrive_by.split(":"))
        arrive_by = datetime.combine(now.date(), time(hh, mm))
        if not (arrive_by - LOOKAHEAD <= now < arrive_by):
            return None

        state = session.scalar(select(TripState).where(TripState.trip_id == trip.id, TripState.day == now.date()))
        if state is None:
            state = TripState(trip_id=trip.id, day=now.date())
            session.add(state)
        if state.leave_now_sent:
            return None

        rec = recommend_departure(self.router, trip.origin, trip.destination, arrive_by, trip.safe_path)
        reason = _top_reason(rec)
        summary = route_summary(rec.route)
        note = None

        if now >= rec.depart_at:
            body = f"Take {summary}. ETA {_fmt(rec.eta)}."
            note = self.notifier.send(
                session, trip, "leave_now", f"Leave now for {trip.name}", f"{body} {reason}".strip(), now
            )
            state.leave_now_sent = True
        elif state.last_departure is None:
            note = self.notifier.send(
                session,
                trip,
                "plan",
                f"{trip.name}: leave at {_fmt(rec.depart_at)}",
                f"Arrive by {_fmt(arrive_by)} via {summary}. {reason}".strip(),
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
