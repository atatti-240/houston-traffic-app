"use client";

/** "Where to?": the start screen (design "Where to"). Search our places and any Houston address or
 * business (OpenStreetMap), jump to Home, Work or a favorite, see the traffic around you in a small
 * preview map, go back to a recent trip, or just look at the traffic map. */

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp, type Recent } from "@/components/app/AppContext";
import ClientTrafficMap from "@/components/map/ClientTrafficMap";
import { StarButton } from "@/components/places/PlaceCard";
import { metersBetween, miles } from "@/components/places/pois";
import { SLOT_LABEL, SavedChips, SavedEditor, savedTo } from "@/components/places/SavedPlaces";
import { setSlot, useSaved, type SavedPlace, type Slot } from "@/components/places/store";
import { MIN_CHARS, useGeocode } from "@/components/places/useGeocode";
import { Icon, LevelDot, Logo, PillButton } from "@/components/ui";
import { api } from "@/lib/api";
import { routeChoices } from "@/lib/directions";
import { C, ICON, LEVEL, type Level } from "@/lib/theme";
import type { GeoResult, LatLngTuple, Location, Place, PlaceRef } from "@/lib/types";

import { dataGeneration, tripLevel } from "./Trip/shared";

/** Places to offer before you've been anywhere (first ones that exist). */
const POPULAR = ["galleria", "medcenter", "downtown", "heights", "hobby"];
const ROW_LINE = C.line;
/** Further than this from the nearest named place, Where to says how far instead of "Near" it */
const NEAR_M = 3000;
/** The design's search-result pin (a little rounder than ICON.pin). */
const PIN = "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z";

// ---- ETA per destination -------------------------------------------------------------------

type Eta = { min: number; level: Level } | { here: true } | { error: true };

/** Leave-now drive time from where you are to each destination, refreshed with live data. To or from a point
 * (the device, a dropped pin) it's door to door, like the trip it opens. */
