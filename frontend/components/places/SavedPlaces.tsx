"use client";

/** Home, Work and favorites on the Where to screen: quick chips that open the trip, and a small
 * editor to set, change or remove them. Kept in this browser only (no accounts). */

import type { ReactNode } from "react";

import { Icon } from "@/components/ui";
import { C } from "@/lib/theme";
import type { Location, PlaceRef } from "@/lib/types";

import { PLACE_ICON, STAR } from "./icons";
import { removeFavorite, setSlot, useSaved, type SavedPlace, type Slot } from "./store";

export const SLOT_LABEL: Record<Slot, string> = { home: "Home", work: "Work" };

/** Where a trip to a saved place goes: our own place id, or the point. */
export function savedTo(p: PlaceRef): Location {
  return p.placeId ?? { lat: p.lat, lng: p.lng };
}

function Chip({ icon, iconColor, children, onClick, dashed, label }: { icon: string; iconColor: string; children: ReactNode; onClick: () => void; dashed?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-10 max-w-[220px] shrink-0 cursor-pointer items-center gap-2 rounded-[20px] px-3.5 text-[14px] font-medium whitespace-nowrap text-ink hover:bg-card-hi"
      style={dashed ? { border: `1px dashed ${C.edgeStrong}`, color: C.soft } : { background: C.card, border: `1px solid ${C.card}` }}
    >
      <Icon d={icon} size={16} color={iconColor} />
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </button>
  );
}

/** The chips row. `eta` gives the drive time for Home / Work when known. */
export function SavedChips({
  onOpen,
  onSet,
  onEdit,
  eta,
}: {
  onOpen: (p: SavedPlace) => void;
  onSet: (slot: Slot) => void;
  onEdit: () => void;
  eta: (slot: Slot) => ReactNode;
}) {
  const saved = useSaved();
  return (
    <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5" role="group" aria-label="Saved places">
      {(["home", "work"] as const).map((slot) => {
        const p = saved[slot];
        const icon = slot === "home" ? PLACE_ICON.home : PLACE_ICON.work;
        return p ? (
          <Chip key={slot} icon={icon} iconColor={C.accent} onClick={() => onOpen(p)} label={`${SLOT_LABEL[slot]}: ${p.name}`}>
            {SLOT_LABEL[slot]}
            {eta(slot)}
          </Chip>
        ) : (
          <Chip key={slot} icon={icon} iconColor={C.muted} onClick={() => onSet(slot)} dashed>
            Set {SLOT_LABEL[slot].toLowerCase()}
          </Chip>
        );
      })}
      {saved.favorites.map((f) => (
        <Chip key={f.key} icon={PLACE_ICON.star} iconColor={STAR} onClick={() => onOpen(f)} label={`Favorite: ${f.name}`}>
          <span className="truncate">{f.name}</span>
        </Chip>
      ))}
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit saved places"
        title="Edit saved places"
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-card hover:text-ink"
      >
        <Icon d={PLACE_ICON.edit} size={17} />
      </button>
    </div>
  );
}

function Row({ icon, iconColor, title, sub, children }: { icon: string; iconColor: string; title: string; sub?: string | null; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 border-b py-2.5 last:border-b-0" style={{ borderColor: C.line }}>
      <Icon d={icon} size={18} color={iconColor} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-medium text-ink">{title}</span>
        {sub && <span className="truncate text-[12px] text-muted">{sub}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </li>
  );
}

function SmallButton({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 cursor-pointer rounded-2xl px-3 text-[13px] font-medium hover:bg-card-hi"
      style={{ color: danger ? C.heavyText : C.accent }}
    >
      {children}
    </button>
  );
}

/** Set / change / remove Home and Work, remove favorites. */
export function SavedEditor({ onSet, onDone }: { onSet: (slot: Slot) => void; onDone: () => void }) {
  const saved = useSaved();
  return (
    <section className="fade-in flex flex-col rounded-[18px] bg-card px-4 pt-3 pb-2" aria-labelledby="saved-h">
      <div className="flex items-center justify-between">
        <h2 id="saved-h" className="m-0 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">
          Saved places
        </h2>
        <button type="button" onClick={onDone} className="h-8 cursor-pointer rounded-2xl px-2 text-[14px] font-semibold text-accent">
          Done
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {(["home", "work"] as const).map((slot) => {
          const p = saved[slot];
          return (
            <Row
              key={slot}
              icon={slot === "home" ? PLACE_ICON.home : PLACE_ICON.work}
              iconColor={p ? C.accent : C.muted}
              title={SLOT_LABEL[slot]}
              sub={p ? [p.name, p.address].filter(Boolean).join(" · ") : "Not set"}
            >
              <SmallButton onClick={() => onSet(slot)}>{p ? "Change" : "Set"}</SmallButton>
              {p && (
                <SmallButton danger onClick={() => setSlot(slot, null)}>
                  Remove
                </SmallButton>
              )}
            </Row>
          );
        })}
        {saved.favorites.map((f) => (
          <Row key={f.key} icon={PLACE_ICON.star} iconColor={STAR} title={f.name} sub={f.address ?? f.kind}>
            <SmallButton danger onClick={() => removeFavorite(f.key)}>
              Remove
            </SmallButton>
          </Row>
        ))}
      </ul>
      {!saved.favorites.length && (
        <p className="m-0 pb-2 text-[13px] leading-snug text-muted">Tap the star on a place to keep it here. Favorites also show on the map.</p>
      )}
      <p className="m-0 pb-1.5 text-[11px] text-muted">Saved in this browser only.</p>
    </section>
  );
}
