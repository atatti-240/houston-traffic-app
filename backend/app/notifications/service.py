"""Notification channels. Mock stores in the DB (the frontend polls it); WebPush is a stub."""

from abc import ABC, abstractmethod
from datetime import datetime

from sqlalchemy.orm import Session

from app.models import Notification, Trip


class NotificationService(ABC):
    @abstractmethod
    def send(
        self, session: Session, trip: Trip | None, kind: str, title: str, body: str, at: datetime
    ) -> Notification: ...


class MockNotificationService(NotificationService):
    def send(self, session, trip, kind, title, body, at):
        n = Notification(trip_id=trip.id if trip else None, created_at=at, kind=kind, title=title, body=body)
        session.add(n)
        session.flush()
        return n


class WebPushNotificationService(MockNotificationService):
    """Stores like the mock and would also push to the trip's device.

    TODO: generate VAPID keys, store browser PushSubscription JSON per device_id
    (POST /devices), and send with pywebpush.webpush(subscription, payload, vapid_private_key=...).
    """

    def send(self, session, trip, kind, title, body, at):
        n = super().send(session, trip, kind, title, body, at)
        # TODO: webpush(...) to trip.device_id's subscription
        return n


def build_notifier(kind: str) -> NotificationService:
    if kind == "mock":
        return MockNotificationService()
    if kind == "webpush":
        return WebPushNotificationService()
    raise ValueError(f"Unknown NOTIFICATION_CHANNEL {kind!r}")
