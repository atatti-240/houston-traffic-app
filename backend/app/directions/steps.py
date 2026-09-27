"""Turn-by-turn steps from an OSRM route: plain instructions, road names and lane arrows.

OSRM gives each step a maneuver (type + modifier), the road's name and ref, exit numbers and
signposted destinations, but no instruction text: we write it here. Every step comes out as

    {"instruction": "Turn left onto Westheimer Rd", "distance_m": 420, "duration_s": 51,
     "maneuver": {"type": "turn", "modifier": "left", "location": [lat, lng],
                  "bearing_before": 90, "bearing_after": 0, "exit": None},
     "road": "Westheimer Rd",
     "lanes": [{"valid": True, "indications": ["left"]}, ...]}   # only where OSM has turn lanes

(frontend/lib/types.ts RouteStep documents the same shape). Names are OpenStreetMap text, so
the UI must render them as text.
"""

import re

WORDS = {
    "Street": "St",
    "Road": "Rd",
    "Avenue": "Ave",
    "Boulevard": "Blvd",
    "Drive": "Dr",
    "Parkway": "Pkwy",
    "Freeway": "Fwy",
    "Expressway": "Expy",
    "Highway": "Hwy",
    "Lane": "Ln",
    "Court": "Ct",
    "Place": "Pl",
    "Circle": "Cir",
}
_WORDS_RE = re.compile(r"\b(" + "|".join(WORDS) + r")\b")
_REF_RE = re.compile(r"\b(I|US|TX|SH|FM|BW|SL|CR|Spur|Loop) (\d+[A-Z]?)\b")
# Names that read better after their route number: "I-45 Gulf Fwy", "I-610 South Loop East".
_HIGHWAY_RE = re.compile(r"Freeway|Fwy|Expressway|Expy|Tollway|Beltway|Loop|Turnpike")

HEADINGS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]
SIDES = {
    "left": "left",
    "slight left": "left",
    "sharp left": "left",
    "right": "right",
    "slight right": "right",
    "sharp right": "right",
}


def short_name(name: str | None) -> str:
    """'Westheimer Road' -> 'Westheimer Rd'."""
    return _WORDS_RE.sub(lambda m: WORDS[m.group(1)], (name or "").strip())


def fmt_ref(ref: str | None) -> str:
    """'I 45' -> 'I-45', 'I 69; US 59' -> 'I-69/US-59'."""
    parts = [_REF_RE.sub(r"\1-\2", p.strip()) for p in (ref or "").split(";") if p.strip()]
    return "/".join(parts)


def road_name(name: str | None, ref: str | None) -> str:
    """How a road reads in an instruction: 'Westheimer Rd', 'I-45 Gulf Fwy', 'I-45'."""
    name, ref = short_name(name), fmt_ref(ref)
    if name and ref and (ref.startswith("I-") or _HIGHWAY_RE.search(name)) and ref not in name:
        return f"{ref} {name}"
    return name or ref


def toward(destinations: str | None, limit: int = 2) -> str:
    """Signposted destinations, short: 'St Joseph Pkwy, Pease St'."""
    items: list[str] = []
    for part in re.split(r"[,:;]", destinations or ""):
        item = short_name(fmt_ref(part.strip()))
        if item and item not in items:
            items.append(item)
    return ", ".join(items[:limit])


