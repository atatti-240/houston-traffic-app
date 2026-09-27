"""Avoid tolls / avoid highways on route, recommend, plan and saved-trip requests."""

from pydantic import BaseModel, Field

from app.routing.avoid import Avoid


class AvoidIn(BaseModel):
    avoid_tolls: bool = Field(False, description="Stay off toll roads when there's another way")
    avoid_highways: bool = Field(False, description="Stay off freeways when there's another way")

    @property
    def avoid(self) -> Avoid:
        return Avoid(self.avoid_tolls, self.avoid_highways)
