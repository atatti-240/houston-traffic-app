"""Driver reports: report a crash, police, hazard, pothole, stalled car or flooding; see the
ones that are up; say whether they're still there. See app/reports.py for the rules."""

import math
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import get_services
from app.causes import BOUND, CausesEngine
from app.graph import Network
from app.reports import (
    DEMO_DRIVERS,
    HEADS_UP_ONLY,
    KINDS,
    NOTE_MAX,
    DriverReport,
    ReportKindId,
    Snap,
    flooded_other_way,
    in_houston,
    nearest_place,
    provenance,
)
from app.services import Services
from app.timeutil import iso

router = APIRouter(tags=["reports"])


class ReportIn(BaseModel):
    kind: ReportKindId
    lat: float
    lng: float
    note: str = Field("", max_length=NOTE_MAX, description="Optional detail, one line")
    segment_id: str | None = Field(
        None, max_length=100, description="The road direction it's on (GET /reports/snap offers both); default: the nearest"
    )


class VoteIn(BaseModel):
    still_there: bool


def _client(request: Request, svc: Services) -> str:
    return svc.reports.client(request.client.host if request.client else None)


def _houston(lat: float, lng: float) -> None:
    if not (math.isfinite(lat) and math.isfinite(lng) and in_houston(lat, lng)):
        raise HTTPException(422, "Reports have to be in the Houston area")


def _too_many(wait: float | None, what: str) -> None:
    if wait:
        minutes = max(1, math.ceil(wait / 60))
        raise HTTPException(
            429, f"Too many {what} from here. Try again in {minutes} min.", headers={"Retry-After": str(math.ceil(wait))}
        )


def road_name(network: Network, segment_id: str | None) -> tuple[str | None, str | None]:
    """("Westheimer Rd westbound", "I-69 / 610 West to Galleria / Uptown") for a road direction."""
    seg = network.segments.get(segment_id) if segment_id else None
    if seg is None:
        return None, None
    ends = [network.nodes[n].name.removeprefix(f"{seg.name} @ ") for n in (seg.from_node, seg.to_node)]
    return f"{seg.name} {BOUND.get(seg.direction, '')}".strip(), f"{ends[0]} to {ends[1]}"


def _delays(svc: Services, rows: list[DriverReport]) -> tuple[dict[int, int], set[int]]:
    """Minutes each report adds to its road right now (as Why it's slow splits it), and the
    reports that add nothing because another incident on the same road slows it more (a road
    counts its worst incident)."""
    rows = [r for r in rows if r.segment_id in svc.network.segments and r.kind not in HEADS_UP_ONLY]
    if not rows:
        return {}, set()
    engine = CausesEngine(svc.router)
    delays: dict[int, int] = {}
    outweighed: set[int] = set()
    for sid in {r.segment_id for r in rows}:
        causes = [c for c in engine.analyze(svc.network.segments[sid]).causes if c.incident_id]
        for r in rows:
            if r.segment_id != sid:
                continue
            mine = next((c for c in causes if c.incident_id == f"report-{r.id}"), None)
            if mine is not None:
                delays[r.id] = round(mine.seconds / 60)
            elif causes:
                outweighed.add(r.id)
    return delays, outweighed


def report_json(
    svc: Services, r: DriverReport, now: datetime, mine: str | None = None, effect: tuple[dict, set] = ({}, set())
) -> dict:
    kind = KINDS[r.kind]
    on_road = r.segment_id if r.segment_id in svc.network.segments else None
    road, place = road_name(svc.network, on_road)
    return {
        "id": r.id,
        "kind": r.kind,
        "label": kind.label,
        "title": kind.title,
        "lat": r.pin_lat,
        "lng": r.pin_lng,
        "segment_id": on_road,
        # Flooding: the other direction, flooded too where it runs right there
        "also_on": flooded_other_way(svc.network, r),
        "road": road,
        "place": place or f"Near {nearest_place(svc.network, r.lat, r.lng)}",
        "note": r.note,
        "created_at": iso(r.created_at),
        "expires_at": iso(r.expires_at),
        "still_there": r.still_there,
        "not_there": r.not_there,
        "provenance": provenance(r, now),
        "source": r.source,
        "demo": r.source == DEMO_DRIVERS,
        # Changes routes: on one of our roads, and a kind that slows it down.
        "affects_routing": on_road is not None and r.kind not in HEADS_UP_ONLY,
        "delay_min": effect[0].get(r.id),
        # Adds nothing right now: another incident on the same road slows it more.
        "outweighed": r.id in effect[1],
        "mine": mine,
    }