function useEtas(origin: Location | undefined, dests: { key: string; to: Location }[], generation: number) {
  const [etas, setEtas] = useState<Record<string, Eta>>({});
  const asked = useRef(new Set<string>());
  const latest = useRef<Record<string, string>>({}); // an older answer (e.g. from before the device's location came) doesn't win
  const destsKey = dests.map((d) => `${d.key}=${JSON.stringify(d.to)}`).join("|");
  const from = JSON.stringify(origin ?? null);

  useEffect(() => {
    if (origin === undefined) return;
    for (const d of dests) {
      const ask = `${from}|${generation}|${d.key}`;
      if (asked.current.has(ask)) continue;
      asked.current.add(ask);
      latest.current[d.key] = ask;
      const set = (eta: Eta) => {
        if (latest.current[d.key] === ask) setEtas((e) => ({ ...e, [d.key]: eta }));
      };
      if (JSON.stringify(d.to) === from) {
        set({ here: true });
        continue;
      }
      const body = { origin, destination: d.to };
      const trip = typeof origin === "string" && typeof d.to === "string" ? api.route(body) : routeChoices(body);
      trip
        .then((r) => set({ min: Math.max(1, Math.round(r.best.total_min)), level: tripLevel(r.best) }))
        .catch(() => set({ error: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, generation, destsKey]);

  return etas;
}

function EtaTag({ eta }: { eta: Eta | undefined }) {
  if (!eta) return <span className="font-num h-4 w-12 shrink-0 animate-pulse rounded bg-card" aria-hidden="true" />;
  if ("here" in eta) return <span className="shrink-0 text-[13px] text-muted">You&apos;re here</span>;
  if ("error" in eta) return <span className="font-num shrink-0 text-[13px] text-muted">—</span>;
  return (
    <span
      className="font-num flex shrink-0 items-center gap-1.5 text-[13px] whitespace-nowrap text-soft"
      title={`${LEVEL[eta.level].label} traffic`}
    >
      <LevelDot level={eta.level} />
      {eta.min} min
    </span>
  );
}

// ---- pieces ------------------------------------------------------------------------------------

function SearchField({
  value,
  onChange,
  onEnter,
  placeholder = "Search a place or address",
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex h-14 items-center gap-3 rounded-2xl border border-edge bg-card px-[18px] focus-within:border-edge-strong">
      <Icon d={ICON.search} size={20} color={C.muted} />
      <label htmlFor="dest" className="sr-only">
        Search for a destination
      </label>
      <input
        id="dest"
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape") onChange("");
        }}
        placeholder={placeholder}
        autoComplete="off"
        enterKeyHint="go"
        className="min-w-0 flex-1 border-0 bg-transparent text-[17px] text-ink outline-none placeholder:text-muted"
      />
    </div>
  );
}

/** A search result row: the row opens it, the star (beside it, not inside) saves it. */
function ResultShell({ onPick, star, children }: { onPick: () => void; star?: PlaceRef; children: React.ReactNode }) {
  return (
    <li className="flex items-center border-b" style={{ borderColor: ROW_LINE }}>
      <button type="button" onClick={onPick} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 px-1 py-3.5 text-left text-ink hover:bg-card/50">
        {children}
      </button>
      {star && (
        <span className="pr-1.5 pl-1">
          <StarButton place={star} size={18} />
        </span>
      )}
    </li>
  );
}

function ResultRow({ p, eta, onPick, star }: { p: Place; eta: Eta | undefined; onPick: () => void; star?: boolean }) {
  return (
    <ResultShell onPick={onPick} star={star ? ourRef(p) : undefined}>
      <Icon d={PIN} size={20} color={C.muted} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[16px] font-medium">{p.name}</span>
        {p.address && <span className="truncate text-[13px] text-muted">{p.address}</span>}
      </span>
      <EtaTag eta={eta} />
    </ResultShell>
  );
}

function GeoRow({ r, onPick, star }: { r: GeoResult; onPick: () => void; star?: boolean }) {
  const mi = r.distance_km !== null ? r.distance_km / 1.609344 : null;
  return (
    <ResultShell onPick={onPick} star={star ? geoRef(r) : undefined}>
      <Icon d={PIN} size={20} color={C.muted} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[16px] font-medium">{r.name}</span>
        <span className="truncate text-[13px] text-muted">{[r.kind !== "Address" ? r.kind : null, r.address].filter(Boolean).join(" · ")}</span>
      </span>
      {mi !== null && (
        <span className="font-num shrink-0 text-[13px] whitespace-nowrap text-soft">{mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi</span>
      )}
    </ResultShell>
  );
}

function ourRef(p: Place): PlaceRef {
  return { name: p.name, lat: p.lat, lng: p.lng, placeId: p.id, address: p.address, kind: "Area" };
}

function geoRef(r: GeoResult): PlaceRef {
  return { name: r.name, lat: r.lat, lng: r.lng, osm: r.id, address: r.address, kind: r.kind };
}

/** Our own place that a search result stands for (the same name, within ~300 m). */
function isOurs(r: GeoResult, places: Place[]): boolean {
  return places.some((p) => p.name.toLowerCase() === r.name.toLowerCase() && Math.abs(p.lat - r.lat) < 0.003 && Math.abs(p.lng - r.lng) < 0.003);
}

function RecentRow({ name, eta, onPick }: { name: string; eta: Eta | undefined; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full cursor-pointer items-center gap-3.5 border-b py-3.5 text-left text-ink hover:bg-card/50"
        style={{ borderColor: ROW_LINE }}
      >
        <Icon d={ICON.clock} size={20} color={C.muted} />
        <span className="min-w-0 flex-1 truncate text-[16px] font-medium">{name}</span>
        <EtaTag eta={eta} />
      </button>
    </li>
  );
}

function HereCard() {
  const { here, places } = useApp();
  const [close, setClose] = useState(false);
  const zoom = close ? 15 : 13;
  const center: LatLngTuple | null = here ? [here.lat, here.lng] : null;
  // From the device, the nearest named place is only there for context ("Near Midtown", "12 mi from Energy Corridor").
  const base = here?.fromDevice ? places.find((p) => p.id === here.place) : undefined;
  const away = base && here ? metersBetween([here.lat, here.lng], [base.lat, base.lng]) : 0;
  const title = !here
    ? "Finding you…"
    : !here.fromDevice
      ? `You're in ${here.name}`
      : away > NEAR_M
        ? `${miles(away)} from ${here.name}`
        : `Near ${here.name}`;
  return (
    <div className="relative isolate h-[262px] overflow-hidden rounded-[20px] border border-line bg-map">
      {center ? (
        // The map stops at the caption bar so "you" sits in the middle of what's visible. Inert: just a
        // picture, so its attribution links stay out of the tab order (the main map shows them).
        <div className="absolute inset-x-0 top-0 bottom-14 z-0" inert aria-hidden="true">
          <ClientTrafficMap interactive={false} center={center} zoom={zoom} />
        </div>
      ) : (
        <div className="absolute inset-0 animate-pulse bg-map" />
      )}
      <button
        type="button"
        aria-label={close ? "Show more of the area" : "Center on my location"}
        aria-pressed={close}
        onClick={() => setClose(!close)}
        className="absolute top-2.5 right-2.5 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-float shadow-e1"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke={C.accent}
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="1.5" fill={C.accent} />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </button>
      <div
        className="absolute inset-x-0 bottom-0 z-10 flex h-14 items-center gap-3 border-t border-line px-3.5"
        style={{ background: C.bg }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold">{title}</span>
          <span className="truncate text-[12px] text-muted">{here ? (here.fromDevice ? here.startName : here.street) : " "}</span>
        </div>
        {/* The traffic on our roads around that place: not "nearby" when you're miles from it */}
        {here && away <= NEAR_M && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-xl bg-card px-2.5 py-[5px] text-[12px] font-medium whitespace-nowrap text-soft">
            <LevelDot level={here.level} />
            {LEVEL[here.level].label} nearby
          </span>
        )}
      </div>
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------------

type Row = { id: string; name: string; address?: string | null; to: Location; osm?: string | null; kind?: string | null };

export default function WhereTo() {
  const { places, here, recents, addRecent, go, slowdowns } = useApp();
  const saved = useSaved();
  const [query, setQuery] = useState("");
  // Choosing a place for Home or Work: a picked result is saved instead of opened.
  const [picking, setPicking] = useState<Slot | null>(null);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const results = useMemo(
    () => (q ? places.filter((p) => `${p.name} ${p.address ?? ""}`.toLowerCase().includes(q)).slice(0, 5) : []),
    [places, q],
  );
  // Any address or business in Houston (OpenStreetMap), after our own places.
  const near = useMemo(() => (here ? { lat: here.lat, lng: here.lng } : null), [here?.lat, here?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  const [attempt, setAttempt] = useState(0);
  const geo = useGeocode(query, near, attempt);
  const geoResults = (geo.status === "ok" || geo.status === "loading" ? geo.results : []).filter((r) => !isOurs(r, results));

  // Recent trips, or a few popular places before there are any.
  const list = useMemo<Row[]>(() => {
    if (recents.length) return recents.slice(0, 3).map((r: Recent) => ({ id: r.id, name: r.name, address: r.address, to: r.to, osm: r.osm, kind: r.kind }));
    const pop = POPULAR.map((id) => places.find((p) => p.id === id)).filter((p): p is Place => !!p && p.id !== here?.place);
    return pop.slice(0, 3).map((p) => ({ id: p.id, name: p.name, address: p.address, to: p.id }));
  }, [recents, places, here?.place]);

  const dests = useMemo(() => {
    if (q) return results.map((p) => ({ key: p.id, to: p.id as Location }));
    // Keyed by the place too: a new Home gets its own drive time.
    const slots = (["home", "work"] as const).flatMap((s) => {
      const p = saved[s];
      return p ? [{ key: `saved:${s}:${p.key}`, to: savedTo(p) }] : [];
    });
    return [...slots, ...list.map((r) => ({ key: r.id, to: r.to }))];
  }, [q, results, list, saved]);
  const etas = useEtas(here?.start, dests, dataGeneration(slowdowns));

  const open = (r: Row) => {
    addRecent({ id: r.id, name: r.name, address: r.address ?? null, to: r.to, osm: r.osm ?? null, kind: r.kind ?? null });
    go({
      name: "trip",
      to: r.to,
      toName: r.name,
      toPlace: typeof r.to === "string" ? undefined : { osm: r.osm ?? null, address: r.address ?? null, kind: r.kind ?? null },
    });
  };
  // Opening, or saving as Home / Work while picking.
  const choose = (ref: PlaceRef, row: Row) => {
    if (!picking) return open(row);
    setSlot(picking, ref);
    setPicking(null);
    setQuery("");
  };
  const pickPlace = (p: Place) => choose(ourRef(p), { id: p.id, name: p.name, address: p.address, to: p.id });
  const pickGeo = (r: GeoResult) =>
    choose(geoRef(r), { id: r.id ? `osm:${r.id}` : `${r.lat},${r.lng}`, name: r.name, address: r.address, to: { lat: r.lat, lng: r.lng }, osm: r.id, kind: r.kind });
  const openSaved = (p: SavedPlace) => open({ id: `saved:${p.key}`, name: p.name, address: p.address, to: savedTo(p), osm: p.osm, kind: p.kind });
  const startPicking = (slot: Slot) => {
    setPicking(slot);
    setEditing(false);
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const onEnter = () => {
    if (results[0]) pickPlace(results[0]);
    else if (geoResults[0]) pickGeo(geoResults[0]);
  };

  const slotEta = (slot: Slot) => {
    const e = etas[`saved:${slot}:${saved[slot]?.key}`];
    if (!e || "error" in e) return null;
    if ("here" in e) return <span className="text-[12px] text-muted">· here</span>;
    return (
      <span className="font-num flex items-center gap-1 text-[12px] text-soft">
        <LevelDot level={e.level} size={6} />
        {e.min} min
      </span>
    );
  };

  const searching = q.length >= MIN_CHARS;
  const nothing = searching && !results.length && !geoResults.length;

  return (
    <div className="flex min-h-full flex-col px-5 pt-[60px] pb-10 leading-[normal] md:pt-6 md:pb-6">
      <div className="flex flex-col gap-5">
        <Logo size={17} />
        <h1 className="m-0 mt-2 text-[40px] leading-none font-bold tracking-[-0.03em]">{picking ? `Set ${SLOT_LABEL[picking].toLowerCase()}` : "Where to?"}</h1>
        {picking && (
          <div className="-mt-2 flex items-center justify-between gap-3 text-[14px] text-soft">
            <span>Search for your {picking === "home" ? "home" : "work"} address or place.</span>
            <button type="button" onClick={() => setPicking(null)} className="cursor-pointer font-medium text-accent">
              Cancel
            </button>
          </div>
        )}
        <SearchField
          value={query}
          onChange={setQuery}
          onEnter={onEnter}
          inputRef={inputRef}
          placeholder={picking ? `Your ${picking} address` : "Search a place or address"}
        />
        {picking && here?.fromDevice && !q && (
          <button
            type="button"
            onClick={() => {
              // Not `here.street`: that's the nearest named place's address, not this spot's.
              setSlot(picking, { name: "My location", lat: here.lat, lng: here.lng, address: `Near ${here.name}` });
              setPicking(null);
            }}
            className="-mt-2 flex cursor-pointer items-center gap-2 text-left text-[15px] font-medium text-accent"
          >
            <Icon d={ICON.locate} size={18} />
            Use where I am now
          </button>
        )}
        {!q && !picking && (
          <SavedChips onOpen={openSaved} onSet={startPicking} onEdit={() => setEditing(!editing)} eta={slotEta} />
        )}
        {!q && !picking && editing && <SavedEditor onSet={startPicking} onDone={() => setEditing(false)} />}

        {q ? (
          <div className="flex flex-col">
            <ul className="m-0 flex list-none flex-col p-0" aria-label="Matching places">
              {results.map((p) => (
                <ResultRow key={p.id} p={p} eta={etas[p.id]} onPick={() => pickPlace(p)} star={!picking} />
              ))}
              {geoResults.map((r) => (
                <GeoRow key={r.id ?? `${r.lat},${r.lng}`} r={r} onPick={() => pickGeo(r)} star={!picking} />
              ))}
            </ul>
            <div className="flex flex-col gap-1 px-1 py-3 text-[14px] text-muted" aria-live="polite">
              {!searching && !results.length && <span>Keep typing to search any address or business in Houston.</span>}
              {searching && geo.status === "loading" && (
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                  Searching Houston…
                </span>
              )}
              {geo.status === "error" && (
                <span style={{ color: C.moderateText }}>
                  {geo.message}
                  {results.length ? " Our own places still work." : ""}{" "}
                  <button type="button" onClick={() => setAttempt((n) => n + 1)} className="cursor-pointer font-medium text-accent">
                    Try again
                  </button>
                </span>
              )}
              {geo.status === "ok" && geo.stale && (
                <span>
                  Search isn&apos;t answering, so these are saved results.{" "}
                  <button type="button" onClick={() => setAttempt((n) => n + 1)} className="cursor-pointer font-medium text-accent">
                    Try again
                  </button>
                </span>
              )}
              {nothing && geo.status === "ok" && <span>No places found in the Houston area.</span>}
              {searching && geo.status !== "error" && <span className="text-[11px]">Search by OpenStreetMap (Nominatim)</span>}
            </div>
          </div>
        ) : picking ? null : (
          <div className="flex flex-col gap-6">
            <HereCard />
            <section className="flex flex-col" aria-labelledby="recent-h">
              <h2 id="recent-h" className="m-0 mb-1 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">
                Recent
              </h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {list.map((r) => (
                  <RecentRow key={r.id} name={r.name} eta={etas[r.id]} onPick={() => open(r)} />
                ))}
                {!list.length &&
                  [0, 1, 2].map((i) => (
                    <li key={i} className="flex items-center gap-3.5 border-b py-3.5" style={{ borderColor: ROW_LINE }} aria-hidden="true">
                      <span className="h-5 w-5 rounded-full bg-card" />
                      <span className="h-4 w-40 animate-pulse rounded bg-card" />
                    </li>
                  ))}
              </ul>
            </section>
          </div>
        )}
      </div>

      <div className="mt-auto pt-8">
        <PillButton variant="ghost" className="w-full gap-2.5" style={{ fontSize: 15 }} onClick={() => go({ name: "map" })}>
          <Icon d={ICON.map} size={20} />
          Just show me traffic
        </PillButton>
      </div>
    </div>
  );
}
