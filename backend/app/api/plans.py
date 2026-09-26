"""Multi-stop plans (docs/contracts/trip_request.json -> plan_result.json)."""

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select

from app.api.deps import get_services, is_clock_time, resolve_place, resolve_time
from app.api.planning import notification_json
from app.api.schemas import StopIn, TripPlanRequest
from app.models import Notification, SavedPlan
from app.plan_io import plan_to_json, request_to_json
from app.planner import StopRequest, plan_trip
from app.routing.router import NoRouteError
from app.services import Services

router = APIRouter(tags=["plans"])
DAY = timedelta(days=1)
START_ONLY_ROLL = timedelta(hours=12)


def _windows(svc: Services, stops: list[StopIn], depart_after: datetime) -> list[tuple[datetime | None, datetime | None]]:
    """Resolve window times. ISO times are taken as given. HH:MM times start on
    depart_after's day, and each window moves to the next day on its own when:
      - its end has already passed ("08:00"-"08:30" asked at 10 PM), or
      - it only has a start, and that start is more than 12 h ago ("08:00" asked at 10 PM),
        or it's already past while another window in the request moved (so "08:00"-"08:30"
        then "09:00" asked at 10 PM are both tomorrow).
    A window still ahead today never moves, so "23:00"-"23:30" then "00:15"-"00:45" is
    tonight then after midnight, unless it's a fixed-order stop whose window would close
    before the previous fixed stop's opens. An end at or before its start is overnight
    (23:30-00:30): the window you're inside right now, else tonight's."""
    day = depart_after.date()
    windows, rolled, passed_starts = [], False, []
    for i, s in enumerate(stops):
        clock_start, clock_end = is_clock_time(s.window_start), is_clock_time(s.window_end)
        ws = resolve_time(svc, s.window_start, day) if s.window_start else None
        we = resolve_time(svc, s.window_end, day) if s.window_end else None
        if ws and we and clock_start and clock_end and we <= ws:
            if depart_after < we:
                ws -= DAY  # still inside last night's window
            else:
                we += DAY
        if we and clock_end and we < depart_after:
            we += DAY
            ws = ws + DAY if ws and clock_start else ws
            rolled = True
        elif ws and not we and clock_start and ws < depart_after:
            if ws < depart_after - START_ONLY_ROLL:
                ws += DAY
                rolled = True
            else:
                passed_starts.append(i)
        windows.append((ws, we))
    if rolled:  # already-open start-only windows follow the ones that moved to tomorrow
        for i in passed_starts:
            ws, we = windows[i]
            windows[i] = (ws + DAY, we)
    # Fixed-order stops are visited in typed order: an all-HH:MM window that would close
    # before the previous fixed stop's window even opens is the next day's. (Only windows
    # that close can be "before"; only windows that open set the floor; an ISO time pins
    # the date.)
    prev_open = None
    for i, s in enumerate(stops):
        if not s.fixed_order:
            continue
        ws, we = windows[i]
        all_clock = all(is_clock_time(t) for t in (s.window_start, s.window_end) if t)
        if prev_open is not None and we is not None and we < prev_open and all_clock:
            ws, we = (ws + DAY if ws else ws), we + DAY
            windows[i] = (ws, we)
        if ws is not None:
            prev_open = ws
    return windows


def _summary(sp: SavedPlan) -> dict:
    r = sp.result_json
    return {
        "plan_id": sp.id,
        "name": sp.name,
        "status": r["status"],
        "order": r["order"],
        "leave_at": r["legs"][0]["leave_at"],
        "arrive_at": r["legs"][-1]["arrive_at"],
        "watch": sp.watch,
        "done": sp.done,
        "created_at": sp.created_at,
    }


@router.post("/plan", status_code=201)
def create_plan(req: TripPlanRequest, svc: Services = Depends(get_services)):
    """Best stop order and departure times for up to 3 stops. With watch=true the plan is
    re-checked every 5 min and alerts go to /notifications (new order, leave earlier/later,
    leave now per leg)."""
    now = svc.clock.now()
    depart_after = resolve_time(svc, req.depart_after)
    if is_clock_time(req.depart_after) and depart_after < now.replace(second=0, microsecond=0):
        depart_after += DAY  # "07:30" at 10 PM means tomorrow morning; "12:20" at 12:20:30 is now
    start = resolve_place(svc, req.start)
    stops = []
    for s, (ws, we) in zip(req.stops, _windows(svc, req.stops, depart_after)):
        if ws and we and we <= ws:
            raise HTTPException(422, f"{s.name or s.place or 'stop'}: window_end must be after window_start")
        stops.append(StopRequest(resolve_place(svc, s), ws, we, s.dwell_min, s.fixed_order))
    try:
        plan = plan_trip(
            svc.router,
            start,
            stops,
            depart_after,
            now,
            safety_weight=req.safety_weight,
            safe_path=req.safe_path,
            buffer_min=req.buffer_min,
        )
    except NoRouteError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    plan_id = f"p_{now:%Y%m%d}_{uuid.uuid4().hex[:6]}"
    result = plan_to_json(plan, plan_id, created_at=now, watch=req.watch)
    with svc.session_factory() as s:
        s.add(
            SavedPlan(
                id=plan_id,
                name=req.name or " → ".join(plan.order_names),
                device_id=req.device_id,
                request_json=request_to_json(start, stops, depart_after, plan.safety_weight, req.buffer_min),
                result_json=result,
                watch=req.watch,
                created_at=now,
                last_planned_at=now,
            )
        )
        s.commit()
    sent = svc.tick() if req.watch else []
    return {**result, "notifications": [notification_json(n) for n in sent if n.plan_id == plan_id]}


@router.get("/plans")
def list_plans(svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        return [_summary(sp) for sp in s.scalars(select(SavedPlan).order_by(SavedPlan.created_at.desc()))]


@router.get("/plan/{plan_id}")
def get_plan(plan_id: str, svc: Services = Depends(get_services)):
    """The latest version of the plan (watched plans are re-planned by the scheduler)."""
    with svc.session_factory() as s:
        sp = s.get(SavedPlan, plan_id)
        if sp is None:
            raise HTTPException(404, "plan not found")
        return {**sp.result_json, "watch": sp.watch, "done": sp.done}


@router.delete("/plan/{plan_id}", status_code=204)
def delete_plan(plan_id: str, svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        if s.get(SavedPlan, plan_id) is None:
            raise HTTPException(404, "plan not found")
        s.execute(delete(Notification).where(Notification.plan_id == plan_id))
        s.execute(delete(SavedPlan).where(SavedPlan.id == plan_id))
        s.commit()
