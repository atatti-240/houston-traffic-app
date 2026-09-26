"""SQLAlchemy engine, session factory and declarative base."""

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite:///") and not url.endswith(":memory:"):
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=connect_args)


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db(bind: Engine | None = None) -> None:
    from app import models  # noqa: F401  (register tables)

    bind = bind or engine
    Base.metadata.create_all(bind)
    _add_missing_columns(bind)


# Columns added after the first release. create_all() never alters existing tables, so an
# app.db from an older checkout gets them here. (For anything bigger: `make seed` rebuilds.)
_ADDED_COLUMNS = {
    "trip_states": {"last_route": "VARCHAR"},
    "trips": {"safety_weight": "FLOAT"},
    "notifications": {"plan_id": "VARCHAR"},
}


def _add_missing_columns(bind: Engine) -> None:
    insp = inspect(bind)
    with bind.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            if not insp.has_table(table):
                continue
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
