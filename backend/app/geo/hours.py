"""Opening hours from OpenStreetMap's `opening_hours` tag, as "Open now, closes 9 PM".

Handles the common forms: `24/7`, `Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off`, several spans a
day (`11:00-14:00,17:00-22:00`), hours past midnight (`Fr-Sa 18:00-02:00`) and holiday rules
(`PH off`, skipped: we don't know the holidays). Anything fancier (months, sunrise, week numbers,
comments, open-ended times) parses to None and the app shows the tag's text as it is.

Times are naive Houston wall-clock times, like everywhere else in the app.
"""

import re
from datetime import date, datetime, timedelta

# Per weekday (Monday = 0): open spans in minutes after that day's midnight. An end past 24:00
# runs into the next day.
Week = list[list[tuple[int, int]]]

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_DAYS = {
    "mo": 0, "mon": 0, "tu": 1, "tue": 1, "tues": 1, "we": 2, "wed": 2, "th": 3, "thu": 3, "thur": 3,
    "thurs": 3, "fr": 4, "fri": 4, "sa": 5, "sat": 5, "su": 6, "sun": 6,
}
_HOLIDAYS = {"ph", "sh"}
_RULE = re.compile(r"^(?:(?P<days>[a-z]{2,5}(?:\s*[-,]\s*[a-z]{2,5})*)\s*:?\s+)?(?P<rest>off|closed|\d.*)$")
_SPAN = re.compile(r"^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$")
_SOON = timedelta(minutes=60)


class _Skip(Exception):
    """A rule for holidays only."""


def _days(sel: str) -> set[int]:
    out: set[int] = set()
    holiday = False
    for part in sel.split(","):
        ends = [p.strip() for p in part.split("-")]
        if len(ends) == 1 and ends[0] in _HOLIDAYS:
            holiday = True
            continue
        if len(ends) > 2 or any(e not in _DAYS for e in ends):
            raise ValueError(part)
        a, b = _DAYS[ends[0]], _DAYS[ends[-1]]
        d = a
        while True:  # Fr-Mo wraps around the week
            out.add(d)
            if d == b:
                break
            d = (d + 1) % 7
    if not out and holiday:
        raise _Skip
    return out


def _spans(sel: str) -> list[tuple[int, int]]:
    if sel.strip() == "24/7":  # as one rule among others: "24/7; PH off"
        return [(0, 24 * 60)]
    out = []
    for part in sel.split(","):
        m = _SPAN.match(part.strip())
        if not m:
            raise ValueError(part)
        h1, m1, h2, m2 = map(int, m.groups())
        if h1 > 24 or h2 > 48 or m1 > 59 or m2 > 59:
            raise ValueError(part)
        start, end = h1 * 60 + m1, h2 * 60 + m2
        if end <= start:
            end += 24 * 60  # 18:00-02:00: closes after midnight
        out.append((start, end))
    return sorted(out)


def _split_rules(raw: str) -> list[str]:
    """Rules are separated by ";". Some mappers use ", " between rules too ("Mo-Fr 08:00-17:00,
    Sa 09:00-12:00"): a comma that follows a time or "off" and starts a new day list."""
    rules: list[str] = []
    for chunk in raw.replace("||", ";").split(";"):
        cur = ""
        for piece in chunk.split(","):
            p = piece.strip()
            done = bool(re.search(r"(\d|off|closed)$", cur))
            if cur and done and re.match(r"[a-z]{2}", p):
                rules.append(cur)
                cur = p
            else:
                cur = f"{cur},{p}" if cur else p
        if cur:
            rules.append(cur)
    return rules


def parse(raw: str | None) -> Week | None:
    """The weekly schedule, or None when the tag is empty or too complex for us."""
    if not raw:
        return None
    s = re.sub(r"\s+", " ", re.sub(r"[‐-―−]", "-", raw)).strip().strip(";").strip().lower()
    if s == "24/7":
        return [[(0, 24 * 60)] for _ in range(7)]
    week: Week = [[] for _ in range(7)]
    found = False
    for rule in _split_rules(s):
        m = _RULE.match(rule)
        if not m:
            return None
        try:
            days = _days(m["days"]) if m["days"] else set(range(7))
            spans = [] if m["rest"] in ("off", "closed") else _spans(m["rest"])
        except _Skip:
            continue
        except ValueError:
            return None
        for d in days:
            week[d] = spans  # a later rule replaces an earlier one for its days
        found = True
    return week if found else None


