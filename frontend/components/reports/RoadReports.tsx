"use client";

/** Why it's slow: what drivers reported on this road, with Still there / Not there. */

import { Card } from "@/components/ui";
import { useReports } from "@/lib/reports";

import ReportCard from "./ReportCard";

export default function RoadReports({ segmentId }: { segmentId: string }) {
  const { items } = useReports();
  const here = items.filter((r) => r.segment_id === segmentId);
  if (!here.length) return null;
  return (
    <Card style={{ gap: 14 }}>
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[17px] font-semibold">Reported by drivers</h2>
        <span className="font-num text-[12px] text-muted">{here.length}</span>
      </div>
      {here.map((r, i) => (
        <div key={r.id} className={i ? "border-t border-line pt-3.5" : ""}>
          <ReportCard r={r} row />
        </div>
      ))}
    </Card>
  );
}
