"""App settings, read from environment variables with hackathon-friendly defaults."""

import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


@dataclass
class Settings:
    database_url: str = field(
        default_factory=lambda: os.environ.get(
            "DATABASE_URL", f"sqlite:///{BACKEND_DIR / 'data' / 'app.db'}"
        )
    )
    # Which DataSource implementations to use. Only "mock" exists today.
    data_source: str = field(default_factory=lambda: os.environ.get("DATA_SOURCE", "mock"))
    # Deterministic seed for the synthetic generator.
    synthetic_seed: int = field(default_factory=lambda: int(os.environ.get("SYNTHETIC_SEED", "42")))
    history_weeks: int = field(default_factory=lambda: int(os.environ.get("HISTORY_WEEKS", "8")))
    # Simulated "now" the app boots with (a Monday morning, so rush hour is on screen).
    sim_start: datetime = field(
        default_factory=lambda: datetime.fromisoformat(
            os.environ.get("SIM_START", "2026-09-28T07:15:00")
        )
    )
    # Simulated clock runs at this multiple of real time (0 = frozen).
    clock_speed: float = field(default_factory=lambda: float(os.environ.get("CLOCK_SPEED", "1")))
    # Nudge factors (EMA alpha) per model.
    congestion_alpha: float = 0.2
    crash_alpha: float = 0.1
    train_alpha: float = 0.2
    # Background scheduler loop period in real seconds (0 disables it).
    scheduler_interval_s: float = field(
        default_factory=lambda: float(os.environ.get("SCHEDULER_INTERVAL_S", "30"))
    )
    notification_channel: str = field(
        default_factory=lambda: os.environ.get("NOTIFICATION_CHANNEL", "mock")
    )
    # Address and business search (OpenStreetMap's free geocoder). Point it at your own
    # Nominatim for heavier use: the public one allows 1 request per second.
    nominatim_url: str = field(
        default_factory=lambda: os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
    )
    cors_origins: list[str] = field(
        default_factory=lambda: os.environ.get(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
    )
    # Live AI camera feeds from the team's computer-vision app (blindspot-cv). Empty = off.
    cv_url: str = field(default_factory=lambda: os.environ.get("CV_URL", "").strip().rstrip("/"))
    # Which CV camera stands in for which of our cameras: "<cv camera>=<our camera id>,...".
    cv_cameras: str = field(
        default_factory=lambda: os.environ.get(
            "CV_CAMERAS", "007=cam_I45S_downtown_gulf_ee,009=cam_I10W_downtown_i10_610w"
        )
    )
    # follow: the CV app processes the camera someone is watching (else the first mapped one);
    # all: every camera (heavy); off: never change what the CV app is doing.
    cv_view: str = field(default_factory=lambda: os.environ.get("CV_VIEW", "follow").strip().lower())
    # The video plays this far behind real time so the vehicle boxes line up with the cars.
    cv_video_delay_s: float = field(default_factory=lambda: float(os.environ.get("CV_VIDEO_DELAY_S", "2.5")))
    # A camera-confirmed incident clears once the camera has seen a clear road this long.
    cv_clear_after_s: float = field(default_factory=lambda: float(os.environ.get("CV_CLEAR_AFTER_S", "120")))


settings = Settings()