def _heading(deg: float | None) -> str:
    return HEADINGS[int(((deg or 0) + 22.5) // 45) % 8]


def _onto(road: str) -> str:
    return f" onto {road}" if road else ""


def instruction(step: dict) -> str:
    """Plain-English instruction for one OSRM step."""
    m = step.get("maneuver", {})
    kind, mod = m.get("type", ""), m.get("modifier") or ""
    road = road_name(step.get("name"), step.get("ref"))
    dest = toward(step.get("destinations"))
    to = f" toward {dest}" if dest else ""
    side = SIDES.get(mod, "")
    exits = (step.get("exits") or "").split(";")[0].strip()

    if kind == "depart":
        return f"Head {_heading(m.get('bearing_after'))}" + (f" on {road}" if road else "")
    if kind == "arrive":
        return f"Arrive at your destination, on the {side}" if side else "Arrive at your destination"
    if kind in ("roundabout", "rotary"):
        n = m.get("exit")
        where = f"At {short_name(step.get('rotary_name'))}" if step.get("rotary_name") else "At the roundabout"
        nth = f"take the {ORDINALS[n - 1]} exit" if isinstance(n, int) and 0 < n <= len(ORDINALS) else "take the exit"
        return f"{where}, {nth}{_onto(road)}"
    if kind == "roundabout turn":
        return f"At the roundabout, turn {side or 'straight'}{_onto(road)}"
    if kind in ("exit roundabout", "exit rotary"):
        return f"Exit the roundabout{_onto(road)}"
    if kind == "off ramp":
        what = f"exit {exits}" if exits else "the exit"
        on = f" on the {side}" if side == "left" else ""
        return f"Take {what}{on}{to or _onto(road)}"
    if kind == "on ramp":
        on = f" on the {side}" if side == "left" else ""
        return f"Take the ramp{on}{to or _onto(road)}"
    if kind == "fork":
        return f"Keep {side or 'straight'} at the fork{to or _onto(road)}"
    if kind == "merge":
        return f"Merge onto {road}" if road else f"Merge {side}".strip()
    if kind == "end of road":
        return f"At the end of the road, turn {side or 'straight'}{_onto(road)}"
    if kind == "new name":
        return f"Continue onto {road}" if road else "Continue"
    if kind in ("continue", "notification", "use lane"):
        if mod == "uturn":
            return f"Make a U-turn{_onto(road)}"
        if side and kind == "continue":
            verb = "Keep" if mod.startswith("slight") else "Turn"
            return f"{verb} {side} to stay on {road}" if road else f"{verb} {side}"
        return f"Continue on {road}" if road else "Continue straight"
    # "turn" and anything newer OSRM may send
    if mod == "uturn":
        return f"Make a U-turn{_onto(road)}"
    if mod == "straight" or not side:
        return f"Continue straight{_onto(road)}"
    if mod.startswith("slight"):
        return f"Bear {side}{_onto(road) or to}"
    if mod.startswith("sharp"):
        return f"Turn sharp {side}{_onto(road) or to}"
    return f"Turn {side}{_onto(road) or to}"


def lanes(step: dict) -> list[dict] | None:
    """Lane arrows at the maneuver, left to right: only when OSM has turn lanes there and they
    say something (some lanes work for this maneuver, some don't)."""
    first = (step.get("intersections") or [{}])[0]
    raw = first.get("lanes") or []
    out = [{"valid": bool(ln.get("valid")), "indications": list(ln.get("indications") or ["none"])} for ln in raw]
    if not out or all(ln["valid"] for ln in out) or not any(ln["valid"] for ln in out):
        return None
    return out


def build_step(step: dict) -> dict:
    m = step.get("maneuver", {})
    loc = m.get("location") or [0.0, 0.0]
    out = {
        "instruction": instruction(step),
        "distance_m": round(float(step.get("distance") or 0.0), 1),
        "duration_s": round(float(step.get("duration") or 0.0), 1),
        "maneuver": {
            "type": m.get("type", ""),
            "modifier": m.get("modifier"),
            "location": [round(loc[1], 6), round(loc[0], 6)],
            "bearing_before": m.get("bearing_before", 0),
            "bearing_after": m.get("bearing_after", 0),
            "exit": m.get("exit"),
        },
        "road": road_name(step.get("name"), step.get("ref")),
    }
    ln = lanes(step)
    if ln:
        out["lanes"] = ln
    return out


def build_steps(legs: list[dict]) -> list[dict]:
    """Steps for a whole route. Legs are joined without the "arrive" / "depart" between them."""
    out: list[dict] = []
    for i, leg in enumerate(legs):
        raw = leg.get("steps") or []
        for j, st in enumerate(raw):
            kind = st.get("maneuver", {}).get("type")
            if kind == "arrive" and i < len(legs) - 1:
                continue
            if kind == "depart" and i > 0:
                continue
            out.append(build_step(st))
    return out


def corridor_step(name: str, location: list[float], distance_m: float, duration_s: float, first: bool) -> dict:
    """A step along our own roads, when OSRM only gave us the way on and off them."""
    return {
        "instruction": f"{'Follow' if first else 'Continue onto'} {name}",
        "distance_m": round(distance_m, 1),
        "duration_s": round(duration_s, 1),
        "maneuver": {
            "type": "continue" if first else "new name",
            "modifier": "straight",
            "location": [round(location[0], 6), round(location[1], 6)],
            "bearing_before": 0,
            "bearing_after": 0,
            "exit": None,
        },
        "road": name,
    }
