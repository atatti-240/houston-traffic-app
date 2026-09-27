"""Live AI camera feeds (CV_URL): the CV app's status, a camera's live state, its video and frames.

The video is MJPEG (multipart/x-mixed-replace), so a plain <img> shows it from any origin. It
plays `video_delay_ms` behind real time: by then the vehicle boxes for each frame have arrived,
and the card can draw them on the right cars (GET /cv/cameras/{id} gives each box set with the
time of its frame on the same clock).
"""

import asyncio
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app.api.deps import get_services
from app.cv.bridge import CvBridge
from app.services import Services

router = APIRouter(tags=["cameras"])

MAX_STREAM_S = 30 * 60  # a forgotten tab stops streaming after this (the card reconnects)
STREAM_IDLE_S = 15.0  # no new frame for this long: the feed stopped, end the stream
BOUNDARY = "frame"
# Set when the server is told to stop: open video streams end, or it would wait for them forever.
CLOSING = threading.Event()

OFF = "Live AI camera feeds are off. Set CV_URL to the CV app's address (see README, Live AI camera feeds)."


def _mapped(svc: Services, camera_id: str) -> CvBridge:
    if svc.cv is None:
        raise HTTPException(404, OFF)
    if camera_id not in svc.cv.by_camera:
        if camera_id not in svc.cv.cameras:
            raise HTTPException(404, f"unknown camera {camera_id!r} (see GET /cameras)")
        raise HTTPException(404, f"no live AI feed for camera {camera_id!r} (see CV_CAMERAS)")
    return svc.cv


@router.get("/cv/status")
def cv_status(svc: Services = Depends(get_services)):
    """Is the CV app connected, which of its cameras stand in for which of ours, what it's
    processing, whether its incident check is on, and the camera-confirmed incidents."""
    if svc.cv is None:
        return {
            "enabled": False,
            "connected": False,
            "error": OFF,
            "cameras": [],
            "incidents": [],
            "incidents_key": "",
        }
    return svc.cv.status()


@router.get("/cv/cameras/{camera_id}")
def cv_camera(camera_id: str, since: float | None = None, svc: Services = Depends(get_services)):
    """One of our cameras' live AI feed: status, vehicle counts, rough speed (flowing / slow /
    stopped), the incident check and the recent vehicle boxes (only those after `since`, epoch
    ms, when given). Watching it (polling this or the video) makes the CV app process this
    camera when CV_VIEW=follow."""
    bridge = _mapped(svc, camera_id)
    bridge.touch(camera_id)
    return bridge.detail(camera_id, since_ms=since)


@router.get("/cv/cameras/{camera_id}/frame.jpg")
def cv_frame(camera_id: str, at: float | None = None, svc: Services = Depends(get_services)):
    """One video frame: the newest, or the buffered one nearest `at` (epoch milliseconds, the
    clock of the detections' `t`), e.g. to hold the picture a paused card shows."""
    bridge = _mapped(svc, camera_id)
    bridge.touch(camera_id)
    frame = bridge.frame(camera_id, None if at is None else at / 1000)
    if frame is None:
        raise HTTPException(503, "no live video from this camera right now")
    return Response(frame.jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/cv/cameras/{camera_id}/video")
async def cv_video(camera_id: str, request: Request, svc: Services = Depends(get_services)):
    """The live video as MJPEG, `video_delay_ms` behind real time. 503 while the feed isn't live;
    the stream ends when the feed stops."""
    bridge = _mapped(svc, camera_id)
    if not bridge.is_live(camera_id):
        raise HTTPException(503, "the live video isn't running right now")

    async def parts():
        started = last = time.monotonic()
        sent = None
        while time.monotonic() - started < MAX_STREAM_S and not CLOSING.is_set():
            if await request.is_disconnected():
                return
            bridge.touch(camera_id)
            frame = bridge.frame(camera_id, time.time() - bridge.video_delay_s, before=True)
            if frame is not None and frame.seq != sent:
                sent, last = frame.seq, time.monotonic()
                head = f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame.jpeg)}\r\n\r\n"
                yield head.encode() + frame.jpeg + b"\r\n"
            elif time.monotonic() - last > STREAM_IDLE_S:
                return
            await asyncio.sleep(1 / 30)

    return StreamingResponse(
        parts(),
        media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
