"""Scripted live situations for the demo (mock data sources only).

"evening": a Monday around 5 PM with every kind of cause on the map at once, like the design:
rush hour, a concert at Toyota Center, a crash on the Gulf Fwy, a freight train in the East End,
lane closures on I-69 at Kirby, heavy rain on the West Loop and I-45 construction. Plus a few
driver reports (demo data, labeled "Demo report"): flooding on Westheimer into the Galleria, a
stalled car on the North Fwy, police on SH-288 and a pothole on Main St that one driver already
says is gone.
"""

from datetime import datetime, timedelta

from app.conditions.live import LiveTraffic

SCENARIOS = ("evening",)


def evening(sources, day: datetime) -> datetime:
    """Inject the evening scenario on `day`'s date; returns the time the clock should show."""
    at = lambda h, m=0: day.replace(hour=h, minute=m, second=0, microsecond=0)  # noqa: E731
    now = at(17, 0)
    sources.clear_demo_live()
    inc = sources.incidents
    inc.inject(
        "I45S:gulf_ee>i45_610s", "crash", "Multi-vehicle crash", at(16, 52), 75, lanes_blocked=2,
        detail="Two left lanes blocked. Reported at 4:52 PM; responders are on scene.",
    )
    inc.inject(
        "I10E:i10_610e>downtown", "event", "Concert at Toyota Center", at(16, 30), 210, lanes_blocked=2,
        detail="Doors open at 6:30 PM. Expect crowded streets and garages nearby until about 8 PM.",
    )
    inc.inject(
        "I69:i69_610sw>midtown", "lane_closure", "Two lanes closed", at(9), 12 * 60, lanes_blocked=2,
        detail="Scheduled lane closure for bridge repairs near Kirby Dr, listed until 9 PM.",
    )
    inc.inject(
        "L610W:i10_610w>i69_610sw", "weather", "Heavy rain and street flooding", at(16, 35), 120,
        detail="Water on the frontage road near Westheimer and drivers slowing on the main lanes. Avoid if you can.",
    )
    inc.inject(
        "I45N:downtown>i45_610n", "roadwork", "Freeway construction", at(6), 16 * 60,
        detail="Lane shifts and narrow shoulders from the long-term I-45 rebuild.",
    )
    sources.trains.inject("x_navigation", at(16, 56), 18)
    # A reading from the I-10 Katy camera (the one Live cams shows), so the camera sees it too.
    sources.live_traffic.inject(
        LiveTraffic("I10W:downtown>i10_610w", 0.85, "camera", now - timedelta(minutes=2), "high", "31 vehicles vs 19 usual")
    )
    return now


def add_reports(name: str, reports, now: datetime) -> None:
    """The driver reports that go with a scenario (replacing the demo's earlier ones)."""
    reports.clear(demo_only=True)
    if name != "evening":
        return
    at = lambda h, m=0: now.replace(hour=h, minute=m, second=0, microsecond=0)  # noqa: E731
    reports.add_demo(
        "flooding", "WHMR:i69_610sw>galleria", at(16, 44), still_there=3,
        note="Water over the curb by the mall entrance",
    )
    reports.add_demo("stalled", "I45N:i45_610n>i45_bw8n", at(16, 52), still_there=1)
    reports.add_demo("police", "SH288:midtown>tmc_288", at(16, 48), still_there=2)
    # One "not there" already: one more takes it down.
    reports.add_demo("pothole", "MAIN:midtown>medcenter", at(16, 20), not_there=1)


def run(name: str, sources, day: datetime) -> datetime:
    if name == "evening":
        return evening(sources, day)
    raise ValueError(f"unknown scenario {name!r}; try one of {', '.join(SCENARIOS)}")
