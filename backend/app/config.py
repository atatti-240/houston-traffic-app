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
    cors_origins: list[str] = field(
        default_factory=lambda: os.environ.get(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
    )


settings = Settings()
