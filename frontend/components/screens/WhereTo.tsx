"use client";

/** "Where to?": the start screen (design "Where to"). Search a place, see the traffic around you
 * in a small preview map, jump back to a recent trip, or just look at the traffic map. */

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp, type Recent } from "@/components/app/AppContext";
import ClientTrafficMap from "@/components/map/ClientTrafficMap";
import { Icon, LevelDot, Logo, PillButton } from "@/components/ui";
import { api } from "@/lib/api";
import { C, ICON, LEVEL, type Level } from "@/lib/theme";
import type { LatLngTuple, Location, Place } from "@/lib/types";

import { dataGeneration, tripLevel } from "./Trip/shared";

/** Places to offer before you've been anywhere (first ones that exist). */
const POPULAR = ["galleria", "medcenter", "downtown", "heights", "hobby"];
const ROW_LINE = "#22262F";
/** The design's search-result pin (a little rounder than ICON.pin). */
const PIN = "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z";

// ---- ETA per destination -------------------------------------------------------------------

type Eta = { min: number; level: Level } | { here: true } | { error: true };

/** Leave-now drive time from where you are to each destination, refreshed with live data. */
function useEtas(origin: string | undefined, dests: { key: string; to: Location }[], generation: number) {
  const [etas, setEtas] = useState<Record<string, Eta>>({});
  const asked = useRef(new Set<string>());
  const destsKey = dests.map((d) => `${d.key}=${JSON.stringify(d.to)}`).join("|");

  useEffect(() => {
    if (!origin) return;
    for (const d of dests) {
      const ask = `${origin}|${generation}|${d.key}`;
      if (asked.current.has(ask)) continue;
      asked.current.add(ask);
      if (d.to === origin) {
        setEtas((e) => ({ ...e, [d.key]: { here: true } }));
        continue;
      }
      api
        .route({ origin, destination: d.to })
        .then((r) => setEtas((e) => ({ ...e, [d.key]: { min: Math.max(1, Math.round(r.best.total_min)), level: tripLevel(r.best) } })))
        .catch(() => setEtas((e) => ({ ...e, [d.key]: { error: true } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, generation, destsKey]);

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

function SearchField({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <div className="flex h-14 items-center gap-3 rounded-2xl border border-edge bg-card px-[18px] focus-within:border-edge-strong">
      <Icon d={ICON.search} size={20} color={C.muted} />
      <label htmlFor="dest" className="sr-only">
        Search for a destination
      </label>
      <input
        id="dest"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          } else if (e.key === "Escape") onChange("");
        }}
        placeholder="Search a place or address"
        autoComplete="off"
        enterKeyHint="go"
        className="min-w-0 flex-1 border-0 bg-transparent text-[17px] text-ink outline-none placeholder:text-[#8A91A0]"
      />
    </div>
  );
}

function ResultRow({ p, eta, onPick }: { p: Place; eta: Eta | undefined; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full cursor-pointer items-center gap-3.5 border-b px-1 py-3.5 text-left text-ink hover:bg-card/50"
        style={{ borderColor: ROW_LINE }}
      >
        <Icon d={PIN} size={20} color={C.muted} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[16px] font-medium">{p.name}</span>
          {p.address && <span className="truncate text-[13px] text-muted">{p.address}</span>}
        </span>
        <EtaTag eta={eta} />
      </button>
    </li>
  );
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
  const { here } = useApp();
  const [close, setClose] = useState(false);
  const zoom = close ? 15 : 13;
  const center: LatLngTuple | null = here ? [here.lat, here.lng] : null;
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
        className="absolute top-2.5 right-2.5 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-edge bg-card"
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
        style={{ background: "rgba(17,19,24,0.94)" }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold">{here ? `You're in ${here.name}` : "Finding you…"}</span>
          <span className="truncate text-[12px] text-muted">{here?.street ?? " "}</span>
        </div>
        {here && (
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

export default function WhereTo() {
  const { places, here, recents, addRecent, go, slowdowns } = useApp();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const results = useMemo(
    () => (q ? places.filter((p) => `${p.name} ${p.address ?? ""}`.toLowerCase().includes(q)).slice(0, 5) : []),
    [places, q],
  );

  // Recent trips, or a few popular places before there are any.
  const list = useMemo<{ id: string; name: string; address?: string | null; to: Location }[]>(() => {
    if (recents.length) return recents.slice(0, 3).map((r: Recent) => ({ id: r.id, name: r.name, address: r.address, to: r.to }));
    const pop = POPULAR.map((id) => places.find((p) => p.id === id)).filter((p): p is Place => !!p && p.id !== here?.place);
    return pop.slice(0, 3).map((p) => ({ id: p.id, name: p.name, address: p.address, to: p.id }));
  }, [recents, places, here?.place]);

  const dests = useMemo(
    () => (q ? results.map((p) => ({ key: p.id, to: p.id as Location })) : list.map((r) => ({ key: r.id, to: r.to }))),
    [q, results, list],
  );
  const etas = useEtas(here?.place, dests, dataGeneration(slowdowns));

  const open = (r: { id: string; name: string; address?: string | null; to: Location }) => {
    addRecent({ id: r.id, name: r.name, address: r.address ?? null, to: r.to });
    go({ name: "trip", to: r.to, toName: r.name });
  };
  const pickPlace = (p: Place) => open({ id: p.id, name: p.name, address: p.address, to: p.id });

  return (
    <div className="flex min-h-full flex-col px-5 pt-[60px] pb-10 leading-[normal] md:pt-6 md:pb-6">
      <div className="flex flex-col gap-5">
        <Logo size={17} />
        <h1 className="m-0 mt-2 text-[40px] leading-none font-bold tracking-[-0.03em]">Where to?</h1>
        <SearchField value={query} onChange={setQuery} onEnter={() => results[0] && pickPlace(results[0])} />

        {q ? (
          <div className="flex flex-col">
            <ul className="m-0 flex list-none flex-col p-0" aria-label="Matching places">
              {results.map((p) => (
                <ResultRow key={p.id} p={p} eta={etas[p.id]} onPick={() => pickPlace(p)} />
              ))}
            </ul>
            {results.length === 0 && <span className="px-1 py-4 text-[14px] text-muted">No matching places in Houston yet.</span>}
          </div>
        ) : (
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
