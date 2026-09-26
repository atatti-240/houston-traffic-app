"""SQLAlchemy models. See ARCHITECTURE.md "Data model"."""

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    # Named places show up in the frontend origin/destination picker.
    is_place: Mapped[bool] = mapped_column(Boolean, default=False)


class RoadSegment(Base):
    """One direction of travel between two nodes."""

    __tablename__ = "road_segments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    highway: Mapped[str] = mapped_column(String)
    road_class: Mapped[str] = mapped_column(String)  # "freeway" | "arterial"
    direction: Mapped[str] = mapped_column(String)  # N/S/E/W/NE/...
    from_node: Mapped[str] = mapped_column(ForeignKey("nodes.id"))
    to_node: Mapped[str] = mapped_column(ForeignKey("nodes.id"))
    length_m: Mapped[float] = mapped_column(Float)
    free_flow_mph: Mapped[float] = mapped_column(Float)
    geometry: Mapped[list] = mapped_column(JSON)  # [[lat, lng], ...]

    @property
    def length_miles(self) -> float:
        return self.length_m / 1609.344

    @property
    def free_flow_seconds(self) -> float:
        return self.length_miles / self.free_flow_mph * 3600


class RailCrossing(Base):
    __tablename__ = "rail_crossings"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    rail_line: Mapped[str] = mapped_column(String)
    # The crossing sits on both directions of a road; this is the "forward" segment id.
    segment_id: Mapped[str] = mapped_column(ForeignKey("road_segments.id"))
    reverse_segment_id: Mapped[str] = mapped_column(ForeignKey("road_segments.id"))


class Camera(Base):
    __tablename__ = "cameras"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String)  # "highway" | "train"
    name: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    url: Mapped[str] = mapped_column(String)
    segment_id: Mapped[str | None] = mapped_column(ForeignKey("road_segments.id"), nullable=True)
    crossing_id: Mapped[str | None] = mapped_column(ForeignKey("rail_crossings.id"), nullable=True)


class ScoreEntry(Base):
    """One EMA score for (model, entity, time bucket)."""

    __tablename__ = "score_entries"
    __table_args__ = (UniqueConstraint("model", "entity_id", "bucket"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    model: Mapped[str] = mapped_column(String, index=True)
    entity_id: Mapped[str] = mapped_column(String)
    bucket: Mapped[str] = mapped_column(String)
    value: Mapped[float] = mapped_column(Float)
    # Model-specific secondary EMA (train model: average blocked minutes when blocked).
    aux: Mapped[float | None] = mapped_column(Float, nullable=True)
    n_obs: Mapped[int] = mapped_column(Integer, default=0)


class Trip(Base):
    """A saved commute the scheduler watches."""

    __tablename__ = "trips"
    __table_args__ = {"sqlite_autoincrement": True}  # never reuse ids after a demo reset

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String)
    origin: Mapped[str] = mapped_column(String)  # node id
    destination: Mapped[str] = mapped_column(String)  # node id
    arrive_by: Mapped[str] = mapped_column(String)  # "HH:MM"
    days: Mapped[str] = mapped_column(String, default="0,1,2,3,4")  # weekday numbers, Mon=0
    safe_path: Mapped[bool] = mapped_column(Boolean, default=False)
    # 0 = fastest ... 1 = safest. None = derive from safe_path (older rows).
    safety_weight: Mapped[float | None] = mapped_column(Float, nullable=True)
    device_id: Mapped[str | None] = mapped_column(String, nullable=True)

    @property
    def weight(self) -> float:
        if self.safety_weight is not None:
            return self.safety_weight
        return 1.0 if self.safe_path else 0.0

    @property
    def day_list(self) -> list[int]:
        return [int(d) for d in self.days.split(",") if d.strip()]


class TripState(Base):
    """What the scheduler last told a trip's owner on a given day."""

    __tablename__ = "trip_states"
    __table_args__ = (UniqueConstraint("trip_id", "day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id"))
    day: Mapped[date] = mapped_column(Date)
    last_departure: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_route: Mapped[str | None] = mapped_column(String, nullable=True)
    leave_now_sent: Mapped[bool] = mapped_column(Boolean, default=False)


class SavedPlan(Base):
    """A multi-stop plan (POST /plan). Watched plans are re-planned by the scheduler."""

    __tablename__ = "saved_plans"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    device_id: Mapped[str | None] = mapped_column(String, nullable=True)
    request_json: Mapped[dict] = mapped_column(JSON)  # app.plan_io.request_to_json
    result_json: Mapped[dict] = mapped_column(JSON)  # docs/contracts/plan_result.json shape
    watch: Mapped[bool] = mapped_column(Boolean, default=False)
    announced: Mapped[bool] = mapped_column(Boolean, default=False)
    leave_now_sent: Mapped[list] = mapped_column(JSON, default=list)  # leg indexes alerted
    held: Mapped[bool | None] = mapped_column(Boolean, default=False)  # "Hold on" sent; don't defer again
    done: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    last_planned_at: Mapped[datetime] = mapped_column(DateTime)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = {"sqlite_autoincrement": True}  # never reuse ids after a demo reset

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id"), nullable=True)
    plan_id: Mapped[str | None] = mapped_column(ForeignKey("saved_plans.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)  # simulated time
    kind: Mapped[str] = mapped_column(String)  # "leave_now" | "leave_earlier" | "info"
    title: Mapped[str] = mapped_column(String)
    body: Mapped[str] = mapped_column(String)
