"use client";

/**
 * The one place card: map dots, search results, saved places and the nearby list all use it.
 * Name and kind, the address, whether it's open ("Open now, closes 9 PM", with the week's hours),
 * phone and website from OpenStreetMap, a star to save it, Home / Work, and Directions.
 * When nothing is known about the place, it stays a name and a Directions button. No ratings.
 */

import { useState } from "react";

import { Icon } from "@/components/ui";
import { fmtTime, parseSim } from "@/lib/format";
import { C } from "@/lib/theme";
import type { PlaceHours, PlaceRef } from "@/lib/types";

import { usePlaceDetails } from "./details";
import { PLACE_ICON, STAR } from "./icons";
import { isFavorite, setSlot, slotOf, toggleFavorite, useSaved } from "./store";

export function StarButton({ place, size = 20 }: { place: PlaceRef; size?: number }) {
  const saved = useSaved();
  const on = isFavorite(saved, place);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleFavorite(place);
      }}
      aria-pressed={on}
      aria-label={on ? `Remove ${place.name} from favorites` : `Save ${place.name} to favorites`}
      title={on ? "Saved to favorites" : "Save to favorites"}
      className="-m-1.5 flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-card-hi"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path d={PLACE_ICON.star} fill={on ? STAR : "none"} stroke={on ? STAR : C.muted} strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function minutesBetween(a: string, b: string): number {
  return (parseSim(b).getTime() - parseSim(a).getTime()) / 60000;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Hours({ hours }: { hours: PlaceHours }) {
  const [open, setOpen] = useState(false);
  if (!hours.text || !hours.week) {
    // Too complex for us to read: show what the map data says.
    return (
      <div className="text-[13px] leading-snug text-soft">
        <span className="text-muted">Hours: </span>
        {hours.raw}
      </div>
    );
  }
  const color = hours.open ? C.light : C.heavyText;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 text-left text-[14px] font-medium"
        style={{ color }}
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
        <span className="min-w-0">{hours.text}</span>
        <Icon d={PLACE_ICON.down} size={14} color={C.muted} style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && (
        <table className="fade-in ml-3.5 border-collapse text-[12px] text-soft">
          <tbody>
            {hours.week.map((d) => (
              <tr key={d.day} style={d.day === hours.today ? { color: C.ink, fontWeight: 600 } : undefined}>
                <td className="py-px pr-3 align-top">{d.day}</td>
                <td className="py-px">{d.hours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface Props {
  place: PlaceRef;
  /** Shows the Directions button */
  onDirections?: () => void;
  /** Inside a screen that already shows the name (the Trip): no name row */
  compact?: boolean;
  /** "0.4 mi away", "0.2 mi off your route" */
  distance?: string;
  /** When you'd get there: warns when it's closed by then */
  arriveAt?: string | null;
}

export default function PlaceCard({ place, onDirections, compact, distance, arriveAt }: Props) {
  const saved = useSaved();
  const slot = slotOf(saved, place);
  const d = usePlaceDetails(place);
  const arrival = usePlaceDetails(arriveAt ? place : null, arriveAt);
  const details = d.status === "ok" ? d.details : null;
  const address = place.address || details?.address;
  const kind = place.kind || details?.kind;
  // At the time you'd get there: closed by then, or closing soon after.
  const then = arriveAt && arrival.status === "ok" ? arrival.details.hours : null;
  const closedOnArrival = then?.open === false && details?.hours?.open !== false ? then : null;
  const closingOnArrival =
    then?.open && then.closes_at && arriveAt && minutesBetween(arriveAt, then.closes_at) <= 20 ? then.closes_at : null;
  const cuisine = details?.cuisine && details.cuisine !== kind ? details.cuisine : null;

  return (
    <div className="flex min-w-0 flex-col gap-2 text-left" style={{ fontFamily: "var(--font-grotesk), system-ui, sans-serif" }}>
      {!compact && (
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {kind && (
              <div className="flex items-center gap-1.5">
                <span className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: place.color ?? C.muted }} aria-hidden="true" />
                <span className="truncate text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                  {kind}
                  {cuisine ? ` · ${cuisine}` : ""}
                </span>
              </div>
            )}
            <div className="text-[16px] leading-tight font-semibold text-ink">{place.name}</div>
          </div>
          <StarButton place={place} />
        </div>
      )}
      {(address || distance) && (
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 text-[13px] leading-snug text-muted">
            {address}
            {address && distance ? " · " : ""}
            {distance}
          </span>
          {compact && <StarButton place={place} size={18} />}
        </div>
      )}
      {compact && !address && !distance && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] text-muted">{kind ?? "Place"}</span>
          <StarButton place={place} size={18} />
        </div>
      )}

      {d.status === "loading" && <span className="h-4 w-44 animate-pulse rounded bg-card-hi" aria-label="Loading details" />}
      {d.status === "error" && <span className="text-[12px] text-muted">{d.message}</span>}
      {details?.hours && <Hours hours={details.hours} />}
      {closedOnArrival && (
        <span className="text-[13px] leading-snug font-medium" style={{ color: C.heavyText }}>
          When you get there at {fmtTime(arriveAt as string)}: {closedOnArrival.text ? closedOnArrival.text.charAt(0).toLowerCase() + closedOnArrival.text.slice(1) : "closed"}
        </span>
      )}
      {closingOnArrival && (
        <span className="text-[13px] leading-snug font-medium" style={{ color: C.moderate }}>
          Closes at {fmtTime(closingOnArrival)}, soon after you get there ({fmtTime(arriveAt as string)})
        </span>
      )}
      {(details?.phone || details?.website) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px]">
          {details.phone && (
            <a href={`tel:${details.phone.tel}`} className="flex items-center gap-1.5 font-medium" style={{ color: C.accent }}>
              <Icon d={PLACE_ICON.phone} size={15} />
              <span className="font-num">{details.phone.display}</span>
            </a>
          )}
          {details.website && (
            <a
              href={details.website}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 items-center gap-1.5 font-medium"
              style={{ color: C.accent }}
            >
              <Icon d={PLACE_ICON.globe} size={15} />
              <span className="truncate">{hostOf(details.website)}</span>
            </a>
          )}
        </div>
      )}

      {onDirections && (
        <button
          type="button"
          onClick={onDirections}
          className="mt-1 h-9 cursor-pointer rounded-[18px] border-0 text-[14px] font-semibold"
          style={{ background: C.accent, color: C.onAccent, fontFamily: "inherit" }}
        >
          Directions →
        </button>
      )}
      <div className="flex flex-wrap items-center gap-x-1 text-[12px] whitespace-nowrap text-muted">
        {slot ? (
          <span className="flex items-center gap-1.5">
            <Icon d={slot === "home" ? PLACE_ICON.home : PLACE_ICON.work} size={14} color={C.accent} />
            Saved as {slot === "home" ? "Home" : "Work"}
          </span>
        ) : (
          <>
            <span>Save as</span>
            {(["home", "work"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSlot(s, place)}
                className="cursor-pointer rounded-md px-1 py-0.5 font-medium hover:bg-card-hi"
                style={{ color: C.accent }}
              >
                {s === "home" ? "Home" : "Work"}
              </button>
            ))}
          </>
        )}
        {details && <span className="ml-auto text-[11px]">© OpenStreetMap</span>}
      </div>
    </div>
  );
}
