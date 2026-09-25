"""EMA score store: an in-memory dict persisted to the score_entries table.

Every model writes through `ema()`, which is the whole "nudge factor" idea:

    score = score + alpha * (observation - score)

The first observation for a key initializes the score (or it starts from `prior`).
"""

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import ScoreEntry


@dataclass
class Entry:
    value: float
    aux: float | None = None
    n_obs: int = 0


def ema_step(current: float, observation: float, alpha: float) -> float:
    return current + alpha * (observation - current)


class ScoreStore:
    def __init__(self) -> None:
        self._data: dict[tuple[str, str, str], Entry] = {}

    def get(self, model: str, entity_id: str, bucket: str) -> Entry | None:
        return self._data.get((model, entity_id, bucket))

    def ema(
        self,
        model: str,
        entity_id: str,
        bucket: str,
        observation: float,
        alpha: float,
        prior: float | None = None,
    ) -> Entry:
        key = (model, entity_id, bucket)
        entry = self._data.get(key)
        if entry is None:
            if prior is None:
                entry = self._data[key] = Entry(observation, n_obs=1)
                return entry
            entry = self._data[key] = Entry(prior)
        entry.value = ema_step(entry.value, observation, alpha)
        entry.n_obs += 1
        return entry

    def ema_aux(self, model: str, entity_id: str, bucket: str, observation: float, alpha: float) -> None:
        """Secondary EMA on an existing entry (initialized by its first observation)."""
        entry = self._data[(model, entity_id, bucket)]
        entry.aux = observation if entry.aux is None else ema_step(entry.aux, observation, alpha)

    def items(self, model: str):
        for (m, entity_id, bucket), entry in self._data.items():
            if m == model:
                yield entity_id, bucket, entry

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)

    def load(self, session: Session) -> "ScoreStore":
        self._data = {
            (e.model, e.entity_id, e.bucket): Entry(e.value, e.aux, e.n_obs)
            for e in session.scalars(select(ScoreEntry))
        }
        return self

    def save(self, session: Session) -> None:
        session.execute(delete(ScoreEntry))
        session.execute(
            ScoreEntry.__table__.insert(),
            [
                {"model": m, "entity_id": eid, "bucket": b, "value": e.value, "aux": e.aux, "n_obs": e.n_obs}
                for (m, eid, b), e in self._data.items()
            ],
        )
        session.commit()
