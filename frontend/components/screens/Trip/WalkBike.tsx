"use client";

/** Walk / Bike tab: time, distance and simple turn-by-turn steps from OpenStreetMap routing.
 * Leaves now (simulated clock); no traffic, no predictions. */

import { useEffect, useState } from "react";

import { useApp, type MapPoint } from "@/components/app/AppContext";
import { Card, Icon } from "@/components/ui";
import { addMinutesSim, fmtDayTime, fmtTime } from "@/lib/format";
import { fmtDistance, fmtMinutes, stepIcon, travelApi, type LatLng, type WalkBikeRoute } from "@/lib/modes";
import { C } from "@/lib/theme";

import { BigLine, canRetry, describeError, ErrorLine, Loading, sheetPadding } from "./modeParts";

/** Past these, suggest another way to go. */
const LONG_MIN = { walk: 60, bike: 90 };

export default function WalkBike({
  mode,
  start,
  end,
  fromName,
  toName,
}: {
  mode: "walk" | "bike";
  start: LatLng;
  end: LatLng;
  fromName: string;
  toName: string;
}) {
  const { clock, setScene, isDesktop } = useApp();
  const key = JSON.stringify({ mode, start, end });
  const [res, setRes] = useState<{ key: string; route?: WalkBikeRoute; error?: string; canRetry?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    travelApi.walkBike({ mode, origin: start, destination: end }).then(
      (route) => live && setRes({ key, route }),
      (e: unknown) => live && setRes({ key, error: describeError(e), canRetry: canRetry(e) }),
    );
    return () => {
      live = false;
    };
    // `key` covers mode / start / end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);

  const current = res?.key === key ? res : null;
  const route = current?.route;

  // The map: the route (dotted for a walk), start and end. Before it arrives, just the two ends.
  useEffect(() => {
    const points: MapPoint[] = [
      { ...start, kind: "start", label: fromName },
      { ...end, kind: "end", label: toName },
    ];
    setScene({
      modeRoute: route ? { lines: [{ kind: mode, positions: route.geometry }] } : undefined,
      points,
      fit: route ? route.geometry : points.map((p) => [p.lat, p.lng]),
      fitPadding: sheetPadding(isDesktop),
      markers: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, isDesktop, key, fromName, toName]);

  if (!current) return <Loading />;
  if (!route)
    return (
      <ErrorLine
        message={current.error ?? "Something went wrong."}
        onRetry={
          current.canRetry
            ? () => {
                setRes(null);
                setRetry((n) => n + 1);
              }
            : undefined
        }
      />
    );

  const minutes = route.duration_s / 60;
  const arrive = clock ? addMinutesSim(clock.now, minutes) : route.arrive_at;
  const otherDay = clock && arrive.slice(0, 10) !== clock.now.slice(0, 10);
  const noun = mode === "walk" ? "walk" : "bike ride";

  return (
    <>
      <BigLine title={fmtMinutes(minutes)} aside={<span className="text-[15px] text-soft">{mode === "walk" ? "walking" : "by bike"}</span>}>
        <span className="text-[14px] text-soft">
          Leave now · arrive <span className="font-num">{otherDay ? fmtDayTime(arrive) : fmtTime(arrive)}</span> ·{" "}
          <span className="font-num">{fmtDistance(route.distance_m)}</span>
        </span>
        {minutes > LONG_MIN[mode] && (
          <span className="text-[13px]" style={{ color: C.moderate }}>
            That&apos;s a long {noun}. {mode === "walk" ? "Bike or Transit" : "Transit or Drive"} may suit better.
          </span>
        )}
      </BigLine>

      <Card>
        <h2 className="m-0 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">Directions</h2>
        <ol className="m-0 flex list-none flex-col p-0">
          {route.steps.map((s, i) => (
            <li key={i} className={`flex items-start gap-3 py-2.5 ${i ? "border-t border-line" : ""}`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card-hi" aria-hidden="true">
                <Icon d={stepIcon(s)} size={16} color={s.type === "arrive" ? C.heavy : C.soft} />
              </span>
              <span className="min-w-0 flex-1 pt-1 text-[14px] leading-snug text-ink">{s.instruction}</span>
              {s.distance_m > 0 && <span className="font-num shrink-0 pt-1 text-[13px] text-muted">{fmtDistance(s.distance_m)}</span>}
            </li>
          ))}
        </ol>
      </Card>
      <p className="m-0 text-[12px] leading-snug text-muted">
        Route from OpenStreetMap (© OpenStreetMap contributors), routed by FOSSGIS. Times assume a steady pace, with no traffic or
        live conditions.
      </p>
    </>
  );
}
