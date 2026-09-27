"use client";

/** Trip screen road rules: the Avoid tolls / highways toggles (from the link's `avoid` param, else
 * what this device chose last) and the route card's speed limit and toll road line. */

import { useState } from "react";

import { FilterChip, Icon } from "@/components/ui";
import { SpeedLimitSign } from "@/components/ui/SpeedLimitSign";
import { mainRoads, parseAvoid, storeAvoid, storedAvoid, type Avoid, type RoadLimit } from "@/lib/roadrules";
import { C } from "@/lib/theme";
import type { Route } from "@/lib/types";

/** A coin with a dollar sign (24x24 stroke path, like lib/theme's icons). */
const TOLL_ICON =
  "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM14.8 9.2c-.5-.8-1.5-1.3-2.8-1.3-1.6 0-2.8.8-2.8 2 0 2.6 5.6 1.4 5.6 4.1 0 1.2-1.2 2-2.8 2-1.3 0-2.4-.5-2.9-1.4M12 6.3v1.6M12 16v1.7";

/** The avoid options for the trip on screen. They start over from the link (or the remembered
 * choice) when the screen's params change, like the rest of the Trip inputs. */
export function useAvoid(fromLink: string | undefined, paramsKey: string): [Avoid, (a: Avoid) => void] {
  const initial = () => parseAvoid(fromLink) ?? storedAvoid();
  const [avoid, setAvoid] = useState<Avoid>(initial);
  const [seen, setSeen] = useState(paramsKey);
  if (seen !== paramsKey) {
    setSeen(paramsKey);
    setAvoid(initial());
  }
  const change = (a: Avoid) => {
    setAvoid(a);
    storeAvoid(a);
  };
  return [avoid, change];
}

export function AvoidToggles({ value, onChange }: { value: Avoid; onChange: (a: Avoid) => void }) {
  return (
    <div role="group" aria-label="Avoid" className="flex items-center gap-2">
      <span className="mr-1 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase" aria-hidden="true">
        Avoid
      </span>
      <FilterChip label="Tolls" selected={value.tolls} onClick={() => onChange({ ...value, tolls: !value.tolls })} />
      <FilterChip label="Highways" selected={value.highways} onClick={() => onChange({ ...value, highways: !value.highways })} />
    </div>
  );
}

/** "Speed limit 60 on I-69 Southwest Fwy · 35 on Westheimer Rd", "Speed limit 60 on I-10 Katy Fwy and
 * I-45 North Fwy", "... · not known on Main St". */
function limitsText(roads: RoadLimit[]): string {
  const groups: { mph: number | null; roads: string[] }[] = [];
  for (const r of roads) {
    const g = groups.find((x) => x.mph === r.mph);
    if (g) g.roads.push(r.road);
    else groups.push({ mph: r.mph, roads: [r.road] });
  }
  return groups
    .map((g, i) => `${i === 0 ? "Speed limit " : ""}${g.mph === null ? "not known" : g.mph} on ${g.roads.join(g.mph === null ? " or " : " and ")}`)
    .join(" · ");
}

/** The posted limits on the two roads a route is mostly on, and "Uses toll road". Nothing for a
 * route from an older backend without these fields. */
export function RouteRules({ route }: { route: Pick<Route, "speed_limits" | "uses_toll" | "toll_roads"> }) {
  const roads = mainRoads(route.speed_limits ?? []);
  if (!roads.length && !route.uses_toll) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] leading-snug text-soft">
      {roads.length > 0 && (
        <span className="flex min-w-0 items-start gap-2">
          <span className="-mt-0.5 shrink-0">
            <SpeedLimitSign mph={roads[0].mph} size={18} mini />
          </span>
          <span className="min-w-0">{limitsText(roads)}</span>
        </span>
      )}
      {route.uses_toll && <TollLine roads={route.toll_roads} />}
    </div>
  );
}

export function TollLine({ roads, small = false }: { roads?: string[]; small?: boolean }) {
  return (
    <span
      className={`flex items-center gap-1.5 font-medium ${small ? "text-[12px]" : "text-[13px]"}`}
      style={{ color: C.moderate }}
      title={roads?.length ? roads.join(", ") : undefined}
    >
      <Icon d={TOLL_ICON} size={small ? 14 : 16} />
      Uses toll road
    </span>
  );
}