def clock(minutes: int) -> str:
    """Minutes after midnight -> "9 AM", "9:30 PM", "12 AM"."""
    h, m = divmod(minutes % (24 * 60), 60)
    suffix = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    return f"{h12} {suffix}" if m == 0 else f"{h12}:{m:02d} {suffix}"


def _clock_at(t: datetime) -> str:
    return clock(t.hour * 60 + t.minute)


def _intervals(week: Week, start: date, days: int) -> list[tuple[datetime, datetime]]:
    """Open intervals over `days` days from `start`, merged where they touch."""
    out: list[tuple[datetime, datetime]] = []
    for i in range(days):
        day = start + timedelta(days=i)
        midnight = datetime.combine(day, datetime.min.time())
        for s, e in week[day.weekday()]:
            out.append((midnight + timedelta(minutes=s), midnight + timedelta(minutes=e)))
    out.sort()
    merged: list[tuple[datetime, datetime]] = []
    for s, e in out:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def _when(t: datetime, now: datetime) -> str:
    """"9 PM" today (or just after midnight), "9 AM tomorrow", else "Mon 9 AM"."""
    days = (t.date() - now.date()).days
    if days == 0 or (days == 1 and t.hour < 6):
        return _clock_at(t)
    if days == 1:
        return f"{_clock_at(t)} tomorrow"
    return f"{DAY_NAMES[t.weekday()]} {_clock_at(t)}"


def status(week: Week, now: datetime) -> dict:
    """Whether it's open at `now` and the line to show: "Open now, closes 9 PM",
    "Closed, opens 7 AM tomorrow", "Open 24 hours"."""
    start = now.date() - timedelta(days=1)
    spans = _intervals(week, start, 9)
    horizon = datetime.combine(start + timedelta(days=9), datetime.min.time())
    for s, e in spans:
        if s <= now < e:
            if s <= datetime.combine(start, datetime.min.time()) and e >= horizon:
                return {"open": True, "text": "Open 24 hours", "closes_at": None, "opens_at": None}
            if e - now >= timedelta(hours=24):
                text = "Open 24 hours today"
            elif e - now <= _SOON:
                text = f"Closing soon, at {_when(e, now)}"
            else:
                text = f"Open now, closes {_when(e, now)}"
            return {"open": True, "text": text, "closes_at": e.isoformat(), "opens_at": None}
    nxt = next((s for s, _ in spans if s > now), None)
    if nxt is None:
        return {"open": False, "text": "Closed", "closes_at": None, "opens_at": None}
    text = f"Opens soon, at {_when(nxt, now)}" if nxt - now <= _SOON else f"Closed, opens {_when(nxt, now)}"
    return {"open": False, "text": text, "closes_at": None, "opens_at": nxt.isoformat()}


def day_text(spans: list[tuple[int, int]]) -> str:
    if not spans:
        return "Closed"
    if spans == [(0, 24 * 60)]:
        return "Open 24 hours"
    return ", ".join(f"{clock(s)}–{clock(e)}" for s, e in spans)


def hours_json(raw: str | None, now: datetime) -> dict | None:
    """What the place card shows. `week` and `open` are None when we couldn't read the tag
    (then the card shows `raw`)."""
    if not raw:
        return None
    week = parse(raw)
    if week is None:
        return {"raw": raw, "open": None, "text": None, "closes_at": None, "opens_at": None, "week": None, "today": None}
    return {
        "raw": raw,
        **status(week, now),
        "week": [{"day": DAY_NAMES[d], "hours": day_text(week[d])} for d in range(7)],
        "today": DAY_NAMES[now.weekday()],
    }
