"use client";

/** Causes tab: what drivers reported, including the heads-up ones (police, potholes) that never
 * slow a road and so never show up as a cause. Tap one for its road's Why it's slow (Still there /
 * Not there are there), or its pin on the map when it isn't on one of our roads. */

import { useApp } from "@/components/app/AppContext";
import { selectReport, useReports, type DriverReport } from "@/lib/reports";

import { ReportDot } from "./ReportCard";

export default function CausesReports() {
  const app = useApp();
  const { items } = useReports();
  // The cause chips filter the list above: reports aren't one of those causes.
  if (!items.length || app.causeFilter) return null;

  const open = (r: DriverReport) => {
    if (r.segment_id) return app.go({ name: "why", id: r.segment_id });
    app.go({ name: "map" });
    app.focus({ lat: r.lat, lng: r.lng, zoom: 14 });
    setTimeout(() => selectReport(r.id), 400); // after the screen change closes any open card
  };

  return (
    <section aria-labelledby="reports-h" className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between">
          <h2 id="reports-h" className="m-0 text-[17px] font-semibold">
            Reported by drivers
          </h2>
          <span className="font-num text-[12px] text-muted">{items.length}</span>
        </div>
        <span className="text-[13px] text-muted">Crashes, police, hazards, potholes, stalled cars and flooding</span>
      </div>
      {items.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => open(r)}
          className="flex w-full cursor-pointer items-center gap-3.5 rounded-2xl bg-card p-3.5 text-left text-ink hover:bg-card-hi"
        >
          <ReportDot r={r} size={40} />
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-[15px] leading-[1.3] font-semibold">{r.title}</span>
            <span className="truncate text-[13px] text-muted">{r.road ? `${r.road} · ${r.place}` : r.place}</span>
            <span className="text-[12px] text-soft">{r.provenance}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