def snap_json(svc: Services, sn: Snap) -> dict:
    road, place = road_name(svc.network, sn.segment_id)
    return {"segment_id": sn.segment_id, "road": road, "place": place, "lat": sn.lat, "lng": sn.lng}


@router.get("/reports")
def list_reports(request: Request, svc: Services = Depends(get_services)):
    """Driver reports that are up right now, newest first: where, what it does to its road
    (`delay_min`, `affects_routing`) and how you stand on it (`mine`: reported / still_there /
    not_there)."""
    now = svc.clock.now()
    rows = svc.reports.active(now)
    mine = svc.reports.mine([r.id for r in rows], _client(request, svc))
    effect = _delays(svc, rows)
    return {"generated_at": iso(now), "items": [report_json(svc, r, now, mine.get(r.id), effect) for r in rows]}


@router.get("/reports/snap")
def snap(lat: float, lng: float, svc: Services = Depends(get_services)):
    """Where a report at this point would go: the road direction it snaps to (and the other
    direction, to switch to), or `on_road: false` when no road we know is close."""
    _houston(lat, lng)
    sn = svc.reports.snap(lat, lng)
    if sn.segment_id is None:
        return {"on_road": False, **snap_json(svc, sn), "place": f"Near {nearest_place(svc.network, lat, lng)}", "ambiguous": False, "other": None}
    try:
        # The other direction, when it runs here too (one-way pairs can be a block apart).
        other = svc.reports.snap(lat, lng, sn.reverse_id) if sn.reverse_id else None
    except ValueError:
        other = None
    return {"on_road": True, **snap_json(svc, sn), "ambiguous": sn.ambiguous, "other": snap_json(svc, other) if other else None}


@router.post("/reports", status_code=201)
def create_report(
    body: ReportIn, request: Request, response: Response, background: BackgroundTasks, svc: Services = Depends(get_services)
):
    """Report something on the road at a point (your location or a spot on the map). Near one of
    our roads it snaps to it and counts for routing; far from them it's a pin. The same kind
    already reported right there counts as a "still there" instead (200, `merged: true`).
    At most 6 reports per 10 min from one client."""
    _houston(body.lat, body.lng)
    try:
        sn = svc.reports.snap(body.lat, body.lng, body.segment_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    client = _client(request, svc)
    _too_many(svc.reports.report_limit.hit(client), "reports")
    now = svc.clock.now()
    r, merged = svc.reports.create(body.kind, body.lat, body.lng, body.note, client, now, sn)
    if merged:
        response.status_code = 200
    # Re-check saved trips and watched plans: a crash or flood can change their route.
    background.add_task(svc.tick, True)
    mine = svc.reports.mine([r.id], client).get(r.id)
    return {"report": report_json(svc, r, now, mine, _delays(svc, [r])), "merged": merged}


@router.post("/reports/{report_id}/vote")
def vote(
    report_id: Annotated[int, Path(ge=1, le=2**63 - 1)],  # SQLite's integer range
    body: VoteIn,
    request: Request,
    background: BackgroundTasks,
    svc: Services = Depends(get_services),
):
    """Still there (keeps it up longer) or not there (two more of those than "still there" take
    it down; the reporter's own "not there" withdraws it). One vote per client per report:
    voting again changes your vote."""
    client = _client(request, svc)
    _too_many(svc.reports.vote_limit.hit(client), "votes")
    now = svc.clock.now()
    r = svc.reports.vote(report_id, client, body.still_there, now)
    if r is None:
        raise HTTPException(404, "That report is no longer up")
    background.add_task(svc.tick, True)
    if r.removed_at is not None:
        return {"removed": True, "report": None}
    mine = svc.reports.mine([r.id], client).get(r.id)
    return {"removed": False, "report": report_json(svc, r, now, mine, _delays(svc, [r]))}
